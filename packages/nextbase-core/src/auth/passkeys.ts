import { createHash, randomBytes } from 'node:crypto';
import type { AuthCollection, PasskeyModel } from '@nextbasejs/client';
import { type DB, hash, type Row } from '@nextbasejs/dbx';
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { table } from '../db/system.ts';
import { ApiError } from '../errors.ts';
import { newId } from '../random.ts';
import type { Mailer } from './mail.ts';
import type { Session } from './sessions.ts';

// WebAuthn through SimpleWebAuthn: the challenge is kept server-side and works once,
// and the passkey is bound to `appUrl`, whose host is the RP ID.

const SUPERUSERS = '_superusers';
/** How long the browser's dialog, and so its challenge, may take. */
const CHALLENGE_SECONDS = 300;
const MAX_NAME = 100;

type Purpose = 'register' | 'sign-in';

export interface PasskeyOptions<T> {
  /** Pass it back with the browser's response. */
  challengeId: string;
  /** For `navigator.credentials`, as JSON. */
  options: T;
}

/** A passkey sign-in the browser's response proved. */
export interface PasskeySignIn {
  record: Row;
  /** The authenticator checked the user, such as by fingerprint or PIN. */
  userVerified: boolean;
}

interface PasskeyRow {
  id: string;
  recordId: string;
  credentialId: string;
  publicKey: Uint8Array;
  counter: string;
  transports: string[];
}

export class Passkeys {
  readonly #appUrl: URL | undefined;
  readonly #mailer: Mailer;

  constructor(appUrl: URL | undefined, mailer: Mailer) {
    this.#appUrl = appUrl;
    this.#mailer = mailer;
  }

  /** Whether the collection signs in with passkeys; an authRule of `null` turns sign-in off. */
  enabled(collection: AuthCollection): boolean {
    return (
      this.#appUrl !== undefined &&
      collection.passkeySignIn &&
      collection.authRule !== null &&
      collection.id !== SUPERUSERS
    );
  }

