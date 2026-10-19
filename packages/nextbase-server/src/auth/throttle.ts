import type { Builder } from "@nextbasejs/dbx";
import { table } from "../db/system.ts";
import { ApiError } from "../errors.ts";

// Password attempts allowed per key in one window. Counted in Postgres, so the
// limit holds across serverless instances without trusting client IP headers.
// The trade-off: someone can lock a known account out for one window.
const MAX_ATTEMPTS = 10;
const WINDOW = "15 minutes";

/**
 * Counts a password attempt for each key, before the password is checked,
 * and throws 429 once a key is over the limit. Counting first, in one atomic
 * upsert, keeps parallel guesses from all passing a check made before any
 * of them is counted. Run it outside any transaction the attempt's outcome
 * could roll back, so failures stay counted.
 */
export async function countAttempt(
  q: Builder,
  keys: readonly string[],
): Promise<void> {
  for (const key of keys) {
    const [row] = await q
      .newQuery(
        `INSERT INTO {{${table("_auth_attempts")}}} AS a (key, failures, window_end)
         VALUES ({:key}, 1, now() + interval '${WINDOW}')
         ON CONFLICT (key) DO UPDATE SET
           failures = CASE WHEN a.window_end <= now() THEN 1 ELSE a.failures + 1 END,
           window_end = CASE WHEN a.window_end <= now() THEN now() + interval '${WINDOW}' ELSE a.window_end END
         RETURNING failures, ceil(extract(epoch FROM window_end - now()))::int AS "retryAfter"`,
      )
      .bind({ key })
      .all<{ failures: number; retryAfter: number }>();
    if (row && row.failures > MAX_ATTEMPTS) {
      throw new ApiError(
        429,
        "Too many attempts. Try again later.",
        {},
        { "retry-after": String(Math.max(1, row.retryAfter)) },
      );
    }
  }
  // Keeps the table small: expired windows carry no information.
  await q
    .newQuery(
      `DELETE FROM {{${table("_auth_attempts")}}} WHERE window_end <= now()`,
    )
    .execute();
}

/** Forgets the attempts counted for `keys`, after a correct password. */
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

/**
 * The throttle key of an account, so its limit holds whichever identity
 * (email, username) the attempts use.
 */
export function accountKey(collectionId: string, recordId: string): string {
  return `${collectionId}:record:${recordId}`;
}

/** The throttle key of a typed identity, which may match no account. */
export function identityKey(collectionId: string, identity: string): string {
  return `${collectionId}:identity:${identity.toLowerCase()}`;
}

/** The throttle key of emails sent to an address, so no one can flood an inbox. */
export function mailKey(collectionId: string, email: string): string {
  return `${collectionId}:mail:${email.toLowerCase()}`;
}
