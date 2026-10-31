import { createHash, randomBytes } from 'node:crypto';
import type {
  ApiErrorBody,
  AuthCollection,
  MfaStatus,
  SignInMethod,
  TotpSetup,
} from '@nextbasejs/client';
import { type Builder, type DB, hash, type Row } from '@nextbasejs/dbx';
import { table } from '../db/system.ts';
import { ApiError } from '../errors.ts';
import { ALPHANUMERIC, randomString } from '../random.ts';
import type { Schema } from '../schema/cache.ts';
import { codeHash, emailSignInCode, sameHash, typedCode } from './codes.ts';
import { recordMatches } from './login.ts';
import type { Mailer } from './mail.ts';
import type { Passkeys } from './passkeys.ts';
import { verifyPassword } from './password.ts';
import { RESET_HOLD } from './password-origins.ts';
import { textSignInCode, textsCodes } from './phone.ts';
import type { SecretKeys } from './secret-keys.ts';
import {
  addSessionMethod,
  rekeySessions,
  type Session,
  sessionKey,
} from './sessions.ts';
import type { Sms } from './sms.ts';
import {
  accountKey,
  clearAttempts,
  countAttempt,
  type Limit,
  mfaKey,
} from './throttle.ts';
import {
  base32,
  matchTotp,
  newRecoveryCodes,
  newTotpSecret,
  normalizeRecoveryCode,
  otpauthUri,
  recoveryCodeHash,
} from './totp.ts';

// A first step that needs a second answers a single-use `mfaId` tied to the record's key.
// Once a record has an authenticator app, only its codes, a recovery code or a passkey count.

/** The method of a session a superuser started to act as the record. */
export const IMPERSONATION: SignInMethod = 'impersonation';

const SUPERUSERS = '_superusers';
const MAX_ATTEMPTS = 5;
const ACCOUNT_LIMIT: Limit = { max: 10, window: '15 minutes' };
/** How long an authenticator app may take to be confirmed once set up. */
const SETUP_WINDOW = '15 minutes';

type CodeChannel = 'email' | 'phone';

/** A sign-in waiting for its second step. */
export interface Pending {
  idHash: string;
  collection: AuthCollection;
  record: Row;
  /** The method of the first step. */
  method: SignInMethod;
}

export interface Challenge {
  mfaId: string;
  methods: SignInMethod[];
  /** Seconds the second step may take. */
  duration: number;
}

/** The 401 of a first step that needs a second one. */
export class MfaRequired extends ApiError {
  readonly challenge: Challenge;

  constructor(challenge: Challenge) {
    super(401, 'This sign-in needs a second step.');
    this.challenge = challenge;
  }

  override toResponse(): Response {
    const body: ApiErrorBody = {
      status: this.status,
      message: this.message,
      data: this.data,
      mfaId: this.challenge.mfaId,
      methods: this.challenge.methods,
    };
    return Response.json(body, {
      status: this.status,
      headers: { 'www-authenticate': 'Bearer' },
    });
  }
}

interface RecordState {
  /** The confirmed authenticator app's encrypted secret. */
  secret: string | null;
  recoveryCodes: number;
  linked: boolean;
  /** Whether the record has a passkey. */
  passkeys: boolean;
  /** How the password was last set; null when chosen. */
  origin: string | null;
  /** Whether that was within the reset hold. */
  recent: boolean;
}

export interface MfaOptions {
  secretKeys: SecretKeys;
  mailer: Mailer;
  sms: Sms;
  /** Shown in authenticator apps, such as the app's host. */
  issuer: string;
  /** Whether OAuth2 providers are set up. */
  oauth2: boolean;
  /** Whether a collection signs in with passkeys. */
  passkeys: Passkeys;
}

export class Mfa {
  readonly #keys: SecretKeys;
  readonly #mailer: Mailer;
  readonly #sms: Sms;
  readonly #issuer: string;
  readonly #oauth2: boolean;
  readonly #passkeys: Passkeys;

  constructor({
    secretKeys,
    mailer,
    sms,
    issuer,
    oauth2,
    passkeys,
  }: MfaOptions) {
    this.#keys = secretKeys;
    this.#mailer = mailer;
    this.#sms = sms;
    this.#issuer = issuer;
    this.#oauth2 = oauth2;
    this.#passkeys = passkeys;
  }