  /** Options to create a passkey for `record`, bound to its `session`. */
  async registrationOptions(
    db: DB,
    collection: AuthCollection,
    record: Row,
    session: Session,
  ): Promise<PasskeyOptions<PublicKeyCredentialCreationOptionsJSON>> {
    const appUrl = this.#check(collection);
    const id = record.id as string;
    const account = (record.email as string) || (record.phone as string) || id;
    const options = await generateRegistrationOptions({
      rpName: appUrl.hostname,
      rpID: appUrl.hostname,
      userName: account,
      userDisplayName:
        typeof record.name === 'string' && record.name !== ''
          ? record.name
          : account,
      // The record's id, so a device replaces its older passkey for the account.
      userID: new TextEncoder().encode(id),
      attestationType: 'none',
      excludeCredentials: (await this.#rows(db, collection.id, id)).map(
        (row) => ({ id: row.credentialId, transports: row.transports }),
      ),
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'preferred',
      },
      timeout: CHALLENGE_SECONDS * 1000,
    });
    const challengeId = await this.#storeChallenge(db, collection, 'register', {
      challenge: options.challenge,
      recordId: id,
      sessionId: session.id,
    });
    return { challengeId, options };
  }

  /** Verifies the browser's new passkey and keeps it. Tells the owner. */
  async add(
    db: DB,
    collection: AuthCollection,
    record: Row,
    session: Session,
    input: Record<string, unknown>,
  ): Promise<PasskeyModel> {
    const appUrl = this.#check(collection);
    const id = record.id as string;
    const name = passkeyName(input.name);
    const challenge = await this.#takeChallenge(
      db,
      collection,
      'register',
      input.challengeId,
    );
    // Started by another account or device, it adds nothing here.
    if (challenge.recordId !== id || challenge.sessionId !== session.id) {
      throw expired();
    }
    const response = credentialInput<RegistrationResponseJSON>(input);
    const verification = await verified(() =>
      verifyRegistrationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: appUrl.origin,
        expectedRPID: appUrl.hostname,
        requireUserVerification: false,
      }),
    );
    if (!verification.verified) throw refused();
    const { credential, credentialDeviceType, credentialBackedUp, aaguid } =
      verification.registrationInfo;
    const [row] = await db
      .newQuery(
        `INSERT INTO {{${table('_passkeys')}}}
           (id, collection_id, record_id, credential_id, public_key, counter,
            transports, device_type, backed_up, aaguid, name)
         VALUES ({:id}, {:collectionId}, {:recordId}, {:credentialId}, {:publicKey},
                 {:counter}, {:transports}, {:deviceType}, {:backedUp}, {:aaguid}, {:name})
         ON CONFLICT (credential_id) DO NOTHING
         RETURNING ${COLUMNS}`,
      )
      .bind({
        id: newId(),
        collectionId: collection.id,
        recordId: id,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports ?? [],
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        aaguid,
        name,
      })
      .all<ModelRow>();
    if (!row) {
      throw new ApiError(400, 'This passkey is already added.', {
        credential: {
          code: 'passkey_exists',
          message: 'Already added.',
        },
      });
    }
    if (record.email) {
      this.#mailer.send(
        'passkeyAdded',
        collection.name,
        record.email as string,
      );
    }
    return model(row);
  }

  /**
   * Options to sign in. Without `record`, any passkey of the collection may answer,
   * as the device lists them; with it, for a second step, only that record's.
   */
  async signInOptions(
    db: DB,
    collection: AuthCollection,
    record?: Row,
  ): Promise<PasskeyOptions<PublicKeyCredentialRequestOptionsJSON>> {
    const appUrl = this.#check(collection);
    const allowed =
      record === undefined
        ? undefined
        : (await this.#rows(db, collection.id, record.id as string)).map(
            (row) => ({ id: row.credentialId, transports: row.transports }),
          );
    const options = await generateAuthenticationOptions({
      rpID: appUrl.hostname,
      userVerification: 'preferred',
      timeout: CHALLENGE_SECONDS * 1000,
      ...(allowed && { allowCredentials: allowed }),
    });
    const challengeId = await this.#storeChallenge(db, collection, 'sign-in', {
      challenge: options.challenge,
      recordId: null,
      sessionId: null,
    });
    return { challengeId, options };
  }

  /** The record a passkey's response proves. The challenge works once, either way. */
  async verifySignIn(
    db: DB,
    collection: AuthCollection,
    input: Record<string, unknown>,
  ): Promise<PasskeySignIn> {
    const appUrl = this.#check(collection);
    const challenge = await this.#takeChallenge(
      db,
      collection,
      'sign-in',
      input.challengeId,
    );
    const response = credentialInput<AuthenticationResponseJSON>(input);
    const [passkey] = await db
      .newQuery(
        `SELECT id, record_id AS "recordId", credential_id AS "credentialId",
           public_key AS "publicKey", counter, transports
         FROM {{${table('_passkeys')}}}
         WHERE credential_id = {:credentialId} AND collection_id = {:collectionId}`,
      )
      .bind({ credentialId: response.id, collectionId: collection.id })
      .all<PasskeyRow>();
    if (!passkey) throw unknownPasskey();
    const verification = await verified(() =>
      verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: appUrl.origin,
        expectedRPID: appUrl.hostname,
        credential: {
          id: passkey.credentialId,
          publicKey: new Uint8Array(passkey.publicKey),
          counter: Number(passkey.counter),
          transports: passkey.transports,
        },
        requireUserVerification: false,
      }),
    );
    if (!verification.verified) throw refused();
    const { newCounter, userVerified } = verification.authenticationInfo;
    await db
      .newQuery(
        `UPDATE {{${table('_passkeys')}}}
         SET counter = greatest(counter, {:counter}), last_used = now()
         WHERE id = {:id}`,
      )
      .bind({ id: passkey.id, counter: newCounter })
      .execute();
    const [record] = await db
      .select()
      .from(table(collection.name))
      .where(hash({ id: passkey.recordId }))
      .all();
    if (!record) throw unknownPasskey();
    return { record, userVerified };
  }

  async list(
    db: DB,
    collection: AuthCollection,
    recordId: string,
  ): Promise<PasskeyModel[]> {
    const rows = await db
      .newQuery(
        `SELECT ${COLUMNS} FROM {{${table('_passkeys')}}}
         WHERE collection_id = {:collectionId} AND record_id = {:recordId}
         ORDER BY created, id`,
      )
      .bind({ collectionId: collection.id, recordId })
      .all<ModelRow>();
    return rows.map(model);
  }

  async rename(
    db: DB,
    collection: AuthCollection,
    recordId: string,
    id: string,
    name: unknown,
  ): Promise<PasskeyModel> {
    const [row] = await db
      .newQuery(
        `UPDATE {{${table('_passkeys')}}} SET name = {:name}
         WHERE id = {:id} AND collection_id = {:collectionId} AND record_id = {:recordId}
         RETURNING ${COLUMNS}`,
      )
      .bind({
        id,
        collectionId: collection.id,
        recordId,
        name: passkeyName(name),
      })
      .all<ModelRow>();
    if (!row) throw notFound();
    return model(row);
  }

  /** Removes a passkey and tells the owner. */
  async remove(
    db: DB,
    collection: AuthCollection,
    record: Row,
    id: string,
  ): Promise<void> {
    const deleted = await db
      .newQuery(
        `DELETE FROM {{${table('_passkeys')}}}
         WHERE id = {:id} AND collection_id = {:collectionId} AND record_id = {:recordId}
         RETURNING 1`,
      )
      .bind({ id, collectionId: collection.id, recordId: record.id })
      .column();
    if (deleted.length === 0) throw notFound();
    if (record.email) {
      this.#mailer.send(
        'passkeyRemoved',
        collection.name,
        record.email as string,
      );
    }
  }

  /** The app's URL, once the collection may use passkeys. */
  #check(collection: AuthCollection): URL {
    if (!this.enabled(collection) || this.#appUrl === undefined) {
      throw new ApiError(
        400,
        this.#appUrl === undefined
          ? 'Passkeys need the appUrl option, the site they are bound to.'
          : 'Sign-in with passkeys is not turned on.',
      );
    }
    return this.#appUrl;
  }

  async #rows(
    db: DB,
    collectionId: string,
    recordId: string,
  ): Promise<{ credentialId: string; transports: string[] }[]> {
    return db
      .newQuery(
        `SELECT credential_id AS "credentialId", transports
         FROM {{${table('_passkeys')}}}
         WHERE collection_id = {:collectionId} AND record_id = {:recordId}
         ORDER BY created, id`,
      )
      .bind({ collectionId, recordId })
      .all<{ credentialId: string; transports: string[] }>();
  }

  async #storeChallenge(
    db: DB,
    collection: AuthCollection,
    purpose: Purpose,
    {
      challenge,
      recordId,
      sessionId,
    }: {
      challenge: string;
      recordId: string | null;
      sessionId: string | null;
    },
  ): Promise<string> {
    const challengeId = randomBytes(24).toString('base64url');
    await db
      .newQuery(
        `WITH expired AS (
           DELETE FROM {{${table('_webauthn_challenges')}}} WHERE expires <= now()
         )
         INSERT INTO {{${table('_webauthn_challenges')}}}
           (id_hash, collection_id, purpose, record_id, session_id, challenge, expires)
         VALUES ({:idHash}, {:collectionId}, {:purpose}, {:recordId}, {:sessionId},
                 {:challenge}, now() + make_interval(secs => {:seconds}))`,
      )
      .bind({
        idHash: challengeHash(challengeId),
        collectionId: collection.id,
        purpose,
        recordId,
        sessionId,
        challenge,
        seconds: CHALLENGE_SECONDS,
      })
      .execute();
    return challengeId;
  }

  async #takeChallenge(
    db: DB,
    collection: AuthCollection,
    purpose: Purpose,
    challengeId: unknown,
  ): Promise<{
    challenge: string;
    recordId: string | null;
    sessionId: string | null;
  }> {
    if (
      typeof challengeId !== 'string' ||
      challengeId === '' ||
      challengeId.length > 64
    ) {
      throw expired();
    }
    const [row] = await db
      .newQuery(
        `DELETE FROM {{${table('_webauthn_challenges')}}}
         WHERE id_hash = {:idHash} AND collection_id = {:collectionId}
           AND purpose = {:purpose} AND expires > now()
         RETURNING challenge, record_id AS "recordId", session_id AS "sessionId"`,
      )
      .bind({
        idHash: challengeHash(challengeId),
        collectionId: collection.id,
        purpose,
      })
      .all<{
        challenge: string;
        recordId: string | null;
        sessionId: string | null;
      }>();
    if (!row) throw expired();
    return row;
  }
}

