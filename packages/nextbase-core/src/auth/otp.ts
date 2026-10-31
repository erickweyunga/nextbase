import { createHash, randomBytes } from 'node:crypto';
import type { AuthCollection } from '@nextbasejs/client';
import { type DB, hash, type Row } from '@nextbasejs/dbx';
import { table } from '../db/system.ts';
import type { Effects } from '../effects.ts';
import { ApiError } from '../errors.ts';
import type { Hooks } from '../records/hooks.ts';
import { systemContext, updateRecord } from '../records/service.ts';
import type { Schema } from '../schema/cache.ts';
import { codeHash, emailSignInCode, sameHash, typedCode } from './codes.ts';
import { findByEmail } from './identity.ts';
import { unlinkUnproven } from './linked-accounts.ts';
import type { Mailer } from './mail.ts';
import { clearAttempts, countAttempt, mailKey, otpKey } from './throttle.ts';

// Sign-in by an emailed code. A request answers an id whether or not the account
// exists; the code is kept hashed, works once, and ends after a few wrong ones.

export interface OtpContext {
  db: DB;
  schema: Schema;
  mailer: Mailer;
  effects: Effects;
  hooks: Hooks;
}

/** Wrong codes an id takes before it ends; the address has its own cap. */
const MAX_ATTEMPTS = 5;

/** The id of a code: what a sign-in names it by, never the code. */
function otpHash(otpId: string): string {
  return createHash('sha256').update(otpId).digest('hex');
}

/**
 * Emails a code to the account with `email` and answers the id to sign in with. An
 * unknown email gets an id with a code no one has, so nothing reveals who has an account.
 */
export async function requestOtp(
  ctx: OtpContext,
  collection: AuthCollection,
  email: unknown,
): Promise<string> {
  if (!collection.otp.enabled) {
    throw new ApiError(400, 'Sign-in by email code is not turned on.');
  }
  if (typeof email !== 'string' || email.trim() === '') {
    throw new ApiError(400, 'Failed to send a sign-in code.', {
      email: { code: 'validation_required', message: 'Required.' },
    });
  }
  const otpId = randomBytes(24).toString('base64url');
  const record = await findByEmail(ctx.db, collection, email.trim());
  let code: string;
  if (record) {
    code = await emailSignInCode(
      ctx.db,
      ctx.mailer,
      collection,
      record.email as string,
    );
  } else {
    // Counted as a real request is, so the limit answers the same.
    ctx.mailer.check();
    await countAttempt(ctx.db, [mailKey(collection.id, email.trim())]);
    code = randomBytes(16).toString('hex');
  }
  await ctx.db
    .newQuery(
      `WITH expired AS (
         DELETE FROM {{${table('_otps')}}} WHERE expires <= now()
       )
       INSERT INTO {{${table('_otps')}}}
         (id_hash, collection_id, record_id, email, code_hash, expires)
       VALUES ({:idHash}, {:collectionId}, {:recordId}, {:email}, {:codeHash},
               now() + make_interval(secs => {:duration}))`,
    )
    .bind({
      idHash: otpHash(otpId),
      collectionId: collection.id,
      recordId: record?.id ?? null,
      email: record ? (record.email as string) : email.trim(),
      codeHash: codeHash(otpId, code),
      duration: collection.otp.duration,
    })
    .execute();
  return otpId;
}

/**
 * The account a code signs in, once; wrong codes count per address, known or not.
 * The caller marks the email proven with `proveEmail` once the sign-in goes ahead.
 */
export async function signInWithOtp(
  ctx: OtpContext,
  collection: AuthCollection,
  otpId: unknown,
  code: unknown,
): Promise<Row> {
  const wrong = (): ApiError =>
    new ApiError(400, 'The code is wrong or has expired.', {
      code: { code: 'validation_invalid_code', message: 'Wrong or expired.' },
    });
  if (!collection.otp.enabled) {
    throw new ApiError(400, 'Sign-in by email code is not turned on.');
  }
  if (typeof otpId !== 'string' || otpId === '' || otpId.length > 64) {
    throw wrong();
  }
  const idHash = otpHash(otpId);
  // Counted before the check, so parallel guesses cannot pass the limit.
  const [pending] = await ctx.db
    .newQuery(
      `UPDATE {{${table('_otps')}}} SET attempts = attempts + 1
       WHERE id_hash = {:idHash} AND collection_id = {:collectionId}
         AND expires > now()
       RETURNING record_id AS "recordId", email, code_hash AS "codeHash",
         attempts`,
    )
    .bind({ idHash, collectionId: collection.id })
    .all<{
      recordId: string | null;
      email: string;
      codeHash: string;
      attempts: number;
    }>();
  if (!pending) throw wrong();
  const keys = [otpKey(collection.id, pending.email)];
  await countAttempt(ctx.db, keys);
  const typed = typedCode(code);
  const matches =
    pending.recordId !== null &&
    pending.attempts <= MAX_ATTEMPTS &&
    typed !== undefined &&
    sameHash(codeHash(otpId, typed), pending.codeHash);
  if (!matches) {
    if (pending.attempts >= MAX_ATTEMPTS) await spend(ctx.db, idHash);
    throw wrong();
  }
  // Of concurrent sign-ins with the one code, only the first spends it.
  if (!(await spend(ctx.db, idHash))) throw wrong();
  await clearAttempts(ctx.db, keys);
  const [record] = await ctx.db
    .select()
    .from(table(collection.name))
    .where(hash({ id: pending.recordId }))
    .all();
  // The code proves the inbox it was sent to, which must still be the
  // account's: a code to a former address signs in nothing.
  if (!record || record.email !== pending.email) throw wrong();
  return record;
}

/**
 * Marks the email verified and, as the verification link does, drops providers
 * linked before anyone proved it: whoever linked them may not own the email.
 */
export async function proveEmail(
  ctx: OtpContext,
  collection: AuthCollection,
  record: Row,
): Promise<void> {
  if (record.emailVerified === true) return;
  const id = record.id as string;
  await ctx.db.transaction(async (tx) => {
    await updateRecord(
      systemContext({ ...ctx, db: tx, pool: ctx.db }, { emailVerified: true }),
      collection,
      id,
      { emailVerified: true },
      new URLSearchParams(),
    );
    await unlinkUnproven(tx, collection.id, id);
  });
  ctx.effects.commit();
  record.emailVerified = true;
}

async function spend(db: DB, idHash: string): Promise<boolean> {
  const deleted = await db
    .newQuery(
      `DELETE FROM {{${table('_otps')}}} WHERE id_hash = {:idHash} RETURNING 1`,
    )
    .bind({ idHash })
    .column();
  return deleted.length > 0;
}