  /**
   * After a first step, and after the authRule allowed the record: a new
   * pending sign-in when the record must take a second step, else undefined.
   */
  async challenge(
    db: DB,
    schema: Schema,
    collection: AuthCollection,
    record: Row,
    method: SignInMethod,
  ): Promise<Challenge | undefined> {
    const { enabled, duration } = collection.mfa;
    if (!enabled) return undefined;
    const id = record.id as string;
    const state = await recordState(db, collection.id, id);
    if (!(await required(db, schema, collection, id, state))) return undefined;
    const methods = this.#methods(collection, record, state, method);
    if (methods.length === 0) {
      throw new ApiError(
        403,
        collection.id === SUPERUSERS
          ? 'Superusers must take a second sign-in step with an authenticator app, and this one has none. Add one with `nextbase superuser mfa-setup`.'
          : 'This account must take a second sign-in step, but has no way to: verify its email or phone, or set up an authenticator app.',
      );
    }
    const mfaId = randomBytes(32).toString('base64url');
    // Expired ones are removed in the same statement.
    await db
      .newQuery(
        `WITH expired AS (
           DELETE FROM {{${table('_mfas')}}} WHERE expires <= now()
         )
         INSERT INTO {{${table('_mfas')}}}
           (id_hash, collection_id, record_id, key_hash, method, expires)
         VALUES ({:idHash}, {:collectionId}, {:recordId}, {:keyHash}, {:method},
                 now() + make_interval(secs => {:duration}))`,
      )
      .bind({
        idHash: idHash(mfaId),
        collectionId: collection.id,
        recordId: id,
        keyHash: sessionKey(collection, record),
        method,
        duration,
      })
      .execute();
    return { mfaId, methods, duration };
  }

  /** The pending sign-in of an `mfaId`, refusing one that ended. */
  async pending(
    db: DB,
    collection: AuthCollection,
    mfaId: unknown,
  ): Promise<Pending> {
    if (typeof mfaId !== 'string' || mfaId === '' || mfaId.length > 128) {
      throw invalidMfa();
    }
    return this.pendingByHash(db, collection, idHash(mfaId));
  }

  async pendingByHash(
    db: DB,
    collection: AuthCollection,
    hashed: string,
  ): Promise<Pending> {
    const [row] = await db
      .newQuery(
        `SELECT record_id AS "recordId", key_hash AS "keyHash", method
         FROM {{${table('_mfas')}}}
         WHERE id_hash = {:idHash} AND collection_id = {:collectionId}
           AND expires > now() AND attempts < ${MAX_ATTEMPTS}`,
      )
      .bind({ idHash: hashed, collectionId: collection.id })
      .all<{ recordId: string; keyHash: string; method: SignInMethod }>();
    if (!row) throw invalidMfa();
    const [record] = await db
      .select()
      .from(table(collection.name))
      .where(hash({ id: row.recordId }))
      .all();
    if (!record || sessionKey(collection, record) !== row.keyHash) {
      throw invalidMfa();
    }
    return { idHash: hashed, collection, record, method: row.method };
  }

  /** Refuses a second step this sign-in cannot take, such as the first one again. */
  async allow(db: DB, pending: Pending, method: SignInMethod): Promise<void> {
    const methods = await this.methodsOf(db, pending);
    if (!methods.includes(method)) {
      throw new ApiError(
        400,
        'This sign-in cannot take its second step this way.',
        {
          mfaId: {
            code: 'validation_mfa_method',
            message: `Use one of: ${methods.join(', ')}.`,
          },
        },
      );
    }
  }

  /** The ways a pending sign-in can take its second step. */
  async methodsOf(db: DB, pending: Pending): Promise<SignInMethod[]> {
    const { collection, record } = pending;
    const state = await recordState(db, collection.id, record.id as string);
    return this.#methods(collection, record, state, pending.method);
  }

  /** Emails a code to the record's verified email, for the second step. */
  async sendEmailCode(db: DB, pending: Pending): Promise<void> {
    await this.allow(db, pending, 'emailCode');
    const { collection, record } = pending;
    const code = await emailSignInCode(
      db,
      this.#mailer,
      collection,
      record.email as string,
    );
    await storeCode(db, pending, 'email', code);
  }

