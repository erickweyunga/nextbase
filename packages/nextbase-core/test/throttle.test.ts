import { afterAll, beforeAll, expect, it } from "vitest";
import { countAttempt } from "../src/auth/throttle.ts";
import { table } from "../src/db/system.ts";
import { NextBase } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "./postgres.ts";

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
  await new NextBase({ database: t.pool }).migrate();
});

afterAll(() => t.close());

const failures = async (): Promise<Record<string, number>> => {
  const rows = await t.db
    .newQuery(`SELECT key, failures FROM {{${table("_auth_attempts")}}}`)
    .all<{ key: string; failures: number }>();
  return Object.fromEntries(rows.map((r) => [r.key, r.failures]));
};

it("counts every key in one statement, each key once", async () => {
  await countAttempt(t.db, ["a", "b", "a"]);
  await countAttempt(t.db, ["b"]);
  expect(await failures()).toEqual({ a: 1, b: 2 });
});

it("refuses when any key is over the limit, and still counts the others", async () => {
  const limit = { max: 2, window: "1 minute" };
  await countAttempt(t.db, ["c"], limit);
  await countAttempt(t.db, ["c"], limit);
  await expect(countAttempt(t.db, ["d", "c"], limit)).rejects.toMatchObject({
    status: 429,
    headers: { "retry-after": expect.stringMatching(/^\d+$/) },
  });
  expect(await failures()).toMatchObject({ c: 3, d: 1 });
});

it("removes expired counts and restarts an expired count of a key", async () => {
  await t.db
    .newQuery(
      `UPDATE {{${table("_auth_attempts")}}} SET window_end = now() - interval '1 second' WHERE key IN ('a', 'b')`,
    )
    .execute();
  await countAttempt(t.db, ["b"]);
  const counts = await failures();
  expect(counts).not.toHaveProperty("a");
  expect(counts.b).toBe(1);
});
