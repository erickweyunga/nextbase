import type { Builder } from "@nextbasejs/dbx";
import { table } from "../db/system.ts";
import { ApiError } from "../errors.ts";

// Counted in Postgres so limits hold across serverless instances without
// trusting client IP headers. Trade-off: someone can lock a known account out
// for one window; a password reset still works.

export interface Limit {
  max: number;
  /** A Postgres interval, such as `15 minutes`. */
  window: string;
}

const DEFAULT_LIMIT: Limit = { max: 10, window: "15 minutes" };

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
  for (const key of keys) {
    const [row] = await q
      .newQuery(
        `INSERT INTO {{${table("_auth_attempts")}}} AS a (key, failures, window_end)
         VALUES ({:key}, 1, now() + {:window}::interval)
         ON CONFLICT (key) DO UPDATE SET
           failures = CASE WHEN a.window_end <= now() THEN 1 ELSE a.failures + 1 END,
           window_end = CASE WHEN a.window_end <= now() THEN now() + {:window}::interval ELSE a.window_end END
         RETURNING failures, ceil(extract(epoch FROM window_end - now()))::int AS "retryAfter"`,
      )
      .bind({ key, window })
      .all<{ failures: number; retryAfter: number }>();
    if (row && row.failures > max) {
      throw new ApiError(
        429,
        "Too many attempts. Try again later.",
        {},
        { "retry-after": String(Math.max(1, row.retryAfter)) },
      );
    }
  }
  await q
    .newQuery(
      `DELETE FROM {{${table("_auth_attempts")}}} WHERE window_end <= now()`,
    )
    .execute();
}

export async function clearAttempts(
  q: Builder,
  keys: readonly string[],
): Promise<void> {
  await q
    .newQuery(
      `DELETE FROM {{${table("_auth_attempts")}}} WHERE key = ANY({:keys}::text[])`,
    )
    .bind({ keys: [...keys] })
    .execute();
}

/** Per account, so the limit holds whichever identity (email, username) is typed. */
export function accountKey(collectionId: string, recordId: string): string {
  return `${collectionId}:record:${recordId}`;
}

export function identityKey(collectionId: string, identity: string): string {
  return `${collectionId}:identity:${identity.toLowerCase()}`;
}

/** Caps texts to a phone, so no one can run up SMS costs. */
export function smsKey(collectionId: string, phone: string): string {
  return `${collectionId}:sms:${phone}`;
}

/** Code guesses for a phone, across every code sent to it. */
export function phoneKey(collectionId: string, phone: string): string {
  return `${collectionId}:phone:${phone}`;
}

/** Caps emails to an address, so no one can flood an inbox. */
export function mailKey(collectionId: string, email: string): string {
  return `${collectionId}:mail:${email.toLowerCase()}`;
}