  /** Texts a code to the record's verified phone, for the second step. */
  async sendPhoneCode(db: DB, pending: Pending): Promise<void> {
    await this.allow(db, pending, 'phoneCode');
    const { collection, record } = pending;
    const code = await textSignInCode(
      { db, sms: this.#sms },
      collection,
      record.phone as string,
    );
    await storeCode(db, pending, 'phone', code);
  }

  /**
   * Checks a second step's code. Each guess counts against the `mfaId`,
   * which ends after five wrong ones, and against the account.
   */
  async verifyCode(
    db: DB,
    pending: Pending,
    method: 'totp' | 'recoveryCode' | 'emailCode' | 'phoneCode',
    code: unknown,
  ): Promise<void> {
    await this.allow(db, pending, method);
    const { collection, record } = pending;
    const id = record.id as string;
    const keys = [mfaKey(collection.id, id)];
    await countAttempt(db, keys, ACCOUNT_LIMIT);
    // Counted before the check, so parallel guesses cannot pass the limit.
    const [claimed] = await db
      .newQuery(
        `UPDATE {{${table('_mfas')}}} SET attempts = attempts + 1
         WHERE id_hash = {:idHash} AND expires > now() AND attempts < ${MAX_ATTEMPTS}
         RETURNING attempts, code_hash AS "codeHash", code_channel AS "codeChannel"`,
      )
      .bind({ idHash: pending.idHash })
      .all<{
        attempts: number;
        codeHash: string | null;
        codeChannel: CodeChannel | null;
      }>();
    if (!claimed) throw invalidMfa();
    let valid: boolean;
    switch (method) {
      case 'totp':
        valid = await this.#useTotp(db, collection, id, code);
        break;
      case 'recoveryCode':
        valid = await this.#useRecoveryCode(db, collection, record, code);
        break;
      case 'emailCode':
      case 'phoneCode': {
        const channel: CodeChannel = method === 'emailCode' ? 'email' : 'phone';
        const typed = typedCode(code);
        valid =
          typed !== undefined &&
          claimed.codeChannel === channel &&
          claimed.codeHash !== null &&
          sameHash(
            claimed.codeHash,
            codeHash(`${pending.idHash}:${channel}`, typed),
          );
        break;
      }
      default:
        valid = false;
    }
    if (!valid) {
      const ended = claimed.attempts >= MAX_ATTEMPTS;
      if (ended) await deletePending(db, pending.idHash);
      throw new ApiError(
        400,
        ended
          ? 'The code is invalid. Too many wrong codes: sign in again.'
          : 'The code is invalid or has expired.',
        {
          code: {
            code: 'validation_invalid_code',
            message: 'Invalid or expired.',
          },
        },
      );
    }
    await clearAttempts(db, keys);
  }

  /**
   * Ends the pending sign-in, once, and returns the session's methods. Of
   * parallel requests with one `mfaId`, only the first gets them.
   */
  async finish(
    db: DB,
    pending: Pending,
    method: SignInMethod,
  ): Promise<SignInMethod[]> {
    const deleted = await db
      .newQuery(
        `DELETE FROM {{${table('_mfas')}}}
         WHERE id_hash = {:idHash} AND key_hash = {:keyHash} AND expires > now()
         RETURNING method`,
      )
      .bind({
        idHash: pending.idHash,
        keyHash: sessionKey(pending.collection, pending.record),
      })
      .column();
    if (deleted.length === 0) throw invalidMfa();
    return [pending.method, method];
  }

  async status(
    db: DB,
    collection: AuthCollection,
    recordId: string,
  ): Promise<MfaStatus> {
    const state = await recordState(db, collection.id, recordId);
    return {
      totp: state.secret !== null,
      recoveryCodesLeft: state.secret === null ? 0 : state.recoveryCodes,
    };
  }

  /**
   * Sets up an unconfirmed app. Needs the password, so a stolen session cannot lock
   * the owner out, and a verified email or phone to recover the account with.
   */
  async startTotp(
    db: DB,
    collection: AuthCollection,
    record: Row,
    password: unknown,
  ): Promise<TotpSetup> {
    this.#checkEnrollable(collection);
    await checkPassword(db, collection, record, password);
    return this.startTotpTrusted(db, collection, record);
  }

  /**
   * `startTotp` without the password, for trusted server code such as the
   * CLI, whose user can reach the database already.
   */
  async startTotpTrusted(
    db: DB,
    collection: AuthCollection,
    record: Row,
  ): Promise<TotpSetup> {
    this.#checkEnrollable(collection);
    const id = record.id as string;
    const verified =
      record.emailVerified === true ||
      (record.phoneVerified === true && Boolean(record.phone));
    if (!verified) {
      throw new ApiError(
        400,
        'Verify your email or phone before you set up an authenticator app.',
        {
          totp: {
            code: 'validation_not_verified',
            message: 'Needs a verified email or phone.',
          },
        },
      );
    }
    const state = await recordState(db, collection.id, id);
    if (state.secret !== null) throw alreadySetUp();
    const secret = newTotpSecret();
    const stored = this.#keys.encrypt(secret, aad(collection.id, id));
    const written = await db
      .newQuery(
        `WITH stale AS (
           DELETE FROM {{${table('_totp')}}}
           WHERE confirmed IS NULL AND created <= now() - interval '${SETUP_WINDOW}'
             AND NOT (collection_id = {:collectionId} AND record_id = {:recordId})
         )
         INSERT INTO {{${table('_totp')}}} AS t
           (collection_id, record_id, secret, last_step, confirmed, created)
         VALUES ({:collectionId}, {:recordId}, {:secret}, 0, NULL, now())
         ON CONFLICT (collection_id, record_id) DO UPDATE SET
           secret = EXCLUDED.secret, last_step = 0, created = now()
         WHERE t.confirmed IS NULL
         RETURNING 1`,
      )
      .bind({ collectionId: collection.id, recordId: id, secret: stored })
      .column();
    if (written.length === 0) throw alreadySetUp();
    const account = (record.email as string) || (record.phone as string) || id;
    return {
      secret: base32(secret),
      uri: otpauthUri(secret, this.#issuer, account),
    };
  }

  /**
   * Confirms the app with a code from it and returns new recovery codes. A new
   * token key signs out every session but `session`.
   */
  async confirmTotp(
    db: DB,
    collection: AuthCollection,
    record: Row,
    session: Session | undefined,
    code: unknown,
  ): Promise<string[]> {
    this.#checkEnrollable(collection);
    const id = record.id as string;
    const keys = [mfaKey(collection.id, id)];
    await countAttempt(db, keys, ACCOUNT_LIMIT);
    const [setup] = await db
      .newQuery(
        `SELECT secret FROM {{${table('_totp')}}}
         WHERE collection_id = {:collectionId} AND record_id = {:recordId}
           AND confirmed IS NULL AND created > now() - interval '${SETUP_WINDOW}'`,
      )
      .bind({ collectionId: collection.id, recordId: id })
      .column<string>();
    if (setup === undefined) {
      throw new ApiError(
        400,
        'Set up the authenticator app again: its setup was not started or has expired.',
      );
    }
    const secret = this.#keys.decrypt(setup, aad(collection.id, id));
    const typed = typedCode(code);
    const step =
      secret && typed !== undefined
        ? matchTotp(secret, typed, Date.now())
        : undefined;
    if (step === undefined) throw invalidCode('code');
    const codes = newRecoveryCodes();
    const tokenKey = randomString(50, ALPHANUMERIC);
    await db.transaction(async (tx) => {
      const confirmed = await tx
        .newQuery(
          `UPDATE {{${table('_totp')}}} SET confirmed = now(), last_step = {:step}
           WHERE collection_id = {:collectionId} AND record_id = {:recordId}
             AND secret = {:secret} AND confirmed IS NULL AND last_step < {:step}`,
        )
        .bind({
          collectionId: collection.id,
          recordId: id,
          secret: setup,
          step,
        })
        .execute();
      if (confirmed.rowsAffected === 0) throw invalidCode('code');
      await replaceRecoveryCodes(tx, collection.id, id, codes);
      await tx
        .update(table(collection.name), { tokenKey }, hash({ id }))
        .execute();
      await rekeySessions(tx, collection, { id, tokenKey }, session?.id);
      if (session) await addSessionMethod(tx, session.id, 'totp');
      // Sign-ins started before now could finish without the app.
      await deleteFor(tx, '_mfas', collection.id, id);
    });
    await clearAttempts(db, keys);
    if (record.email) {
      this.#mailer.send('totpEnabled', collection.name, record.email as string);
    }
    return codes;
  }

  /** Removes the app and its recovery codes, with a code from either. */
  async removeTotp(
    db: DB,
    collection: AuthCollection,
    record: Row,
    code: unknown,
  ): Promise<void> {
    const id = record.id as string;
    await this.#requireApp(db, collection, id);
    await this.stepUp(db, collection, record, code, { always: true });
    await db.transaction(async (tx) => {
      await deleteFor(tx, '_totp', collection.id, id);
      await deleteFor(tx, '_recovery_codes', collection.id, id);
    });
    if (record.email) {
      this.#mailer.send(
        'totpDisabled',
        collection.name,
        record.email as string,
      );
    }
  }

  /** Replaces the recovery codes, with a code from the app or an old one. */
  async regenerateRecoveryCodes(
    db: DB,
    collection: AuthCollection,
    record: Row,
    code: unknown,
  ): Promise<string[]> {
    const id = record.id as string;
    await this.#requireApp(db, collection, id);
    await this.stepUp(db, collection, record, code, { always: true });
    const codes = newRecoveryCodes();
    await db.transaction((tx) =>
      replaceRecoveryCodes(tx, collection.id, id, codes),
    );
    return codes;
  }

  /**
   * For a sensitive change: an app or recovery code in `mfaCode`. Does nothing without
   * an app or while MFA is off, unless `always`, as for changes to the app itself.
   */
  async stepUp(
    db: DB,
    collection: AuthCollection,
    record: Row,
    code: unknown,
    { always = false }: { always?: boolean } = {},
  ): Promise<void> {
    if (!always && !collection.mfa.enabled) return;
    const field = 'mfaCode';
    const id = record.id as string;
    const state = await recordState(db, collection.id, id);
    if (state.secret === null) return;
    if (typeof code !== 'string' || code.trim() === '') {
      throw new ApiError(
        400,
        'Enter a code from your authenticator app, or a recovery code.',
        { [field]: { code: 'validation_required', message: 'Required.' } },
      );
    }
    const keys = [mfaKey(collection.id, id)];
    await countAttempt(db, keys, ACCOUNT_LIMIT);
    const valid =
      typedCode(code) !== undefined
        ? await this.#useTotp(db, collection, id, code)
        : await this.#useRecoveryCode(db, collection, record, code);
    if (!valid) throw invalidCode(field);
    await clearAttempts(db, keys);
  }

  /**
   * The password and any app code, for a change that adds a way into the account,
   * such as a new phone or provider: a stolen session alone cannot make one.
   */
  async reauthenticate(
    db: DB,
    collection: AuthCollection,
    record: Row,
    input: Record<string, unknown>,
  ): Promise<void> {
    await checkPassword(db, collection, record, input.password);
    await this.stepUp(db, collection, record, input.mfaCode);
  }

  /**
   * Removes another record's app, recovery codes and pending sign-ins, for
   * a superuser, and tells the owner.
   */
  async clear(db: DB, collection: AuthCollection, record: Row): Promise<void> {
    await resetMfa(db, collection.id, record.id as string);
    if (record.email) {
      this.#mailer.send('mfaCleared', collection.name, record.email as string);
    }
  }

  /**
   * After a password reset by email or text: tells an owner who signs in
   * in two steps that codes to that channel do not count for a while.
   */
  async resetNotice(
    db: DB,
    schema: Schema,
    collection: AuthCollection,
    record: Row,
    channel: 'email' | 'phone',
  ): Promise<void> {
    if (!collection.mfa.enabled || !record.email) return;
    const id = record.id as string;
    const state = await recordState(db, collection.id, id);
    if (!(await required(db, schema, collection, id, state))) return;
    this.#mailer.send(
      'mfaCodesPaused',
      collection.name,
      record.email as string,
      {
        channel,
      },
    );
  }

