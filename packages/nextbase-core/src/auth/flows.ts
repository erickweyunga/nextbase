import type { AuthCollection, TokenType } from '@nextbasejs/client';
import { type DB, hash, type Row } from '@nextbasejs/dbx';
import { table } from '../db/system.ts';
import type { Effects } from '../effects.ts';
import { ApiError } from '../errors.ts';
import type { Hooks } from '../records/hooks.ts';
import { planUpdateRecord, systemContext } from '../records/service.ts';
import { EMAIL_PATTERN } from '../records/values.ts';
import type { Schema } from '../schema/cache.ts';
import { unstorableText } from '../storable.ts';
import { findByEmail } from './identity.ts';
import { unlinkUnproven } from './linked-accounts.ts';
import type { Mailer } from './mail.ts';
import { verifyPassword } from './password.ts';
import { type Principal, recordIn } from './principal.ts';
import {
  accountKey,
  clearAttempts,
  countAttempt,
  identityKey,
  mailKey,
} from './throttle.ts';
import { peekToken, signToken, verifyToken } from './tokens.ts';

// Email verification, password reset and email change.
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
}

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
  await privilegedUpdate(ctx, collection, record, {
    password: input.password,
    passwordConfirm: input.passwordConfirm,
    emailVerified: true,
  });
  await clearAttempts(ctx.db, [
    accountKey(collection.id, record.id as string),
    ...collection.identityFields.flatMap((name) =>
      typeof record[name] === 'string' && record[name] !== ''
        ? [identityKey(collection.id, record[name] as string)]
        : [],
    ),
  ]);
}

export async function requestEmailChange(
  ctx: FlowContext,
  collection: AuthCollection,
  principal: Principal,
  newEmail: unknown,
): Promise<void> {
  const record = recordIn(principal, collection, 'change its email');
  const address = checkEmail(newEmail, 'newEmail');
  if (address.toLowerCase() === String(record.email).toLowerCase()) {
    throw new ApiError(400, 'Failed to request the email change.', {
      newEmail: {
        code: 'validation_same_email',
        message: 'Is the current email.',
      },
    });
  }
  ctx.mailer.check();
  await countAttempt(ctx.db, [mailKey(collection.id, address)]);
  // Uniqueness is checked on confirm, so this request does not reveal it.
  ctx.mailer.send('emailChange', collection.name, address, {
    token: await token(collection, record, 'emailChange', {
      email: record.email,
      newEmail: address,
    }),
  });
}

/** Requires the current password; rotates tokenKey, ending every session. */
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
  if (claims.email !== record.email || typeof claims.newEmail !== 'string') {
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
  await privilegedUpdate(ctx, collection, record, {
    email: claims.newEmail,
    emailVerified: true,
  });
  ctx.mailer.send('emailChanged', collection.name, record.email as string);
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
): Promise<string> {
  const { secret, duration } = collection.tokens[type];
  return signToken(
    `${record.tokenKey as string}${secret}`,
    { type, id: record.id, collectionId: collection.id, ...claims },
    duration,
  );
}

async function verified(
  db: DB,
  collection: AuthCollection,
  value: unknown,
  type: TokenType,
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
    type,
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
): Promise<void> {
  const id = record.id as string;
  const apply = await planUpdateRecord(
    systemContext(ctx, input),
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
