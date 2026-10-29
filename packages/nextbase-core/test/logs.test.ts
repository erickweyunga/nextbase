import { DB } from "@nextbasejs/dbx";
import type pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { clientIpReader } from "../src/client-ip.ts";
import { TYPES } from "../src/db/types.ts";
import { NextBase, type NextBaseOptions } from "../src/index.ts";
import { Logger, logTimings, purgeLogs } from "../src/logs/logger.ts";
import { call, origin } from "./http.ts";
import { createTestDatabase, type TestDatabase } from "./postgres.ts";

interface LogRow {
  id: string;
  created: Date;
  level: number;
  message: string;
  data: Record<string, unknown>;
}

const PASSWORD = "password 123 456";

/** Wraps `pool` to record the SQL of each query, or fail those `fails` matches. */
function watched(
  pool: pg.Pool,
  fails?: (sql: string) => boolean,
): { pool: pg.Pool; sql: string[] } {
  const sql: string[] = [];
  const proxy = new Proxy(pool, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== "query") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (config: { text?: string } | string, ...rest: unknown[]) => {
        const text = typeof config === "string" ? config : (config.text ?? "");
        sql.push(text);
        if (fails?.(text)) return Promise.reject(new Error("log table down"));
        return (value as (...args: unknown[]) => unknown).apply(target, [
          config,
          ...rest,
        ]);
      };
    },
  });
  return { pool: proxy, sql };
}