  /**
   * The ways `record` can take the step after `first`. A password reset through a
   * channel in the last day does not pair with a code sent there.
   */
  #methods(
    collection: AuthCollection,
    record: Row,
    state: RecordState,
    first: SignInMethod,
  ): SignInMethod[] {
    let methods: SignInMethod[];
    const passkey = state.passkeys && this.#passkeys.enabled(collection);
    if (state.secret !== null) {
      methods = state.recoveryCodes > 0 ? ['totp', 'recoveryCode'] : ['totp'];
      // A passkey is as strong as the app's codes.
      if (passkey) methods.push('passkey');
    } else if (collection.id === SUPERUSERS) {
      methods = [];
    } else {
      methods = [];
      if (state.origin !== 'random') methods.push('password');
      if (record.emailVerified === true && record.email) {
        methods.push('emailCode');
      }
      if (textsCodes(collection, record)) methods.push('phoneCode');
      if (this.#oauth2 && state.linked) methods.push('oauth2');
      if (passkey) methods.push('passkey');
    }
    const held = (channel: SignInMethod): boolean =>
      state.recent &&
      ((state.origin === 'emailReset' && channel === 'emailCode') ||
        (state.origin === 'phoneReset' && channel === 'phoneCode'));
    return methods.filter(
      (m) =>
        m !== first &&
        !(first === 'password' && held(m)) &&
        !(m === 'password' && held(first)),
    );
  }

  #checkEnrollable(collection: AuthCollection): void {
    if (!collection.mfa.enabled) {
      throw new ApiError(
        400,
        'Multi-factor sign-in is not enabled for this collection.',
      );
    }
    if (!this.#keys.configured) {
      throw new ApiError(
        400,
        'Authenticator apps need a secret key to encrypt their secrets: pass the secretKey option to new NextBase(), or set NEXTBASE_SECRET_KEY.',
        {
          secretKey: {
            code: 'secret_key_not_configured',
            message: 'Not set up.',
          },
        },
      );
    }
  }

  async #requireApp(
    db: DB,
    collection: AuthCollection,
    id: string,
  ): Promise<void> {
    const state = await recordState(db, collection.id, id);
    if (state.secret === null) {
      throw new ApiError(400, 'No authenticator app is set up.');
    }
  }

  // A step is stored only if later than the last one used, in one statement, so
  // parallel requests with one code cannot both pass.
  async #useTotp(
    db: Builder,
    collection: AuthCollection,
    id: string,
    code: unknown,
  ): Promise<boolean> {
    const typed = typedCode(code);
    if (typed === undefined) return false;
    const [stored] = await db
      .newQuery(
        `SELECT secret FROM {{${table('_totp')}}}
         WHERE collection_id = {:collectionId} AND record_id = {:recordId}
           AND confirmed IS NOT NULL`,
      )
      .bind({ collectionId: collection.id, recordId: id })
      .column<string>();
    if (stored === undefined) return false;
    const secret = this.#keys.decrypt(stored, aad(collection.id, id));
    if (!secret) return false;
    const step = matchTotp(secret, typed, Date.now());
    if (step === undefined) return false;
    const used = await db
      .newQuery(
        `UPDATE {{${table('_totp')}}} SET last_step = {:step}
         WHERE collection_id = {:collectionId} AND record_id = {:recordId}
           AND confirmed IS NOT NULL AND last_step < {:step}`,
      )
      .bind({ collectionId: collection.id, recordId: id, step })
      .execute();
    return used.rowsAffected > 0;
  }

  // Spent by deleting it, so each is used once.
  async #useRecoveryCode(
    db: Builder,
    collection: AuthCollection,
    record: Row,
    code: unknown,
  ): Promise<boolean> {
    const normalized =
      typeof code === 'string' ? normalizeRecoveryCode(code) : undefined;
    if (normalized === undefined) return false;
    const id = record.id as string;
    const spent = await db
      .newQuery(
        `DELETE FROM {{${table('_recovery_codes')}}}
         WHERE collection_id = {:collectionId} AND record_id = {:recordId}
           AND code_hash = {:codeHash}
         RETURNING 1`,
      )
      .bind({
        collectionId: collection.id,
        recordId: id,
        codeHash: recoveryCodeHash(collection.id, id, normalized),
      })
      .column();
    if (spent.length === 0) return false;
    if (record.email) {
      const [remaining] = await db
        .newQuery(
          `SELECT count(*)::int FROM {{${table('_recovery_codes')}}}
           WHERE collection_id = {:collectionId} AND record_id = {:recordId}`,
        )
        .bind({ collectionId: collection.id, recordId: id })
        .column<number>();
      this.#mailer.send(
        'recoveryCodeUsed',
        collection.name,
        record.email as string,
        { remaining: remaining ?? 0 },
      );
    }
    return true;
  }
}

