import { createHash } from 'node:crypto';
import type { Builder } from '@nextbasejs/dbx';
import { table } from '../db/system.ts';
import { ApiError } from '../errors.ts';

// Counted in Postgres so limits hold across serverless instances without
// trusting client IP headers. Trade-off: someone can lock a known account out
// for one window; a password reset still works.

export interface Limit {
  max: number;
  /** A Postgres interval, such as `15 minutes`. */
  window: string;
}

const DEFAULT_LIMIT: Limit = { max: 10, window: '15 minutes' };

/**
 * Counts before the password is checked, in one atomic upsert, so parallel
 * guesses cannot all pass. Run outside any transaction the attempt could roll
 * back, so failures stay counted.
 */
export async function countAttempt(
  q: Builder,
  keys: readonly string[],
  { max, window }: Limit = DEFAULT_LIMIT,
): Promise<void> {
  // A key listed twice would make the upsert change one row twice, which
  // Postgres rejects.
  const unique = [...new Set(keys)];
  if (unique.length === 0) return;
  // One statement counts every key and removes expired counts of other keys.
  // The keys being counted are left out of the delete, because one statement
  // cannot change a row twice; the upsert restarts their expired counts.
  const rows = await q
    .newQuery(
      `WITH expired AS (
         DELETE FROM {{${table('_auth_attempts')}}}
         WHERE window_end <= now() AND key <> ALL({:keys}::text[])
       )
       INSERT INTO {{${table('_auth_attempts')}}} AS a (key, failures, window_end)
       SELECT key, 1, now() + {:window}::interval FROM unnest({:keys}::text[]) AS key
       ON CONFLICT (key) DO UPDATE SET
         failures = CASE WHEN a.window_end <= now() THEN 1 ELSE a.failures + 1 END,
         window_end = CASE WHEN a.window_end <= now() THEN now() + {:window}::interval ELSE a.window_end END
       RETURNING failures, ceil(extract(epoch FROM window_end - now()))::int AS "retryAfter"`,
    )
    .bind({ keys: unique, window })
    .all<{ failures: number; retryAfter: number }>();
  const over = rows.filter((row) => row.failures > max);
  if (over.length > 0) {
    const retryAfter = Math.max(1, ...over.map((row) => row.retryAfter));
    throw new ApiError(
      429,
      'Too many attempts. Try again later.',
      {},
      { 'retry-after': String(retryAfter) },
    );
  }
}

export async function clearAttempts(
  q: Builder,
  keys: readonly string[],
): Promise<void> {
  await q
    .newQuery(
      `DELETE FROM {{${table('_auth_attempts')}}} WHERE key = ANY({:keys}::text[])`,
    )
    .bind({ keys: [...keys] })
    .execute();
}

/** Per account, so the limit holds whichever identity (email, username) is typed. */
export function accountKey(collectionId: string, recordId: string): string {
  return `${collectionId}:record:${recordId}`;
}

/**
 * Per typed identity. It is hashed, as anyone can type one of any length and
 * a long key would not fit the table's index.
 */
export function identityKey(collectionId: string, identity: string): string {
  const digest = createHash('sha256')
    .update(identity.toLowerCase())
    .digest('hex');
  return `${collectionId}:identity:${digest}`;
}

/** Caps texts to a phone, so no one can run up SMS costs. */
export function smsKey(collectionId: string, phone: string): string {
  return `${collectionId}:sms:${phone}`;
}

/** Code guesses for a phone, across every code sent to it. */
export function phoneKey(collectionId: string, phone: string): string {
  return `${collectionId}:phone:${phone}`;
}

/** Wrong codes of every kind for an account's second sign-in step. */
export function mfaKey(collectionId: string, recordId: string): string {
  return `${collectionId}:mfa:${recordId}`;
}

/** Wrong email codes for an address, whether or not an account has it. */
export function otpKey(collectionId: string, email: string): string {
  return `${collectionId}:otp:${email.toLowerCase()}`;
}

/** Caps emails to an address, so no one can flood an inbox. */
export function mailKey(collectionId: string, email: string): string {
  return `${collectionId}:mail:${email.toLowerCase()}`;
}

/** Caps the direct uploads an account starts, so no one can fill the bucket. */
export function uploaderKey(collectionId: string, recordId: string): string {
  return `${collectionId}:uploads:${recordId}`;
}
