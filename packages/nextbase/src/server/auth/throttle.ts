import type { Builder } from "@nextbase/dbx";
import { table } from "../db/system.ts";
import { ApiError } from "../errors.ts";

// Failed logins allowed per identity in one window. Counted in Postgres, so the
// limit holds across serverless instances without trusting client IP headers.
// The trade-off: someone can lock a known account out for one window.
const MAX_FAILURES = 10;
const WINDOW = "15 minutes";

/** Throws 429 when `key` has used up its failed attempts. */
export async function checkThrottle(q: Builder, key: string): Promise<void> {
  const [failures] = await q
    .newQuery(
      `SELECT failures FROM {{${table("_auth_attempts")}}} WHERE key = {:key} AND window_end > now()`,
    )
    .bind({ key })
    .column<number>();
  if (failures !== undefined && failures >= MAX_FAILURES) {
    throw new ApiError(429, "Too many failed attempts. Try again later.");
  }
}

export async function recordFailure(q: Builder, key: string): Promise<void> {
  await q
    .newQuery(
      `INSERT INTO {{${table("_auth_attempts")}}} AS a (key, failures, window_end)
       VALUES ({:key}, 1, now() + interval '${WINDOW}')
       ON CONFLICT (key) DO UPDATE SET
         failures = CASE WHEN a.window_end <= now() THEN 1 ELSE a.failures + 1 END,
         window_end = CASE WHEN a.window_end <= now() THEN now() + interval '${WINDOW}' ELSE a.window_end END`,
    )
    .bind({ key })
    .execute();
  // Keeps the table small: expired windows carry no information.
  await q
    .newQuery(
      `DELETE FROM {{${table("_auth_attempts")}}} WHERE window_end <= now()`,
    )
    .execute();
}

export async function clearFailures(q: Builder, key: string): Promise<void> {
  await q
    .newQuery(`DELETE FROM {{${table("_auth_attempts")}}} WHERE key = {:key}`)
    .bind({ key })
    .execute();
}