/** Whether the record has a confirmed authenticator app. */
export async function hasAuthenticator(
  q: Builder,
  collectionId: string,
  recordId: string,
): Promise<boolean> {
  const rows = await q
    .newQuery(
      `SELECT 1 FROM {{${table('_totp')}}}
       WHERE collection_id = {:collectionId} AND record_id = {:recordId}
         AND confirmed IS NOT NULL`,
    )
    .bind({ collectionId, recordId })
    .column();
  return rows.length > 0;
}

/**
 * Removes a record's authenticator app, recovery codes and pending
 * sign-ins, for a superuser who lost their app. Returns whether it had an app.
 */
export async function resetMfa(
  db: DB,
  collectionId: string,
  recordId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const had = await hasAuthenticator(tx, collectionId, recordId);
    for (const name of ['_totp', '_recovery_codes', '_mfas']) {
      await deleteFor(tx, name, collectionId, recordId);
    }
    return had;
  });
}

async function recordState(
  q: Builder,
  collectionId: string,
  recordId: string,
): Promise<RecordState> {
  const [state] = await q
    .newQuery(
      `SELECT
         (SELECT secret FROM {{${table('_totp')}}}
          WHERE collection_id = {:collectionId} AND record_id = {:recordId}
            AND confirmed IS NOT NULL) AS secret,
         (SELECT count(*)::int FROM {{${table('_recovery_codes')}}}
          WHERE collection_id = {:collectionId} AND record_id = {:recordId}) AS "recoveryCodes",
         EXISTS (SELECT 1 FROM {{${table('_linked_accounts')}}}
          WHERE collection_id = {:collectionId} AND record_id = {:recordId}) AS linked,
         EXISTS (SELECT 1 FROM {{${table('_passkeys')}}}
          WHERE collection_id = {:collectionId} AND record_id = {:recordId}) AS passkeys,
         p.origin, coalesce(p.set_at > now() - interval '${RESET_HOLD}', false) AS recent
       FROM (SELECT 1) AS one
       LEFT JOIN {{${table('_password_origins')}}} p
         ON p.collection_id = {:collectionId} AND p.record_id = {:recordId}`,
    )
    .bind({ collectionId, recordId })
    .all<RecordState>();
  return state as RecordState;
}

