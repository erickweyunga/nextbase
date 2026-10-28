import type { AuthCollection } from "@nextbasejs/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "../src/auth/principal.ts";
import { compileFilter } from "../src/filter/compiler.ts";
import { NextBase } from "../src/index.ts";
import { Schema } from "../src/schema/cache.ts";
import { loadCollections } from "../src/schema/store.ts";
import { call, type Reply } from "./http.ts";
import { createTestDatabase, type TestDatabase } from "./postgres.ts";

type Who = "admin" | "ann" | "bob" | undefined;

describe("records hardening", () => {
  let t: TestDatabase;
  let nextbase: NextBase;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};

  const as = (
    who: Who,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Reply> =>
    call(nextbase, method, path, {
      token: who ? tokens[who] : undefined,
      body,
    });
  const ok = async (reply: Promise<Reply>): Promise<Reply> => {
    const r = await reply;
    if (r.status >= 300)
      throw new Error(`${r.status}: ${JSON.stringify(r.body)}`);
    return r;
  };
  const newCollection = async (
    body: Record<string, unknown>,
  ): Promise<string> =>
    (await ok(as("admin", "POST", "/collections", body))).body.id as string;
  const sql = (
    text: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>[]> =>
    t.db.newQuery(text).bind(params).all();

  beforeAll(async () => {
    t = await createTestDatabase();
    nextbase = new NextBase({ database: t.pool });
    await nextbase.createSuperuser("admin@example.com", "admin password 123");
    const login = async (
      collection: string,
      identity: string,
      password: string,
    ): Promise<string> =>
      (
        await call(
          nextbase,
          "POST",
          `/collections/${collection}/auth-with-password`,
          { body: { identity, password } },
        )
      ).body.token as string;
    tokens.admin = await login(
      "_superusers",
      "admin@example.com",
      "admin password 123",
    );
    ids.users = await newCollection({
      name: "users",
      type: "auth",
      listRule: "",
      viewRule: "",
      createRule: "",
      fields: [{ name: "name", type: "text" }],
    });
    for (const name of ["ann", "bob"]) {
      const reply = await ok(
        as(undefined, "POST", "/collections/users/records", {
          email: `${name}@example.com`,
          name,
          password: "password12345678",
          passwordConfirm: "password12345678",
        }),
      );
      ids[name] = reply.body.id as string;
      tokens[name] = await login(
        "users",
        `${name}@example.com`,
        "password12345678",
      );
    }
  });
  afterAll(() => t.close());

  describe("rule matrix", () => {
    const actions = ["list", "view", "create", "update", "delete"] as const;
    const people: Who[] = [undefined, "ann", "bob", "admin"];

    // Expected status per rule, action and caller (anonymous, owner, other, superuser).
    const expected: Record<
      string,
      Record<(typeof actions)[number], number[]>
    > = {
      null: {
        list: [403, 403, 403, 200],
        view: [403, 403, 403, 200],
        create: [403, 403, 403, 200],
        update: [403, 403, 403, 200],
        delete: [403, 403, 403, 204],
      },
      empty: {
        list: [200, 200, 200, 200],
        view: [200, 200, 200, 200],
        create: [200, 200, 200, 200],
        update: [200, 200, 200, 200],
        delete: [204, 204, 204, 204],
      },
      owner: {
        list: [200, 200, 200, 200],
        view: [404, 200, 404, 200],
        create: [400, 200, 400, 200],
        update: [404, 200, 404, 200],
        delete: [404, 204, 404, 204],
      },
    };
    const rules: Record<string, string | null> = {
      null: null,
      empty: "",
      owner: "owner = @request.auth.id",
    };

    for (const [kind, rule] of Object.entries(rules)) {
      it(`enforces ${kind} rules on every action for every caller`, async () => {
        const name = `matrix_${kind}`;
        await newCollection({
          name,
          listRule: rule,
          viewRule: rule,
          createRule: rule,
          updateRule: rule,
          deleteRule: rule,
          fields: [
            { name: "owner", type: "relation", collectionId: ids.users },
            { name: "n", type: "number" },
          ],
        });
        const records = `/collections/${name}/records`;
        const fresh = async (): Promise<string> =>
          (await ok(as("admin", "POST", records, { owner: ids.ann }))).body
            .id as string;

        for (const action of actions) {
          for (const [i, who] of people.entries()) {
            let reply: Reply;
            if (action === "list") reply = await as(who, "GET", records);
            else if (action === "view")
              reply = await as(who, "GET", `${records}/${await fresh()}`);
            else if (action === "create")
              reply = await as(who, "POST", records, { owner: ids.ann });
            else if (action === "update")
              reply = await as(who, "PATCH", `${records}/${await fresh()}`, {
                "n+": 1,
              });
            else reply = await as(who, "DELETE", `${records}/${await fresh()}`);
            expect([action, who ?? "anonymous", reply.status]).toEqual([
              action,
              who ?? "anonymous",
              expected[kind]?.[action][i],
            ]);
            // The owner rule filters lists instead of failing them.
            if (action === "list" && kind === "owner" && reply.status === 200) {
              const owners = (reply.body.items as { owner: string }[]).map(
                (r) => r.owner,
              );
              expect(
                owners.every(
                  (o) => who === "admin" || (who === "ann" && o === ids.ann),
                ),
              ).toBe(true);
              if (who === undefined || who === "bob")
                expect(owners).toEqual([]);
            }
          }
        }
      });
    }
  });

  describe("concurrency", () => {
    beforeAll(async () => {
      ids.counters = await newCollection({
        name: "counters",
        listRule: "",
        viewRule: "",
        createRule: "",
        updateRule: "",
        deleteRule: "",
        fields: [
          { name: "n", type: "number" },
          {
            name: "mentions",
            type: "relation",
            collectionId: ids.users,
            maxSelect: 10,
          },
        ],
      });
    });

    it("serializes concurrent increments on one record", async () => {
      const id = (
        await ok(as("ann", "POST", "/collections/counters/records", {}))
      ).body.id as string;
      const replies = await Promise.all(
        Array.from({ length: 25 }, () =>
          as("ann", "PATCH", `/collections/counters/records/${id}`, {
            "n+": 1,
          }),
        ),
      );
      expect(replies.map((r) => r.status)).toEqual(Array(25).fill(200));
      expect(
        (await as("ann", "GET", `/collections/counters/records/${id}`)).body.n,
      ).toBe(25);
    });

    it("lets exactly one of many creates with the same id win", async () => {
      const replies = await Promise.all(
        Array.from({ length: 10 }, () =>
          as("ann", "POST", "/collections/counters/records", {
            id: "same00000000000",
          }),
        ),
      );
      const statuses = replies.map((r) => r.status).sort();
      expect(statuses).toEqual([200, ...Array(9).fill(400)]);
      expect(replies.find((r) => r.status === 400)?.body.data).toMatchObject({
        id: { code: "validation_not_unique" },
      });
    });

    it("never leaves a reference to a record deleted concurrently", async () => {
      for (let i = 0; i < 15; i++) {
        const target = (
          await ok(
            as("admin", "POST", "/collections/users/records", {
              email: `target${i}@example.com`,
              password: "password12345678",
              passwordConfirm: "password12345678",
            }),
          )
        ).body.id as string;
        const [created, deleted] = await Promise.all([
          as("admin", "POST", "/collections/counters/records", {
            mentions: [target, ids.bob],
          }),
          as("admin", "DELETE", `/collections/users/records/${target}`),
        ]);
        expect([200, 400]).toContain(created.status);
        expect(deleted.status).toBe(204);
      }
      const dangling = await sql(`
        SELECT c.id FROM nextbase.counters c, unnest(c.mentions) AS m(id)
        WHERE NOT EXISTS (SELECT 1 FROM nextbase.users u WHERE u.id = m.id)`);
      expect(dangling).toEqual([]);
    });

    it("answers writes racing a schema change with success, validation errors or 409, never 500", async () => {
      await newCollection({
        name: "racing",
        createRule: "",
        listRule: "",
        fields: [{ id: "label00000", name: "label", type: "text" }],
      });
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) {
        const name = i % 2 === 0 ? "title" : "label";
        const replies = await Promise.all([
          as("admin", "PATCH", "/collections/racing", {
            fields: [{ id: "label00000", name, type: "text" }],
          }),
          ...Array.from({ length: 5 }, () =>
            as("ann", "POST", "/collections/racing/records", {
              label: "x",
              title: "x",
            }),
          ),
          as(
            "ann",
            "GET",
            "/collections/racing/records?filter=" +
              encodeURIComponent('label = "x"'),
          ),
        ]);
        statuses.push(...replies.map((r) => r.status));
      }
      expect(statuses.filter((s) => s >= 500)).toEqual([]);
    });
  });

  describe("edge-case values", () => {
    const records = "/collections/edge/records";
    beforeAll(async () => {
      await newCollection({
        name: "edge",
        listRule: "",
        viewRule: "",
        createRule: "",
        updateRule: "",
        fields: [
          { name: "text", type: "text", max: 3 },
          { name: "n", type: "number" },
          { name: "when", type: "date" },
          { name: "data", type: "json" },
          { name: "constructor", type: "text" },
          { name: "toString", type: "text" },
        ],
      });
    });

    it("refuses unstorable text in emails rather than changing it", async () => {
      // Postgres would store a lone surrogate as U+FFFD, a different email.
      const email = "a\ud800@example.com";
      const reset = await as(
        undefined,
        "POST",
        "/collections/users/request-password-reset",
        { email },
      );
      expect(reset.status).toBe(400);
      expect(reset.body.data).toMatchObject({
        email: { code: "validation_invalid_email" },
      });
      await expect(
        nextbase.createSuperuser(email, "admin password 123"),
      ).rejects.toThrow();
      expect(
        await sql(
          "SELECT 1 FROM nextbase._superusers WHERE email LIKE 'a_@example.com'",
        ),
      ).toEqual([]);
    });

    it("rejects NUL characters wherever Postgres would", async () => {
      const nul = "a\u0000";
      expect(
        (await as("ann", "POST", records, { text: nul })).body.data,
      ).toMatchObject({ text: { code: "validation_invalid_value" } });
      expect(
        (await as("ann", "POST", records, { data: { nested: [nul] } })).status,
      ).toBe(400);
      expect(
        (await as("ann", "POST", records, { data: { [nul]: 1 } })).status,
      ).toBe(400);
      expect(
        (
          await as(
            "ann",
            "GET",
            `${records}?filter=${encodeURIComponent(`text = "${nul}"`)}`,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await as(
            "ann",
            "GET",
            `${records}?filter=${encodeURIComponent(`text ~ "${nul}"`)}`,
          )
        ).status,
      ).toBe(400);
      const login = await call(
        nextbase,
        "POST",
        "/collections/users/auth-with-password",
        {
          body: {
            identity: `ann@example.com${nul}`,
            password: "password12345678",
          },
        },
      );
      expect(login.status).toBe(400);
      expect((await as("ann", "GET", `${records}/%00`)).status).toBe(404);
      expect(
        (await as("ann", "GET", `${records}/UPPERCASE000000`)).status,
      ).toBe(404);
    });

    it("rejects lone surrogates, which UTF-8 cannot store", async () => {
      await newCollection({
        name: "unicode",
        listRule: "",
        viewRule: "",
        createRule: "",
        updateRule: "",
        fields: [
          { name: "text", type: "text" },
          { name: "email", type: "email" },
          { name: "url", type: "url" },
          { name: "data", type: "json" },
          { name: "tags", type: "select", values: ["a", "b"], maxSelect: 2 },
        ],
      });
      const unicode = "/collections/unicode/records";
      const invalid = { code: "validation_invalid_value" };
      for (const lone of ["\ud800", "a\udfffb", "\udc00\ud800"]) {
        for (const body of [
          { text: lone },
          { email: `ann${lone}@example.com` },
          { url: `https://example.com/${lone}` },
          { data: lone },
          { data: { nested: [{ deep: lone }] } },
          { data: { [lone]: 1 } },
          { tags: [lone] },
          { "tags+": lone },
        ]) {
          const key = Object.keys(body)[0]?.replace("+", "") as string;
          for (const who of ["ann", "admin"] as const) {
            const reply = await as(who, "POST", unicode, body);
            expect(reply.status).toBe(400);
            expect(reply.body.data).toMatchObject({ [key]: invalid });
          }
        }
      }
      const created = await ok(as("ann", "POST", unicode, { text: "😀" }));
      const id = created.body.id as string;
      expect(
        (await as("ann", "PATCH", `${unicode}/${id}`, { text: "\ud83d" })).body
          .data,
      ).toMatchObject({ text: invalid });
      // A surrogate pair is one character, stored and served as sent.
      const pair = await ok(
        as("ann", "PATCH", `${unicode}/${id}`, {
          text: "😀",
          data: { "😀": ["😀"] },
        }),
      );
      expect(pair.body).toMatchObject({
        text: "😀",
        data: { "😀": ["😀"] },
      });
      // Collections are stored too, so their names, values and rules are checked.
      for (const body of [
        { name: "\ud800" },
        { name: "lone", listRule: '"\ud800" = ""' },
        {
          name: "lone",
          fields: [{ name: "s", type: "select", values: ["\ud800"] }],
        },
      ]) {
        const reply = await as("admin", "POST", "/collections", body);
        expect(reply.status).toBe(400);
      }
      const password = await as(
        "admin",
        "PATCH",
        `/collections/users/records/${ids.ann}`,
        {
          password: "password12345678\ud800",
          passwordConfirm: "password12345678\ud800",
        },
      );
      expect(password.body.data).toMatchObject({ password: invalid });
    });

    it("limits JSON nesting, iteratively, and round-trips everything storable", async () => {
      const nest = (depth: number): unknown => {
        let value: unknown = "leaf";
        for (let i = 0; i < depth; i++) value = [value];
        return value;
      };
      expect(
        (await as("ann", "POST", records, { data: nest(1000) })).body.data,
      ).toMatchObject({
        data: { code: "validation_invalid_value" },
      });
      // A hostile raw body nested far deeper than any JSON encoder would write.
      const hostile = await call(nextbase, "POST", records, {
        token: tokens.ann,
        body: `{"data":${"[".repeat(200_000)}${"]".repeat(200_000)}}`,
      });
      expect(hostile.status).toBe(400);
      // Parsed, as a request body is: "__proto__" becomes an own key, not a prototype.
      const data = JSON.parse(
        `{"deep":${JSON.stringify(nest(60))},"__proto__":{"polluted":true},"emoji":"😀","big":1.7976931348623157e308}`,
      ) as Record<string, unknown>;
      const created = await ok(as("ann", "POST", records, { data }));
      const stored = created.body.data as Record<string, unknown>;
      expect(Object.hasOwn(stored, "__proto__")).toBe(true);
      expect(stored.deep).toEqual(data.deep);
      expect([stored.emoji, stored.big]).toEqual([
        "😀",
        1.7976931348623157e308,
      ]);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("keeps dates within what Postgres stores", async () => {
      expect(
        (await as("ann", "POST", records, { when: "-271821-04-20T00:00:00Z" }))
          .body.data,
      ).toMatchObject({
        when: { code: "validation_invalid_type" },
      });
      const latest = await ok(
        as("ann", "POST", records, { when: "+275760-09-13T00:00:00.000Z" }),
      );
      expect(latest.body.when).toBe("+275760-09-13T00:00:00.000Z");
      const ancient = await ok(
        as("ann", "POST", records, { when: "-004712-01-01T00:00:00.000Z" }),
      );
      expect(ancient.body.when).toBe("-004712-01-01T00:00:00.000Z");
    });

    it("compares dates with extended years by time, not as text", async () => {
      const bounds = { min: "-000500-01-01", max: "9999-12-31" };
      // As text, "-000100" sorts before "-000500" and "+010000" before "9999".
      expect(
        (
          await as("admin", "POST", "/collections", {
            name: "inverted",
            fields: [
              {
                name: "when",
                type: "date",
                min: "+010000-01-01",
                max: "2000-01-01",
              },
            ],
          })
        ).body.data,
      ).toMatchObject({
        fields: { 0: { min: { code: "validation_out_of_range" } } },
      });
      await newCollection({
        name: "bounded",
        listRule: "",
        viewRule: "",
        createRule: "",
        fields: [
          { name: "when", type: "date", ...bounds },
          {
            name: "bc",
            type: "date",
            min: "-000100-01-01",
            max: "-000050-01-01",
          },
        ],
      });
      const bounded = "/collections/bounded/records";
      const inRange = await ok(
        as("ann", "POST", bounded, {
          when: "-000100-01-01T00:00:00Z",
          bc: "-000075-06-01T00:00:00Z",
        }),
      );
      expect(inRange.body).toMatchObject({
        when: "-000100-01-01T00:00:00.000Z",
        bc: "-000075-06-01T00:00:00.000Z",
      });
      for (const when of [
        "+010000-01-01T00:00:00Z",
        "-000600-01-01T00:00:00Z",
        "+275760-09-13T00:00:00Z",
      ]) {
        expect(
          (await as("ann", "POST", bounded, { when })).body.data,
        ).toMatchObject({ when: { code: "validation_out_of_range" } });
      }
    });

    it("counts text length in characters, not UTF-16 units", async () => {
      expect(
        (await as("ann", "POST", records, { text: "😀😀😀" })).status,
      ).toBe(200);
      expect(
        (await as("ann", "POST", records, { text: "😀😀😀😀" })).status,
      ).toBe(400);
    });

    it("handles numbers at the edges of double precision", async () => {
      expect((await ok(as("ann", "POST", records, { n: "1e3" }))).body.n).toBe(
        1000,
      );
      expect((await ok(as("ann", "POST", records, { n: 5e-324 }))).body.n).toBe(
        5e-324,
      );
      expect((await as("ann", "POST", records, { n: "Infinity" })).status).toBe(
        400,
      );
      // Modifiers can overflow a double: the sum is no number Postgres serves back.
      const big = await ok(as("ann", "POST", records, { n: 1.7e308 }));
      const path = `${records}/${big.body.id}`;
      for (const body of [{ "n+": 1.7e308 }, { "n-": 1.7e308, n: -1.7e308 }]) {
        expect((await as("ann", "PATCH", path, body)).body.data).toMatchObject({
          n: { code: "validation_invalid_value" },
        });
      }
      expect(
        (await as("ann", "POST", records, { n: -1.7e308, "n-": 1.7e308 })).body
          .data,
      ).toMatchObject({ n: { code: "validation_invalid_value" } });
      expect((await ok(as("ann", "GET", path))).body.n).toBe(1.7e308);
      expect(
        (
          await as(
            "ann",
            "GET",
            `${records}?filter=${encodeURIComponent(`n > ${"9".repeat(400)}`)}`,
          )
        ).status,
      ).toBe(400);
    });

    it("treats fields named like Object.prototype members as ordinary fields", async () => {
      const created = await ok(
        as("ann", "POST", records, { constructor: "a", toString: "b" }),
      );
      expect(created.body).toMatchObject({ constructor: "a", toString: "b" });
      const found = await as(
        "ann",
        "GET",
        `${records}?filter=${encodeURIComponent('constructor = "a" && toString = "b"')}`,
      );
      expect((found.body.items as unknown[]).length).toBe(1);
      const bare = await ok(as("ann", "POST", records, {}));
      expect(bare.body).toMatchObject({ constructor: "", toString: "" });
    });
  });

  describe("large data", () => {
    beforeAll(async () => {
      ids.posts = await newCollection({
        name: "posts",
        listRule: "",
        viewRule: "",
        fields: [
          { id: "titleaaaaa", name: "title", type: "text" },
          { name: "author", type: "relation", collectionId: ids.users },
          {
            name: "refs",
            type: "relation",
            collectionId: ids.users,
            maxSelect: 100_000,
          },
          { name: "created", type: "autodate" },
        ],
        indexes: [
          { name: "posts_title", fields: ["titleaaaaa"] },
          // Installs pg_trgm on first use.
          { name: "posts_title_trgm", type: "trigram", fields: ["titleaaaaa"] },
        ],
      });
      await newCollection({
        name: "comments",
        listRule: "",
        viewRule: "",
        fields: [{ name: "post", type: "relation", collectionId: ids.posts }],
      });
      // 70k users: more related ids than Postgres allows parameters in one statement.
      await sql(`
        INSERT INTO nextbase.users (id, email, password, "tokenKey", name)
        SELECT lpad(i::text, 15, '0'), 'u' || i || '@example.com', 'x', 'key-' || i, 'user ' || i
        FROM generate_series(1, 70000) AS i`);
      await sql(`
        INSERT INTO nextbase.posts (id, title, author, refs, created)
        SELECT 'p' || lpad(i::text, 14, '0'), 'post ' || i, lpad((i % 100 + 1)::text, 15, '0'), '{}',
          now() - make_interval(secs => i)
        FROM generate_series(1, 20000) AS i`);
      await sql(`
        INSERT INTO nextbase.comments (id, post)
        SELECT 'c' || lpad(i::text, 14, '0'), 'p' || lpad((i % 2000 + 1)::text, 14, '0')
        FROM generate_series(1, 6000) AS i`);
      await sql(
        `UPDATE nextbase.posts SET refs = (SELECT array_agg(id) FROM nextbase.users WHERE id ~ '^[0-9]+$') WHERE id = 'p00000000000001'`,
      );
      await sql("ANALYZE nextbase.users");
      await sql("ANALYZE nextbase.posts");
      await sql("ANALYZE nextbase.comments");
    });

    it("pages through large collections", async () => {
      const page = await ok(
        as(
          "ann",
          "GET",
          "/collections/posts/records?perPage=1000&page=20&sort=title&fields=id",
        ),
      );
      expect(page.body).toMatchObject({
        page: 20,
        perPage: 1000,
        totalItems: 20000,
        totalPages: 20,
      });
      expect((page.body.items as unknown[]).length).toBe(1000);
      const skipped = await ok(
        as("ann", "GET", "/collections/posts/records?skipTotal=1&perPage=5"),
      );
      expect(skipped.body.totalItems).toBe(-1);
    });

    it("caps back-relations at 1000 per record in the query itself", async () => {
      await sql(`
        INSERT INTO nextbase.comments (id, post)
        SELECT 'x' || lpad(i::text, 14, '0'), 'p00000000000001'
        FROM generate_series(1, 1500) AS i`);
      try {
        const reply = await ok(
          as(
            "ann",
            "GET",
            "/collections/posts/records?filter=" +
              encodeURIComponent(
                'id = "p00000000000001" || id = "p00000000000002"',
              ) +
              "&sort=id&expand=comments_via_post&fields=id,expand.comments_via_post.id",
          ),
        );
        const [first, second] = reply.body.items as {
          expand: { comments_via_post: { id: string }[] };
        }[];
        const ids = first?.expand.comments_via_post.map((c) => c.id) ?? [];
        expect(ids).toHaveLength(1000);
        expect(ids).toEqual([...ids].sort());
        // Another record's related records are counted separately.
        expect(second?.expand.comments_via_post.length).toBe(3);
      } finally {
        await sql("DELETE FROM nextbase.comments WHERE id LIKE 'x%'");
      }
    });

    it("expands more related records than Postgres allows parameters", async () => {
      const reply = await ok(
        as(
          "ann",
          "GET",
          "/collections/posts/records/p00000000000001?expand=refs&fields=expand.refs.id",
        ),
      );
      expect((reply.body.expand as { refs: unknown[] }).refs.length).toBe(
        70000,
      );
    });

    async function plan(
      collectionName: string,
      filter: string,
      mode: "filter" | "rule",
      principal: Principal,
    ): Promise<string> {
      const collections = await loadCollections(t.db);
      const schema = new Schema(0, collections);
      const collection = schema.get(collectionName);
      const condition = compileFilter(filter, collection, "t0", {
        schema,
        principal,
        request: { method: "GET", query: {}, headers: {}, body: {} },
        mode,
      });
      if (!condition) throw new Error("empty filter");
      const query = t.db
        .select("t0.id")
        .from(`nextbase.${collectionName} t0`)
        .where(condition)
        .build();
      const [row] = await t.db
        .newQuery(`EXPLAIN (FORMAT JSON) ${query.sql}`)
        .bind(query.params)
        .column();
      return JSON.stringify(row);
    }

    it("serves contains filters from trigram indexes and the default sort from the created index", async () => {
      const users = (await loadCollections(t.db)).find(
        (c) => c.name === "users",
      ) as AuthCollection;
      const ann: Principal = {
        superuser: false,
        collection: users,
        record: { id: "000000000000007" },
      };
      expect(
        await plan("posts", 'title ~ "post 12345"', "filter", ann),
      ).toContain('"Index Name":"posts_title_trgm"');

      const posts = (await loadCollections(t.db)).find(
        (c) => c.name === "posts",
      );
      const created = posts?.fields.find((f) => f.name === "created")?.id;
      const query = t.db
        .select("t0.*")
        .from("nextbase.posts t0")
        .orderBy("t0.created DESC", "t0.id DESC")
        .limit(30)
        .build();
      const [row] = await t.db
        .newQuery(`EXPLAIN (FORMAT JSON) ${query.sql}`)
        .bind(query.params)
        .column();
      expect(JSON.stringify(row)).toContain(
        `"Index Name":"_${posts?.id}_${created}_sort"`,
      );

      const page = await ok(
        as("ann", "GET", "/collections/posts/records?perPage=3&fields=id"),
      );
      expect((page.body.items as { id: string }[]).map((p) => p.id)).toEqual([
        "p00000000000001",
        "p00000000000002",
        "p00000000000003",
      ]);
    });

    it("serves equality filters and rules from indexes", async () => {
      const posts = (await loadCollections(t.db)).find(
        (c) => c.name === "posts",
      );
      const authorField = posts?.fields.find((f) => f.name === "author")?.id;
      const users = (await loadCollections(t.db)).find(
        (c) => c.name === "users",
      ) as AuthCollection;
      const ann: Principal = {
        superuser: false,
        collection: users,
        record: { id: "000000000000007" },
      };

      expect(
        await plan("posts", 'title = "post 123"', "filter", ann),
      ).toContain('"Index Name":"posts_title"');
      expect(
        await plan("posts", "author = @request.auth.id", "rule", ann),
      ).toContain(`"Index Name":"_${posts?.id}_${authorField}"`);
      const comments = (await loadCollections(t.db)).find(
        (c) => c.name === "comments",
      );
      const postField = comments?.fields.find((f) => f.name === "post")?.id;
      expect(
        await plan("posts", "comments_via_post:length > 2", "filter", ann),
      ).toContain(`"Index Name":"_${comments?.id}_${postField}"`);
    });
  });

  describe("protections", () => {
    it("refuses to delete the last superuser", async () => {
      const [admin] = (
        await as("admin", "GET", "/collections/_superusers/records")
      ).body.items as { id: string }[];
      expect(
        (
          await as(
            "admin",
            "DELETE",
            `/collections/_superusers/records/${admin?.id}`,
          )
        ).status,
      ).toBe(400);
      await nextbase.createSuperuser("second@example.com", "second password");
      const second = (
        (await as("admin", "GET", "/collections/_superusers/records")).body
          .items as { id: string; email: string }[]
      ).find((s) => s.email === "second@example.com");
      expect(
        (
          await as(
            "admin",
            "DELETE",
            `/collections/_superusers/records/${second?.id}`,
          )
        ).status,
      ).toBe(204);
      expect(
        (
          await as(
            "admin",
            "DELETE",
            `/collections/_superusers/records/${admin?.id}`,
          )
        ).status,
      ).toBe(400);
    });

    it("does not let callers sort by emails they cannot see", async () => {
      expect(
        (await as("bob", "GET", "/collections/users/records?sort=email"))
          .status,
      ).toBe(400);
      expect(
        (
          await as(
            "admin",
            "GET",
            "/collections/users/records?sort=email&perPage=1",
          )
        ).status,
      ).toBe(200);
    });

    it("rejects rules comparing multi-valued request bodies when saved", async () => {
      await newCollection({
        name: "tagged",
        fields: [
          { name: "tags", type: "select", values: ["a", "b"], maxSelect: 2 },
        ],
      });
      expect(
        await as("admin", "PATCH", "/collections/tagged", {
          createRule: '@request.body.tags = "a"',
        }),
      ).toMatchObject({
        status: 400,
        body: { data: { createRule: { code: "validation_invalid_rule" } } },
      });
    });
  });
});
