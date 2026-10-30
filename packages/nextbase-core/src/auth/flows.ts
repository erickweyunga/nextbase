import { createHash } from 'node:crypto';
import type { AuthCollection, TokenType } from '@nextbasejs/client';
import { type DB, hash, type Row } from '@nextbasejs/dbx';
import { table } from '../db/system.ts';
import type { Effects } from '../effects.ts';
import { ApiError } from '../errors.ts';
import { newId } from '../random.ts';
import type { Hooks } from '../records/hooks.ts';
import {
  planDeleteRecord,
  planUpdateRecord,
  systemContext,
} from '../records/service.ts';
import { EMAIL_PATTERN } from '../records/values.ts';
import type { Schema } from '../schema/cache.ts';
import { unstorableText } from '../storable.ts';
import { findByEmail } from './identity.ts';
import { unlinkUnproven } from './linked-accounts.ts';
import type { Mailer } from './mail.ts';
import type { Mfa } from './mfa.ts';
import { verifyPassword } from './password.ts';
import type { PasswordOrigin } from './password-origins.ts';
import { type Principal, recordIn } from './principal.ts';
import {
  accountKey,
  clearAttempts,
  countAttempt,
  identityKey,
  mailKey,
} from './throttle.ts';
import { peekToken, signToken, verifyToken } from './tokens.ts';

// Email verification, password reset, email change and account deletion.
// - Answers and timing are the same whether or not the account exists.
// - Tokens are bound to the record's tokenKey; rotating it on reset or email
//   change makes each token single-use and ends every session.
// - Links come from the configured app URL, never the Host header.

export interface FlowContext {
  db: DB;
  schema: Schema;
  mailer: Mailer;
  rejectBreachedPasswords: boolean;
  effects: Effects;
  hooks: Hooks;
  mfa: Mfa;
}

/** The claim type of the link the current inbox approves an email change with. */
const APPROVAL = 'emailChangeApproval';

/** The claim type of the link that confirms an account's deletion. */
const DELETION = 'accountDeletion';

const invalidToken = (): ApiError =>
  new ApiError(400, 'The link is invalid or has expired.', {
    token: {
      code: 'validation_invalid_token',
      message: 'Invalid or expired.',
    },
  });

export async function requestEmailVerification(
  ctx: FlowContext,
  collection: AuthCollection,
  email: unknown,
): Promise<void> {
  const address = checkEmail(email);
  ctx.mailer.check();
  await countAttempt(ctx.db, [mailKey(collection.id, address)]);
  const record = await findByEmail(ctx.db, collection, address);
  if (!record || record.emailVerified === true) return;
  ctx.mailer.send('verification', collection.name, record.email as string, {
    token: await token(collection, record, 'verification', {
      email: record.email,
    }),
  });
}

export async function confirmEmailVerification(
  ctx: FlowContext,
  collection: AuthCollection,
  token: unknown,
): Promise<void> {
  const { record, claims } = await verified(
    ctx.db,
    collection,
    token,
    'verification',
  );
  // A token for an address the record no longer has proves nothing.
  if (claims.email !== record.email) throw invalidToken();
  if (record.emailVerified === true) return;
  await privilegedUpdate(ctx, collection, record, { emailVerified: true });
}

export async function requestPasswordReset(
  ctx: FlowContext,
  collection: AuthCollection,
  email: unknown,
): Promise<void> {
  const address = checkEmail(email);
  ctx.mailer.check();
  await countAttempt(ctx.db, [mailKey(collection.id, address)]);
  const record = await findByEmail(ctx.db, collection, address);
  if (!record) return;
  ctx.mailer.send('passwordReset', collection.name, record.email as string, {
    token: await token(collection, record, 'passwordReset', {
      email: record.email,
    }),
  });
}

/**
 * Rotates tokenKey (single-use token, ends sessions), verifies the email, ends
 * any lockout. The update tells the owner their password changed.
 */
export async function confirmPasswordReset(
  ctx: FlowContext,
  collection: AuthCollection,
  input: Record<string, unknown>,
): Promise<void> {
  const { record, claims } = await verified(
    ctx.db,
    collection,
    input.token,
    'passwordReset',
  );
  if (claims.email !== record.email) throw invalidToken();
  await privilegedUpdate(
    ctx,
    collection,
    record,
    {
      password: input.password,
      passwordConfirm: input.passwordConfirm,
      emailVerified: true,
    },
    'emailReset',
  );
  await ctx.mfa.resetNotice(ctx.db, ctx.schema, collection, record, 'email');
  await clearAttempts(ctx.db, [
    accountKey(collection.id, record.id as string),
    ...collection.identityFields.flatMap((name) =>
      typeof record[name] === 'string' && record[name] !== ''
        ? [identityKey(collection.id, record[name] as string)]
        : [],
    ),
  ]);
}