/** The current password, counted against the account like a sign-in. */
export async function checkPassword(
  db: DB,
  collection: AuthCollection,
  record: Row,
  password: unknown,
): Promise<void> {
  if (password === undefined || password === '') {
    throw new ApiError(400, 'Enter your current password to do this.', {
      password: { code: 'validation_required', message: 'Required.' },
    });
  }
  const keys = [accountKey(collection.id, record.id as string)];
  await countAttempt(db, keys);
  const ok =
    typeof password === 'string' &&
    password.length <= 1024 &&
    (await verifyPassword(password, record.password as string));
  if (!ok) {
    throw new ApiError(400, 'The password is not the current one.', {
      password: {
        code: 'validation_invalid_password',
        message: 'Does not match the current password.',
      },
    });
  }
  await clearAttempts(db, keys);
}

/** Within this, a session counts as recent enough to stand in for the password. */
const RECENT_SIGN_IN_MS = 24 * 60 * 60 * 1000;

/**
 * For a sensitive change: the current password, or a session signed in within the last
 * day, so a long-stolen session alone cannot make it. `doing` ends the message.
 */
export async function checkRecentOrPassword(
  db: DB,
  collection: AuthCollection,
  record: Row,
  session: Pick<Session, 'created'> | undefined,
  password: unknown,
  doing: string,
): Promise<void> {
  if (password !== undefined) {
    await checkPassword(db, collection, record, password);
    return;
  }
  const created = session?.created.getTime() ?? 0;
  if (Date.now() - created > RECENT_SIGN_IN_MS) {
    throw new ApiError(
      400,
      `Enter your current password, or sign in again, to ${doing}.`,
      { password: { code: 'validation_required', message: 'Required.' } },
    );
  }
}