describe("logs", () => {
  let t: TestDatabase;
  const pending: Promise<unknown>[] = [];
  const instances: NextBase[] = [];
  /** Waits for background work, such as after hooks, then the logs' writes. */
  const settle = async (): Promise<void> => {
    while (pending.length > 0) await Promise.all(pending.splice(0));
    await Promise.all(instances.map((i) => i.flush()));
  };
  const instance = (options: NextBaseOptions = {}): NextBase => {
    const created = new NextBase({
      database: t.pool,
      waitUntil: (promise) => pending.push(promise),
      ...options,
    });
    instances.push(created);
    return created;
  };
  let nextbase: NextBase;
  let admin = "";
  let user = "";
  let userId = "";

  const rows = async (): Promise<LogRow[]> => {
    await settle();
    const { rows } = await t.pool.query<LogRow>(
      "SELECT * FROM nextbase._logs ORDER BY created, id",
    );
    return rows;
  };
  const requests = async (): Promise<LogRow[]> =>
    (await rows()).filter((r) => r.data.type === "request");

  beforeAll(async () => {
    t = await createTestDatabase();
    nextbase = instance();
    await nextbase.createSuperuser("admin@example.com", "admin password!");
    admin = (
      await call(
        nextbase,
        "POST",
        "/collections/_superusers/auth-with-password",
        {
          body: { identity: "admin@example.com", password: "admin password!" },
        },
      )
    ).body.token as string;
    const superuser = nextbase.client({ superuser: true });
    await superuser.collections.create({
      name: "users",
      type: "auth",
      listRule: "",
      viewRule: "",
    });
    await superuser.collections.create({
      name: "posts",
      listRule: "",
      viewRule: "",
      createRule: "",
      fields: [{ name: "title", type: "text", max: 10 }],
    });
    const created = await superuser.collection("users").create({
      email: "robin@example.com",
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    userId = created?.id ?? "";
    user = (
      await call(nextbase, "POST", "/collections/users/auth-with-password", {
        body: { identity: "robin@example.com", password: PASSWORD },
      })
    ).body.token as string;
  });
  afterAll(async () => {
    await settle();
    await t.close();
  });
  beforeEach(async () => {
    await settle();
    await t.pool.query("TRUNCATE nextbase._logs");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("request entries", () => {
    it("writes one entry per request, with what happened", async () => {
      const reply = await call(nextbase, "GET", "/collections/posts/records", {
        token: user,
        headers: {
          "user-agent": "test agent",
          referer: "https://app.example/posts?email=robin@example.com#top",
        },
      });
      expect(reply.status).toBe(200);
      const [entry, ...others] = await rows();
      expect(others).toEqual([]);
      expect(entry).toMatchObject({
        level: 0,
        message: "GET /api/nextbase/collections/posts/records",
        data: {
          type: "request",
          method: "GET",
          url: "/api/nextbase/collections/posts/records",
          status: 200,
          auth: "users",
          userAgent: "test agent",
          referer: "https://app.example/posts",
        },
      });
      expect(entry?.id).toMatch(/^[a-z0-9]{15}$/);
      expect(entry?.data.execTime).toBeTypeOf("number");
      expect(entry?.data.execTime as number).toBeGreaterThanOrEqual(0);
      expect(Date.now() - (entry?.created.getTime() ?? 0)).toBeLessThan(60_000);
      // Opt-in only.
      expect(entry?.data).not.toHaveProperty("authId");
      expect(entry?.data).not.toHaveProperty("ip");
      expect(entry?.data).not.toHaveProperty("error");
    });

    it("logs signed-out callers and superusers, but not paths outside the API", async () => {
      await call(nextbase, "GET", "/collections/posts/records");
      await call(nextbase, "GET", "/collections", { token: admin });
      const outside = await nextbase.handle(new Request(`${origin}/elsewhere`));
      expect(outside.status).toBe(404);
      await call(nextbase, "GET", "/collections/missing/records");
      const entries = await requests();
      expect(entries.map((e) => [e.data.auth, e.data.status, e.level])).toEqual(
        [
          ["", 200, 0],
          ["_superusers", 200, 0],
          ["", 404, 4],
        ],
      );
      expect(entries[2]?.message).toBe(
        "GET /api/nextbase/collections/missing/records",
      );
    });

    it("redacts tokens, codes and states in the query", async () => {
      const file = await call(
        nextbase,
        "GET",
        "/files/posts/abc/photo.png?token=FILE-SECRET&download=1&Token=X2",
      );
      expect(file.status).toBe(404);
      const back = await call(
        nextbase,
        "GET",
        "/callback/google?code=CODE-SECRET&state=STATE-SECRET&scope=email%20profile",
      );
      expect(back.status).toBe(404);
      const [fileEntry, callback] = await requests();
      expect(fileEntry?.data.url).toBe(
        "/api/nextbase/files/posts/abc/photo.png?token=REDACTED&download=1&Token=REDACTED",
      );
      expect(callback?.data.url).toBe(
        "/api/nextbase/callback/google?code=REDACTED&state=REDACTED&scope=email%20profile",
      );
      const all = JSON.stringify(await rows());
      for (const secret of [
        "FILE-SECRET",
        "X2",
        "CODE-SECRET",
        "STATE-SECRET",
      ]) {
        expect(all).not.toContain(secret);
      }
    });

    it("never records the Authorization header, cookies or the body", async () => {
      await nextbase.handle(
        new Request(`${origin}/api/nextbase/collections/posts/records`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${user}`,
            cookie: "nextbase_session=COOKIE-SECRET; theme=dark-secret",
            "content-type": "application/json",
            origin,
          },
          body: JSON.stringify({ title: "BODYSECRET" }),
        }),
      );
      const [entry] = await requests();
      expect(entry?.data.status).toBe(200);
      const all = JSON.stringify(await rows());
      for (const secret of [
        user,
        "COOKIE-SECRET",
        "dark-secret",
        "BODYSECRET",
      ]) {
        expect(all).not.toContain(secret);
      }
      expect(all.toLowerCase()).not.toContain("authorization");
      expect(all.toLowerCase()).not.toContain("cookie");
    });

    it("keeps long URLs and user agents short", async () => {
      await call(
        nextbase,
        "GET",
        `/collections/posts/records?x=${"a".repeat(5000)}`,
        {
          headers: { "user-agent": "u".repeat(5000) },
        },
      );
      const [entry] = await requests();
      expect(String(entry?.data.url).length).toBe(1000);
      expect(String(entry?.data.userAgent).length).toBe(512);
    });

    it("records an ApiError's message and details at warn, with no stack", async () => {
      const reply = await call(nextbase, "POST", "/collections/posts/records", {
        body: { title: "far too long a title" },
      });
      expect(reply.status).toBe(400);
      const [entry] = await requests();
      expect(entry).toMatchObject({
        level: 4,
        data: {
          status: 400,
          error: reply.body.message,
          details: reply.body.data,
        },
      });
      expect(entry?.data.details).toHaveProperty("title");
      expect(entry?.data).not.toHaveProperty("stack");
    });

    it("records what was thrown, with its stack, at error, and answers as before", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      await t.pool.query(
        "CREATE TABLE IF NOT EXISTS public.secrets (k text PRIMARY KEY)",
      );
      await t.pool.query(
        "INSERT INTO public.secrets VALUES ('pg-detail-secret')",
      );
      const failing = instance({
        hooks: {
          posts: {
            async beforeCreate() {
              // A Postgres error whose `detail` holds the duplicated value.
              await t.pool.query(
                "INSERT INTO public.secrets VALUES ('pg-detail-secret')",
              );
            },
          },
        },
      });
      const reply = await call(failing, "POST", "/collections/posts/records", {
        body: { title: "Boom" },
      });
      expect(reply).toEqual({
        status: 500,
        body: {
          status: 500,
          message: "Something went wrong while processing the request.",
          data: {},
        },
      });
      const [entry] = await requests();
      expect(entry).toMatchObject({
        level: 8,
        data: {
          status: 500,
          error:
            'duplicate key value violates unique constraint "secrets_pkey"',
        },
      });
      expect(entry?.data.stack).toContain("duplicate key value");
      expect(JSON.stringify(entry)).not.toContain("pg-detail-secret");
    });

    it("records the signed-in record's id with authId", async () => {
      const logging = instance({ logs: { authId: true } });
      await call(logging, "GET", "/collections/posts/records", { token: user });
      await call(logging, "GET", "/collections/posts/records");
      const [signedIn, signedOut] = await requests();
      expect(signedIn?.data.authId).toBe(userId);
      expect(signedOut?.data).not.toHaveProperty("authId");
    });

    it("records the client's IP with ip, from clientIp", async () => {
      const headers = { "x-forwarded-for": "203.0.113.9, 198.51.100.7" };
      const logging = instance({
        logs: { ip: true },
        clientIp: { header: "x-forwarded-for" },
      });
      await call(logging, "GET", "/collections/posts/records", { headers });
      // Without clientIp, the IP is unknown, so none is recorded.
      const unknown = instance({ logs: { ip: true } });
      await call(unknown, "GET", "/collections/posts/records", { headers });
      // Without ip, a known IP is not recorded.
      const off = instance({ clientIp: { header: "x-forwarded-for" } });
      await call(off, "GET", "/collections/posts/records", { headers });
      const [known, ...rest] = await requests();
      expect(known?.data.ip).toBe("198.51.100.7");
      for (const entry of rest) expect(entry.data).not.toHaveProperty("ip");
    });

    it("keeps only entries at or above minLevel", async () => {
      const warnings = instance({ logs: { minLevel: 4 } });
      await call(warnings, "GET", "/collections/posts/records");
      await call(warnings, "GET", "/collections/nothing/records");
      const entries = await requests();
      expect(entries.map((e) => e.data.status)).toEqual([404]);
    });

    it("writes nothing with logs: false", async () => {
      const silent = instance({ logs: false });
      await call(silent, "GET", "/collections/posts/records");
      await call(silent, "GET", "/collections/nothing/records");
      expect(await rows()).toEqual([]);
    });

    it("leaves out successful health checks, the admin page and log reads", async () => {
      await call(nextbase, "GET", "/health");
      await nextbase.handle(
        new Request(`${origin}/api/nextbase/health`, { method: "HEAD" }),
      );
      await nextbase.handle(new Request(`${origin}/api/nextbase/_`));
      await call(nextbase, "GET", "/logs", { token: admin });
      await call(nextbase, "GET", "/logs/stats", { token: admin });
      expect(await rows()).toEqual([]);
      // Refused reads of the logs are logged.
      await call(nextbase, "GET", "/logs");
      await call(nextbase, "GET", "/logs", { token: user });
      expect((await requests()).map((e) => e.data.status)).toEqual([401, 403]);
    });

    it("leaves out in-process requests", async () => {
      await nextbase.client().collection("posts").getList();
      await nextbase.client({ superuser: true }).collection("posts").getList();
      expect(await rows()).toEqual([]);
    });

    it("never fails a request when writing entries fails", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const { pool } = watched(
        t.pool,
        (sql) => sql.includes("INSERT INTO") && sql.includes("_logs"),
      );
      const broken = new NextBase({
        database: pool,
        waitUntil: (promise) => pending.push(promise),
      });
      const reply = await call(broken, "GET", "/collections/posts/records");
      expect(reply.status).toBe(200);
      await broken.flush();
      expect(await rows()).toEqual([]);
      expect(error).toHaveBeenCalledWith(
        "[nextbase] writing log entries failed:",
        expect.objectContaining({ message: "log table down" }),
      );
    });
  });

  describe("OAuth2 callbacks", () => {
    const signingIn = (database: pg.Pool = t.pool): NextBase => {
      const created = new NextBase({
        database,
        appUrl: "https://app.example",
        oauth2: { github: { clientId: "client", clientSecret: "secret" } },
        waitUntil: (promise) => pending.push(promise),
      });
      instances.push(created);
      return created;
    };

    it("answer 404 for a provider that is not set up, without a redirect", async () => {
      for (const app of [nextbase, signingIn()]) {
        const reply = await call(app, "GET", "/callback/google?state=x");
        expect(reply).toMatchObject({
          status: 404,
          body: { message: "OAuth2 provider not found." },
        });
      }
    });

    it("log a failed sign-in at warn, with its code", async () => {
      const response = await signingIn().handle(
        new Request(`${origin}/api/nextbase/callback/github?state=lost`),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "https://app.example/?error=oauth2_failed",
      );
      expect(await requests()).toMatchObject([
        { level: 4, data: { status: 302, error: "oauth2_failed" } },
      ]);
    });

    it("log what broke a sign-in unexpectedly as a failure too", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const { pool } = watched(t.pool, (sql) => sql.includes("_oauth2_states"));
      const response = await signingIn(pool).handle(
        new Request(`${origin}/api/nextbase/callback/github?state=abc`, {
          headers: { cookie: "nextbase_oauth2=abc" },
        }),
      );
      expect(response.status).toBe(302);
      const entries = await rows();
      expect(entries).toMatchObject([
        {
          level: 8,
          message: "An OAuth2 sign-in failed",
          data: { type: "oauth2", error: "log table down" },
        },
        { level: 4, data: { status: 302, error: "oauth2_failed" } },
      ]);
      expect(error).toHaveBeenCalledWith(
        "[nextbase] an OAuth2 sign-in failed:",
        expect.objectContaining({ message: "log table down" }),
      );
    });
  });

  describe("background failures", () => {
    it("logs an after hook that fails at error", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const hooked = instance({
        hooks: {
          posts: {
            afterCreate() {
              throw new Error("webhook down");
            },
          },
        },
      });
      await hooked.client({ superuser: true }).collection("posts").create({
        title: "Hooked",
      });
      const [entry, ...others] = await rows();
      expect(others).toEqual([]);
      expect(entry).toMatchObject({
        level: 8,
        message: "AfterCreate hook for posts failed",
        data: { type: "hook", error: "webhook down" },
      });
      expect(entry?.data.stack).toContain("webhook down");
      expect(error).toHaveBeenCalledWith(
        "[nextbase] afterCreate hook for posts failed:",
        expect.objectContaining({ message: "webhook down" }),
      );
    });

    it("logs mail that cannot be sent at error", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const mailing = instance({
        mail: {
          from: "app@example.com",
          appUrl: "https://app.example",
          send: async () => {
            throw new Error("smtp down");
          },
        },
      });
      const reply = await call(
        mailing,
        "POST",
        "/collections/users/request-password-reset",
        { body: { email: "robin@example.com" } },
      );
      expect(reply.status).toBe(204);
      const failures = (await rows()).filter((r) => r.data.type === "mail");
      expect(failures).toMatchObject([
        {
          level: 8,
          message: "Sending a passwordReset email failed",
          data: { type: "mail", error: "smtp down" },
        },
      ]);
    });

    it("are logged even with minLevel above info, but not with logs: false", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const options = (logs: NextBaseOptions["logs"]): NextBaseOptions => ({
        logs,
        hooks: {
          posts: {
            afterCreate() {
              throw new Error("webhook down");
            },
          },
        },
      });
      await instance(options({ minLevel: 8 }))
        .client({ superuser: true })
        .collection("posts")
        .create({ title: "Kept" });
      await instance(options(false))
        .client({ superuser: true })
        .collection("posts")
        .create({ title: "Dropped" });
      expect((await rows()).length).toBe(1);
    });
  });

  describe("writing", () => {
    const logger = (
      pool: pg.Pool,
      options: ConstructorParameters<typeof Logger>[0] = {},
    ): Logger =>
      new Logger(options, {
        db: () => new DB(pool, { types: TYPES }),
        ready: async () => {},
        waitUntil: (promise) => pending.push(promise),
      });
    const inserts = (sql: string[]): number =>
      sql.filter((s) => s.includes("INSERT INTO") && s.includes("_logs"))
        .length;

    it("writes a burst of entries with one insert", async () => {
      const { pool, sql } = watched(t.pool);
      const log = logger(pool);
      for (let i = 0; i < 50; i++) log.add(0, `entry ${i}`, { i });
      await settle();
      expect(inserts(sql)).toBe(1);
      expect((await rows()).length).toBe(50);
    });

    it("writes at once every 200 entries", async () => {
      const { pool, sql } = watched(t.pool);
      const log = logger(pool);
      for (let i = 0; i < 450; i++) log.add(0, "entry", {});
      expect(inserts(sql)).toBe(0);
      await settle();
      expect(inserts(sql)).toBe(3);
      expect((await rows()).length).toBe(450);
    });

    it("drops entries past 1000 waiting to be sent, with one warning", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const log = logger(t.pool);
      for (let i = 0; i < 1500; i++) log.add(0, "entry", {});
      await log.flush();
      // The first 200 were sent at once, so only 1000 more could wait.
      expect((await rows()).length).toBe(1200);
      expect(warn).toHaveBeenCalledTimes(1);
      // Once sent, new entries are kept again.
      log.add(0, "after", {});
      expect((await rows()).length).toBe(1201);
    });

    it("runs one insert at a time, and keeps entries added while it runs", async () => {
      let running = 0;
      let most = 0;
      let release: () => void = () => {};
      const slow = new Promise<void>((resolve) => {
        release = resolve;
      });
      const db = new DB(t.pool, { types: TYPES });
      const log = new Logger(
        {},
        {
          db: () =>
            new Proxy(db, {
              get(target, prop) {
                if (prop !== "newQuery")
                  return Reflect.get(target, prop, target);
                return (sql: string) => {
                  const query = target.newQuery(sql);
                  if (!sql.startsWith("INSERT")) return query;
                  const execute = query.execute.bind(query);
                  query.execute = async () => {
                    running++;
                    most = Math.max(most, running);
                    await slow;
                    try {
                      return await execute();
                    } finally {
                      running--;
                    }
                  };
                  return query;
                };
              },
            }),
          ready: async () => {},
          waitUntil: () => {},
        },
      );
      for (let i = 0; i < 900; i++) log.add(0, "entry", {});
      await new Promise((resolve) => setImmediate(resolve));
      // 200 are being sent and 700 wait: 300 more still fit, since only
      // unsent entries count.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      for (let i = 0; i < 300; i++) log.add(0, "later", {});
      expect(warn).not.toHaveBeenCalled();
      release();
      await log.flush();
      expect(most).toBe(1);
      expect((await rows()).length).toBe(1200);
    });

    it("are all written by flush, without waitUntil", async () => {
      const plain = new NextBase({ database: t.pool, waitUntil: () => {} });
      await call(plain, "GET", "/collections/posts/records");
      await plain.flush();
      const { rows: written } = await t.pool.query(
        "SELECT message FROM nextbase._logs",
      );
      expect(written).toEqual([
        { message: "GET /api/nextbase/collections/posts/records" },
      ]);
      // Nothing waits, so it resolves at once.
      await plain.flush();
    });

    it("time entries by the wall clock, never going backwards", async () => {
      const log = logger(t.pool);
      const start = Date.now();
      let clock = start;
      vi.spyOn(Date, "now").mockImplementation(() => clock);
      log.add(0, "first", {});
      clock = start - 60_000;
      log.add(0, "second", {});
      log.add(0, "third", {});
      vi.mocked(Date.now).mockRestore();
      await log.flush();
      const { rows: times } = await t.pool.query<{
        message: string;
        micros: string;
      }>(
        "SELECT message, (extract(epoch FROM created) * 1000000)::bigint::text AS micros FROM nextbase._logs ORDER BY created",
      );
      expect(times.map((r) => r.message)).toEqual(["first", "second", "third"]);
      const [a, b, c] = times.map((r) => BigInt(r.micros));
      expect(a).toBe(BigInt(start) * 1000n);
      expect(b).toBe((a as bigint) + 1n);
      expect(c).toBe((a as bigint) + 2n);
    });

    it("stores text Postgres would refuse, instead of failing the insert", async () => {
      const log = logger(t.pool);
      log.add(0, "nul \0 here", { lone: "\ud800", "key\0": ["\0"] });
      log.add(0, "fine", {});
      const [odd, fine] = await rows();
      expect(odd).toMatchObject({
        message: "nul � here",
        data: { lone: "�", "key�": ["�"] },
      });
      expect(fine?.message).toBe("fine");
    });

    it("checks its options", () => {
      const db = { pool: t.pool };
      expect(() => logger(db.pool, { maxDays: 0 })).toThrow(RangeError);
      expect(() => logger(db.pool, { maxDays: Number.NaN })).toThrow(
        RangeError,
      );
      expect(() =>
        logger(db.pool, { minLevel: Number.POSITIVE_INFINITY }),
      ).toThrow(RangeError);
      expect(() =>
        logger(db.pool, { ip: "yes" as unknown as boolean }),
      ).toThrow(TypeError);
      expect(() => instance({ logs: true as unknown as false })).toThrow(
        TypeError,
      );
    });
  });

  describe("retention", () => {
    const defaults = { ...logTimings };
    afterEach(() => {
      Object.assign(logTimings, defaults);
    });

    const insertAged = (count: number, age: string): Promise<unknown> =>
      t.pool.query(
        `INSERT INTO nextbase._logs (id, created, level, message)
         SELECT substr(md5(random()::text || g::text), 1, 15), now() - $1::interval, 0, 'old'
         FROM generate_series(1, $2) g`,
        [age, count],
      );

    it("deletes only expired entries, in batches", async () => {
      await insertAged(10_005, "3 days");
      await insertAged(3, "12 hours");
      await purgeLogs(new DB(t.pool), 1);
      expect((await rows()).length).toBe(3);
    });

    it("runs in the background as entries are written, at most once per interval", async () => {
      const { pool, sql } = watched(t.pool);
      const log = new Logger(
        { maxDays: 2 },
        {
          db: () => new DB(pool, { types: TYPES }),
          ready: async () => {},
          waitUntil: (promise) => pending.push(promise),
        },
      );
      const deletes = (): number =>
        sql.filter((s) => s.startsWith("DELETE FROM")).length;
      await insertAged(2, "3 days");
      await insertAged(2, "1 day");
      log.add(0, "new", {});
      await settle();
      expect((await rows()).map((r) => r.message).sort()).toEqual([
        "new",
        "old",
        "old",
      ]);
      expect(deletes()).toBe(1);
      logTimings.purgeMs = 60_000;
      log.add(0, "newer", {});
      await settle();
      expect(deletes()).toBe(1);
      logTimings.purgeMs = 0;
      log.add(0, "newest", {});
      await settle();
      expect(deletes()).toBe(2);
    });
  });

  describe("routes", () => {
    const superuser = () => nextbase.client({ superuser: true });

    beforeEach(async () => {
      await call(nextbase, "GET", "/collections/posts/records");
      await call(nextbase, "GET", "/collections/missing/records");
      await call(nextbase, "POST", "/collections/posts/records", {
        body: { title: "far too long a title" },
      });
      await settle();
    });

    it("are for superusers only", async () => {
      for (const path of ["/logs", "/logs/stats", "/logs/abcdefghijklmno"]) {
        expect((await call(nextbase, "GET", path)).status).toBe(401);
        expect(
          (await call(nextbase, "GET", path, { token: user })).status,
        ).toBe(403);
      }
      expect((await call(nextbase, "DELETE", "/logs")).status).toBe(401);
      expect(
        (await call(nextbase, "DELETE", "/logs", { token: user })).status,
      ).toBe(403);
      expect((await requests()).length).toBeGreaterThanOrEqual(3);
    });

    it("list entries newest first, with paging", async () => {
      const page = await superuser().logs.getList(1, 2);
      expect(page).toMatchObject({
        page: 1,
        perPage: 2,
        totalItems: 3,
        totalPages: 2,
      });
      expect(page.items.map((e) => e.data.status)).toEqual([400, 404]);
      expect(page.items[0]).not.toHaveProperty("collectionId");
      expect(Object.keys(page.items[0] ?? {}).sort()).toEqual([
        "created",
        "data",
        "id",
        "level",
        "message",
      ]);
      const next = await superuser().logs.getList(2, 2);
      expect(next.items.map((e) => e.data.status)).toEqual([200]);
      const oldest = await superuser().logs.getList(1, 3, { sort: "created" });
      expect(oldest.items.map((e) => e.data.status)).toEqual([200, 404, 400]);
    });

    it("filter on level, message and data", async () => {
      const list = async (filter: string) =>
        (
          await superuser().logs.getList(1, 30, { filter, sort: "created" })
        ).items.map((e) => e.data.status);
      expect(await list("data.status >= 400")).toEqual([404, 400]);
      expect(await list("level >= 4")).toEqual([404, 400]);
      expect(await list('data.method = "POST"')).toEqual([400]);
      expect(await list('message ~ "missing"')).toEqual([404]);
      expect(await list('data.type = "request" && level = 0')).toEqual([200]);
      expect(
        await list(
          `created > "${new Date(Date.now() + 60_000).toISOString()}"`,
        ),
      ).toEqual([]);
      const bad = await call(nextbase, "GET", "/logs?filter=nope%20%3D%201", {
        token: admin,
      });
      expect(bad.status).toBe(400);
      const unsortable = await call(nextbase, "GET", "/logs?sort=data", {
        token: admin,
      });
      expect(unsortable.status).toBe(400);
    });

    it("view one entry", async () => {
      const [first] = (await superuser().logs.getList(1, 1)).items;
      const entry = await superuser().logs.getOne(first?.id ?? "");
      expect(entry).toEqual(first);
      const missing = await call(nextbase, "GET", "/logs/abcdefghijklmno", {
        token: admin,
      });
      expect(missing).toMatchObject({
        status: 404,
        body: { message: "Log entry not found." },
      });
    });

    it("count entries per hour", async () => {
      // Hours, oldest first, from the entries themselves.
      const buckets = (entries: LogRow[]) => {
        const totals = new Map<string, number>();
        for (const { created } of entries) {
          const hour = new Date(created);
          hour.setUTCMinutes(0, 0, 0);
          const key = hour.toISOString();
          totals.set(key, (totals.get(key) ?? 0) + 1);
        }
        return [...totals].map(([date, total]) => ({ date, total }));
      };
      const entries = await rows();
      expect(await superuser().logs.getStats()).toEqual(buckets(entries));
      expect(
        await superuser().logs.getStats({ filter: "data.status >= 400" }),
      ).toEqual(
        buckets(entries.filter((e) => (e.data.status as number) >= 400)),
      );
      expect(await superuser().logs.getStats({ filter: "level > 8" })).toEqual(
        [],
      );
      const bad = await call(nextbase, "GET", "/logs/stats?filter=%3D%3D", {
        token: admin,
      });
      expect(bad.status).toBe(400);
    });

    it("delete every entry, and log that they did", async () => {
      expect(
        (await call(nextbase, "DELETE", "/logs", { token: admin })).status,
      ).toBe(204);
      expect(await rows()).toMatchObject([
        {
          message: "DELETE /api/nextbase/logs",
          data: { status: 204, auth: "_superusers" },
        },
      ]);
    });

    it("delete without waiting for readers of the log", async () => {
      // TRUNCATE would wait for this transaction's lock to go.
      const reader = await t.pool.connect();
      try {
        await reader.query("BEGIN");
        await reader.query("SELECT count(*) FROM nextbase._logs");
        const reply = await Promise.race([
          call(nextbase, "DELETE", "/logs", { token: admin }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("the delete waited")), 5_000),
          ),
        ]);
        expect(reply.status).toBe(204);
      } finally {
        await reader.query("ROLLBACK");
        reader.release();
      }
    });

    it("are not in the schema or the records API", async () => {
      const names = (await superuser().collections.getFullList()).map(
        (c) => c.name,
      );
      expect(names).not.toContain("_logs");
      const reply = await call(nextbase, "GET", "/collections/_logs/records", {
        token: admin,
      });
      expect(reply.status).toBe(404);
    });
  });
});

describe("clientIp", () => {
  const request = (headers: [string, string][]): Request => {
    const h = new Headers();
    for (const [name, value] of headers) h.append(name, value);
    return new Request("http://localhost/", { headers: h });
  };

  it("is unknown by default, and read from Vercel's headers on Vercel", () => {
    const headers: [string, string][] = [
      ["x-vercel-forwarded-for", "203.0.113.1"],
      ["x-forwarded-for", "198.51.100.1"],
    ];
    expect(clientIpReader(undefined, false)(request(headers))).toBeUndefined();
    expect(clientIpReader(undefined, true)(request(headers))).toBe(
      "203.0.113.1",
    );
    expect(
      clientIpReader("vercel", false)(request([["x-real-ip", "203.0.113.2"]])),
    ).toBe("203.0.113.2");
  });

  it("takes the rightmost entry, past trusted hops", () => {
    const req = request([["x-forwarded-for", "1.1.1.1, 2.2.2.2,3.3.3.3"]]);
    expect(clientIpReader({ header: "X-Forwarded-For" })(req)).toBe("3.3.3.3");
    expect(
      clientIpReader({ header: "x-forwarded-for", trustedHops: 1 })(req),
    ).toBe("2.2.2.2");
    expect(
      clientIpReader({ header: "x-forwarded-for", trustedHops: 2 })(req),
    ).toBe("1.1.1.1");
    expect(
      clientIpReader({ header: "x-forwarded-for", trustedHops: 3 })(req),
    ).toBeUndefined();
  });

  it("merges repeated header lines", () => {
    const req = request([
      ["x-forwarded-for", "1.1.1.1, 2.2.2.2"],
      ["x-forwarded-for", "3.3.3.3"],
    ]);
    const read = (trustedHops: number) =>
      clientIpReader({ header: "x-forwarded-for", trustedHops })(req);
    expect(read(0)).toBe("3.3.3.3");
    expect(read(1)).toBe("2.2.2.2");
  });

  it("refuses anything that is not an IP, and unwraps IPv4-mapped IPv6", () => {
    const read = (value: string) =>
      clientIpReader({ header: "x-ip" })(request([["x-ip", value]]));
    expect(read("unknown")).toBeUndefined();
    expect(read("1.2.3.4:")).toBeUndefined();
    expect(read("[1.2.3.4]:80x")).toBeUndefined();
    expect(read("999.1.1.1")).toBeUndefined();
    expect(read("1.1.1.1, ")).toBe("1.1.1.1");
    expect(read("::ffff:10.0.0.1")).toBe("10.0.0.1");
    expect(read("::FFFF:10.0.0.1")).toBe("10.0.0.1");
    expect(read("2001:DB8::1")).toBe("2001:db8::1");
    expect(read("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe("2001:db8::1");
  });

  it("drops ports and zone ids, and unwraps every IPv4-mapped form", () => {
    const read = (value: string) =>
      clientIpReader({ header: "x-ip" })(request([["x-ip", value]]));
    expect(read("1.2.3.4:5678")).toBe("1.2.3.4");
    expect(read("[2001:db8::1]:443")).toBe("2001:db8::1");
    expect(read("[2001:DB8:0::1]")).toBe("2001:db8::1");
    expect(read("fe80::1%eth0")).toBe("fe80::1");
    expect(read("[fe80::1%25eth0]:80")).toBe("fe80::1");
    expect(read("0:0:0:0:0:ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(read("::ffff:c000:280")).toBe("192.0.2.128");
    expect(read("[::ffff:1.2.3.4]:443")).toBe("1.2.3.4");
    // Not mapped: kept as IPv6.
    expect(read("::1")).toBe("::1");
    expect(read("64:ff9b::1.2.3.4")).toBe("64:ff9b::102:304");
    expect(clientIpReader({ header: "x-ip" })(request([]))).toBeUndefined();
  });

  it("takes a function, whose result is checked too", () => {
    expect(clientIpReader(() => " 10.1.2.3 ")(request([]))).toBe("10.1.2.3");
    expect(clientIpReader(() => "nope")(request([]))).toBeUndefined();
    expect(clientIpReader(() => undefined)(request([]))).toBeUndefined();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      clientIpReader(() => {
        throw new Error("bad");
      })(request([])),
    ).toBeUndefined();
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("checks its option", () => {
    expect(() => clientIpReader("cloudflare" as "vercel")).toThrow(TypeError);
    expect(() => clientIpReader({ header: "" })).toThrow(TypeError);
    expect(() => clientIpReader({ header: "bad header" })).toThrow(TypeError);
    expect(() => clientIpReader({ header: "x-ip", trustedHops: -1 })).toThrow(
      RangeError,
    );
    expect(() => clientIpReader({ header: "x-ip", trustedHops: 1.5 })).toThrow(
      RangeError,
    );
  });
});