/**
 * When the current email is verified, its inbox must approve the change
 * first: a link goes there, and only once it is opened does the new address
 * get its own. A stolen session alone cannot move the account to another
 * inbox. Without a verified email, the new address gets its link at once.
 */
export async function requestEmailChange(
  ctx: FlowContext,
  collection: AuthCollection,
  principal: Principal,
  input: Record<string, unknown>,
): Promise<void> {
  const record = recordIn(principal, collection, 'change its email');
  const address = checkEmail(input.newEmail, 'newEmail');
  if (address.toLowerCase() === String(record.email).toLowerCase()) {
    throw new ApiError(400, 'Failed to request the email change.', {
      newEmail: {
        code: 'validation_same_email',
        message: 'Is the current email.',
      },
    });
  }
  ctx.mailer.check();
  if (record.emailVerified === true) {
    const current = record.email as string;
    await countAttempt(ctx.db, [mailKey(collection.id, current)]);
    ctx.mailer.send('emailChangeApproval', collection.name, current, {
      token: await token(
        collection,
        record,
        'emailChange',
        { email: record.email, newEmail: address, jti: newId() },
        APPROVAL,
      ),
    });
    return;
  }
  await sendEmailChange(ctx, collection, record, address, false);
}

/**
 * Opens the link the current inbox got: the new address then gets its
 * own. Each link works once, and only for the address it names.
 */
export async function approveEmailChange(
  ctx: FlowContext,
  collection: AuthCollection,
  input: Record<string, unknown>,
): Promise<void> {
  const { record, claims } = await verified(
    ctx.db,
    collection,
    input.token,
    'emailChange',
    APPROVAL,
  );
  if (
    claims.email !== record.email ||
    typeof claims.newEmail !== 'string' ||
    typeof claims.jti !== 'string' ||
    (input.newEmail !== undefined && input.newEmail !== claims.newEmail)
  ) {
    throw invalidToken();
  }
  if (!(await spendToken(ctx.db, claims.jti, claims.exp))) throw invalidToken();
  ctx.mailer.check();
  await sendEmailChange(ctx, collection, record, claims.newEmail, true);
}

async function sendEmailChange(
  ctx: FlowContext,
  collection: AuthCollection,
  record: Row,
  address: string,
  approved: boolean,
): Promise<void> {
  await countAttempt(ctx.db, [mailKey(collection.id, address)]);
  // Uniqueness is checked on confirm, so this request does not reveal it.
  ctx.mailer.send('emailChange', collection.name, address, {
    token: await token(collection, record, 'emailChange', {
      email: record.email,
      newEmail: address,
      ...(approved && { approved: true }),
    }),
  });
}

/** Marks a single-use token used; false when it was already. */
async function spendToken(db: DB, jti: string, exp: unknown): Promise<boolean> {
  const spent = await db
    .newQuery(
      `WITH expired AS (
         DELETE FROM {{${table('_used_tokens')}}} WHERE expires <= now()
       )
       INSERT INTO {{${table('_used_tokens')}}} (id_hash, expires)
       VALUES ({:idHash}, to_timestamp({:exp}))
       ON CONFLICT (id_hash) DO NOTHING
       RETURNING 1`,
    )
    .bind({
      idHash: createHash('sha256').update(jti).digest('hex'),
      exp: typeof exp === 'number' ? exp : 0,
    })
    .column();
  return spent.length > 0;
}

/**
 * Requires the current password, and with an authenticator app a code from
 * it or a recovery code in `mfaCode`; rotates tokenKey, ending every session.
 */
export async function confirmEmailChange(
  ctx: FlowContext,
  collection: AuthCollection,
  input: Record<string, unknown>,
): Promise<void> {
  const { record, claims } = await verified(
    ctx.db,
    collection,
    input.token,
    'emailChange',
  );
  if (
    claims.email !== record.email ||
    typeof claims.newEmail !== 'string' ||
    // A verified inbox must have approved the change.
    (record.emailVerified === true && claims.approved !== true)
  ) {
    throw invalidToken();
  }
  const keys = [accountKey(collection.id, record.id as string)];
  await countAttempt(ctx.db, keys);
  const ok =
    typeof input.password === 'string' &&
    (await verifyPassword(input.password, record.password as string));
  if (!ok) {
    throw new ApiError(400, 'Failed to confirm the email change.', {
      password: {
        code: 'validation_invalid_password',
        message: 'Does not match the current password.',
      },
    });
  }
  await clearAttempts(ctx.db, keys);
  await ctx.mfa.stepUp(ctx.db, collection, record, input.mfaCode);
  await privilegedUpdate(ctx, collection, record, {
    email: claims.newEmail,
    emailVerified: true,
  });
  ctx.mailer.send('emailChanged', collection.name, record.email as string);
}

/**
 * For an owner who can confirm neither with their password nor with a recent
 * sign-in, such as one who signed up through a provider: a link goes to
 * their verified email, and opening it deletes the account.
 */