/** Whether a sign-in to the record must take a second step. */
export async function takesSecondStep(
  db: DB,
  schema: Schema,
  collection: AuthCollection,
  id: string,
): Promise<boolean> {
  if (!collection.mfa.enabled) return false;
  const state = await recordState(db, collection.id, id);
  return required(db, schema, collection, id, state);
}

/** Whether the record must take a second step: it has an app, or the rule says so. */
async function required(
  db: DB,
  schema: Schema,
  collection: AuthCollection,
  id: string,
  state: RecordState,
): Promise<boolean> {
  const { rule } = collection.mfa;
  return (
    state.secret !== null ||
    rule === '' ||
    (rule !== null && (await recordMatches(db, schema, collection, rule, id)))
  );
}

async function storeCode(
  db: DB,
  pending: Pending,
  channel: CodeChannel,
  code: string,
): Promise<void> {
  const stored = await db
    .newQuery(
      `UPDATE {{${table('_mfas')}}}
       SET code_hash = {:codeHash}, code_channel = {:channel}
       WHERE id_hash = {:idHash} AND expires > now()`,
    )
    .bind({
      idHash: pending.idHash,
      channel,
      codeHash: codeHash(`${pending.idHash}:${channel}`, code),
    })
    .execute();
  if (stored.rowsAffected === 0) throw invalidMfa();
}

