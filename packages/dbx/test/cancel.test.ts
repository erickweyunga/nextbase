import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB, hash, type Pool } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "./postgres.ts";

let test: TestDatabase;
let db: DB;

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.db;
  await db
    .createTable("item", { id: "serial PRIMARY KEY", name: "text" })
    .execute();
});

afterAll(() => test.close());

beforeEach(() => db.truncateTable("item").execute());

// A statement that runs until canceled, tagged so pg_stat_activity can find it.
function sleeper(): { sql: string; tag: string } {
  const tag = randomUUID();
  return { sql: `SELECT pg_sleep(30), '${tag}'`, tag };
}

async function isRunning(tag: string): Promise<boolean> {
  const [count] = await db
    .newQuery(
      "SELECT count(*)::int FROM pg_stat_activity WHERE state = 'active' AND query LIKE {:pattern} AND pid <> pg_backend_pid()",
    )
    .bind({ pattern: `%${tag}%` })
    .row<[number]>();
  return count > 0;
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const poolSettled = (): Promise<void> =>
  waitFor(async () => test.pool.idleCount === test.pool.totalCount);

describe("cancellation", () => {
  it("cancels a running statement on the server", async () => {
    const controller = new AbortController();
    const { sql, tag } = sleeper();
    const started = Date.now();
    const query = db.newQuery(sql).withSignal(controller.signal).execute();
    await waitFor(() => isRunning(tag));

    controller.abort();
    await expect(query).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(5_000);
    await waitFor(async () => !(await isRunning(tag)));
    await poolSettled();
  });

  it("rejects with the signal's reason", async () => {
    const controller = new AbortController();
    const { sql, tag } = sleeper();
    const query = db.newQuery(sql).withSignal(controller.signal).all();
    await waitFor(() => isRunning(tag));
    const reason = new Error("request closed");
    controller.abort(reason);
    await expect(query).rejects.toBe(reason);
    await waitFor(async () => !(await isRunning(tag)));
  });

  it("never starts a statement whose signal already aborted", async () => {
    const reason = new Error("too late");
    await expect(
      db
        .insert("item", { name: "x" })
        .withSignal(AbortSignal.abort(reason))
        .execute(),
    ).rejects.toBe(reason);
    await expect(db.select().from("item").all()).resolves.toEqual([]);
  });

  it("applies a DB signal to every query, select and model", async () => {
    const controller = new AbortController();
    const scoped = db.withSignal(controller.signal);
    await scoped.insert("item", { name: "a" }).execute();
    await expect(scoped.select("name").from("item").column()).resolves.toEqual([
      "a",
    ]);

    const { sql, tag } = sleeper();
    const query = scoped.newQuery(sql).all();
    await waitFor(() => isRunning(tag));
    controller.abort();
    await expect(query).rejects.toMatchObject({ name: "AbortError" });

    await expect(scoped.select().from("item").all()).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(
      scoped.model("item", { name: "b" }).insert(),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(scoped.begin()).rejects.toMatchObject({ name: "AbortError" });
    // A per-query signal overrides the DB's.
    await expect(
      scoped.select("name").from("item").withSignal(undefined).column(),
    ).resolves.toEqual(["a"]);
    await expect(
      scoped.model("item", { id: 1, name: "c" }).withSignal(undefined).update(),
    ).resolves.toBeUndefined();
    await poolSettled();
  });

  it("cancels a statement in a transaction and rolls back", async () => {
    const controller = new AbortController();
    const { sql, tag } = sleeper();
    const before = test.pool.totalCount;
    const transaction = db
      .withSignal(controller.signal)
      .transaction(async (tx) => {
        await tx.insert("item", { name: "in tx" }).execute();
        await tx.newQuery(sql).execute();
      });
    await waitFor(() => isRunning(tag));
    controller.abort();

    await expect(transaction).rejects.toMatchObject({ name: "AbortError" });
    await waitFor(async () => !(await isRunning(tag)));
    await expect(db.select().from("item").all()).resolves.toEqual([]);
    // The connection that got the cancel request is discarded, not reused.
    await poolSettled();
    expect(test.pool.totalCount).toBeLessThanOrEqual(before);
  });

  it("leaves finished statements and later queries alone", async () => {
    const controller = new AbortController();
    const scoped = db.withSignal(controller.signal);
    await scoped.model("item", { name: "kept" }).insert();
    controller.abort();
    await expect(
      db
        .select("name")
        .from("item")
        .where(hash({ name: "kept" }))
        .column(),
    ).resolves.toEqual(["kept"]);
    await poolSettled();
  });

  it("stops waiting for a connection from an exhausted pool", async () => {
    const small = new DB(new pg.Pool({ ...test.pool.options, max: 1 }));
    const pool = small.pool as pg.Pool;
    const held = await pool.connect();
    const controller = new AbortController();
    const query = small
      .withSignal(controller.signal)
      .newQuery("SELECT 1")
      .all();
    const transaction = small
      .withSignal(controller.signal)
      .transaction(async () => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(query).rejects.toMatchObject({ name: "AbortError" });
    await expect(transaction).rejects.toMatchObject({ name: "AbortError" });

    held.release();
    // The connections handed over after the abort go straight back.
    await waitFor(async () => pool.waitingCount === 0 && pool.idleCount === 1);
    await expect(small.newQuery("SELECT 1 AS one").all()).resolves.toEqual([
      { one: 1 },
    ]);
    await pool.end();
  });

  it("falls back to stop waiting if pg internals change", async () => {
    let release = (): void => {};
    // Looks like a pg client, but its connection lacks the expected methods.
    class ChangedClient {
      processID = 1;
      secretKey = 2;
      host = "localhost";
      port = 5432;
      connection = { connect: () => {} };
      query(): Promise<{ rows: unknown[]; rowCount: number }> {
        return new Promise((resolve) => {
          release = () => resolve({ rows: [], rowCount: 0 });
        });
      }
      release(): void {}
    }
    const pool: Pool = {
      query: () => Promise.reject(new Error("not used")),
      connect: async () => new ChangedClient(),
    };
    const controller = new AbortController();
    const query = new DB(pool)
      .newQuery("SELECT 1")
      .withSignal(controller.signal)
      .all();
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(query).rejects.toMatchObject({ name: "AbortError" });
    release();
  });

  it("stops waiting on drivers without server-side cancellation", async () => {
    let release = (): void => {};
    const pool: Pool = {
      query: () => Promise.reject(new Error("not used")),
      async connect() {
        return {
          query: () =>
            new Promise((resolve) => {
              release = () => resolve({ rows: [], rowCount: 0 });
            }),
          release: () => {},
        };
      },
    };
    const controller = new AbortController();
    const query = new DB(pool)
      .newQuery("SELECT 1")
      .withSignal(controller.signal)
      .all();
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(query).rejects.toMatchObject({ name: "AbortError" });
    release();
  });
});