export async function requestAccountDeletion(
  ctx: FlowContext,
  collection: AuthCollection,
  principal: Principal,
): Promise<void> {
  const record = recordIn(principal, collection, 'delete its account');
  if (record.emailVerified !== true) {
    throw new ApiError(
      400,
      'Verify your email first, or confirm with your password.',
    );
  }
  ctx.mailer.check();
  const email = record.email as string;
  await countAttempt(ctx.db, [mailKey(collection.id, email)]);
  ctx.mailer.send('accountDeletion', collection.name, email, {
    token: await token(
      collection,
      record,
      'verification',
      { email, jti: newId() },
      DELETION,
    ),
  });
}

/**
 * Deletes the account the link was sent for, as its owner, so the
 * collection's delete rule still decides. With an authenticator app, a code
 * from it or a recovery code is needed in `mfaCode` too.
 */
export async function confirmAccountDeletion(
  ctx: FlowContext,
  collection: AuthCollection,
  input: Record<string, unknown>,
): Promise<void> {
  const { record, claims } = await verified(
    ctx.db,
    collection,
    input.token,
    'verification',
    DELETION,
  );
  if (claims.email !== record.email || typeof claims.jti !== 'string') {
    throw invalidToken();
  }
  await ctx.mfa.stepUp(ctx.db, collection, record, input.mfaCode);
  if (!(await spendToken(ctx.db, claims.jti, claims.exp))) throw invalidToken();
  const owner: Principal = { collection, record, superuser: false };
  const apply = await planDeleteRecord(
    {
      ...systemContext(ctx, {}, owner),
      principal: owner,
      request: { method: 'DELETE', query: {}, headers: {}, body: {} },
      source: 'request',
      deletionConfirmed: true,
    },
    collection,
    record.id as string,
  );
  await ctx.db.transaction(apply);
  ctx.effects.commit();
}

function checkEmail(value: unknown, field = 'email'): string {
  if (
    typeof value !== 'string' ||
    value.length > 254 ||
    unstorableText(value) !== undefined ||
    !EMAIL_PATTERN.test(value)
  ) {
    throw new ApiError(400, 'Failed to send the email.', {
      [field]: {
        code: 'validation_invalid_email',
        message: 'Must be a valid email address.',
      },
    });
  }
  return value;
}

/** Keyed by tokenKey + collection secret, so rotating tokenKey revokes it. */
function token(
  collection: AuthCollection,
  record: Row,
  type: TokenType,
  claims: Record<string, unknown>,
  claimType: string = type,
): Promise<string> {
  const { secret, duration } = collection.tokens[type];
  return signToken(
    `${record.tokenKey as string}${secret}`,
    {
      ...claims,
      type: claimType,
      id: record.id,
      collectionId: collection.id,
    },
    duration,
  );
}

async function verified(
  db: DB,
  collection: AuthCollection,
  value: unknown,
  type: TokenType,
  claimType: string = type,
): Promise<{ record: Row; claims: Record<string, unknown> }> {
  const tokenText = typeof value === 'string' ? value : '';
  const peeked = peekToken(tokenText);
  if (!peeked || peeked.collectionId !== collection.id) throw invalidToken();
  const [record] = await db
    .select()
    .from(table(collection.name))
    .where(hash({ id: peeked.id }))
    .all();
  if (!record) throw invalidToken();
  const claims = await verifyToken(
    tokenText,
    `${record.tokenKey as string}${collection.tokens[type].secret}`,
    claimType,
  );
  if (!claims) throw invalidToken();
  return { record, claims };
}

/**
 * Goes through the records service so values are validated as on any write.
 * The token was checked against the record as read before; the write locks
 * the record and checks its tokenKey again, so of concurrent requests with
 * one token only the first succeeds and the others find the key it rotated.
 */
async function privilegedUpdate(
  ctx: FlowContext,
  collection: AuthCollection,
  record: Row,
  input: Record<string, unknown>,
  passwordOrigin?: PasswordOrigin,
): Promise<void> {
  const id = record.id as string;
  const apply = await planUpdateRecord(
    {
      ...systemContext(ctx, input),
      ...(passwordOrigin !== undefined && { passwordOrigin }),
    },
    collection,
    id,
    input,
    new URLSearchParams(),
  );
  await ctx.db.transaction(async (tx) => {
    const [locked] = await tx
      .newQuery(
        `SELECT * FROM {{${table(collection.name)}}} WHERE id = {:id} FOR NO KEY UPDATE`,
      )
      .bind({ id })
      .all();
    if (!locked || locked.tokenKey !== record.tokenKey) throw invalidToken();
    await apply(tx);
    // The owner proved the record's email for the first time. Whoever had
    // the account before may have linked a provider, and must not keep it.
    if (
      input.email === undefined &&
      input.emailVerified === true &&
      locked.emailVerified !== true
    ) {
      await unlinkUnproven(tx, collection.id, id);
    }
  });
  // What follows the update is done even if the request fails after it.
  ctx.effects.commit();
}