async function replaceRecoveryCodes(
  q: Builder,
  collectionId: string,
  recordId: string,
  codes: readonly string[],
): Promise<void> {
  await deleteFor(q, '_recovery_codes', collectionId, recordId);
  await q
    .newQuery(
      `INSERT INTO {{${table('_recovery_codes')}}} (collection_id, record_id, code_hash)
       SELECT {:collectionId}, {:recordId}, unnest({:hashes}::text[])`,
    )
    .bind({
      collectionId,
      recordId,
      hashes: codes.map((code) =>
        recoveryCodeHash(
          collectionId,
          recordId,
          normalizeRecoveryCode(code) as string,
        ),
      ),
    })
    .execute();
}

async function deleteFor(
  q: Builder,
  name: string,
  collectionId: string,
  recordId: string,
): Promise<void> {
  await q
    .newQuery(
      `DELETE FROM {{${table(name)}}}
       WHERE collection_id = {:collectionId} AND record_id = {:recordId}`,
    )
    .bind({ collectionId, recordId })
    .execute();
}

async function deletePending(q: Builder, hashed: string): Promise<void> {
  await q
    .newQuery(`DELETE FROM {{${table('_mfas')}}} WHERE id_hash = {:idHash}`)
    .bind({ idHash: hashed })
    .execute();
}

// Stored hashed, so a database leak hands out no pending sign-ins.
function idHash(mfaId: string): string {
  return createHash('sha256').update(mfaId).digest('hex');
}

/** The data a TOTP secret is encrypted with, so it opens only on its own row. */
function aad(collectionId: string, recordId: string): string {
  return `${collectionId}:${recordId}`;
}

export function invalidMfa(): ApiError {
  return new ApiError(
    400,
    'The sign-in has expired or is invalid. Sign in again.',
    {
      mfaId: {
        code: 'validation_invalid_mfa',
        message: 'Invalid or expired.',
      },
    },
  );
}

function invalidCode(field: string): ApiError {
  return new ApiError(400, 'The code is invalid or has expired.', {
    [field]: {
      code: 'validation_invalid_code',
      message: 'Invalid or expired.',
    },
  });
}

function alreadySetUp(): ApiError {
  return new ApiError(
    400,
    'An authenticator app is already set up. Remove it first to set up another.',
  );
}