const COLUMNS = `id, name, aaguid, backed_up AS "backedUp", created, last_used AS "lastUsed"`;

interface ModelRow {
  id: string;
  name: string;
  aaguid: string;
  backedUp: boolean;
  created: Date;
  lastUsed: Date | null;
}

function model(row: ModelRow): PasskeyModel {
  return {
    id: row.id,
    name: row.name,
    aaguid: row.aaguid,
    backedUp: row.backedUp,
    created: row.created.toISOString(),
    lastUsed: row.lastUsed?.toISOString() ?? '',
  };
}

// Stored hashed, so a database leak hands out no challenges.
function challengeHash(challengeId: string): string {
  return createHash('sha256').update(challengeId).digest('hex');
}

function passkeyName(name: unknown): string {
  if (name === undefined || name === null) return '';
  if (typeof name !== 'string' || name.trim().length > MAX_NAME) {
    throw new ApiError(400, 'Failed to save the passkey.', {
      name: {
        code: 'validation_invalid_name',
        message: `Must be text of at most ${MAX_NAME} characters.`,
      },
    });
  }
  return name.trim();
}

/** The browser's response, as `credential.toJSON()` gives it. */
function credentialInput<T>(input: Record<string, unknown>): T {
  const { credential } = input;
  if (
    credential === null ||
    typeof credential !== 'object' ||
    Array.isArray(credential) ||
    typeof (credential as { id?: unknown }).id !== 'string' ||
    typeof (credential as { response?: unknown }).response !== 'object'
  ) {
    throw new ApiError(400, 'The passkey response is missing or malformed.', {
      credential: { code: 'validation_required', message: 'Required.' },
    });
  }
  return credential as T;
}

/** A response the library cannot verify, for any reason, is refused alike. */
async function verified<T>(verify: () => Promise<T>): Promise<T> {
  try {
    return await verify();
  } catch {
    throw refused();
  }
}

function refused(): ApiError {
  return new ApiError(400, 'The passkey could not be verified.', {
    credential: {
      code: 'passkey_invalid',
      message: 'Could not be verified.',
    },
  });
}

/** The client tells the browser to forget a passkey answered with this. */
function unknownPasskey(): ApiError {
  return new ApiError(400, 'This passkey is not known here.', {
    credential: {
      code: 'passkey_not_found',
      message: 'Unknown passkey.',
    },
  });
}

function expired(): ApiError {
  return new ApiError(400, 'The passkey request expired. Try again.', {
    challengeId: {
      code: 'validation_invalid_challenge',
      message: 'Invalid or expired.',
    },
  });
}

function notFound(): ApiError {
  return new ApiError(404, 'Passkey not found.');
}
