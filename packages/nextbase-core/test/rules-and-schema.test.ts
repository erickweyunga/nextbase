import type { AuthCollection, Collection } from "@nextbasejs/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { migrate } from "../src/db/migrations.ts";
import { NextBase } from "../src/index.ts";
import { call, type Reply } from "./http.ts";
import { createTestDatabase, type TestDatabase } from "./postgres.ts";

const PASSWORD = "password12345678";

describe("rules and schema changes", () => {
  let t: TestDatabase;
  let nextbase: NextBase;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};

  const as = (
    who: string | undefined,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Reply> =>
    call(nextbase, method, path, {
      token: who ? tokens[who] : undefined,
      body,
    });
  const admin = (method: string, path: string, body?: unknown) =>
    as("admin", method, path, body);
  const ok = async (reply: Promise<Reply>): Promise<Reply> => {
    const r = await reply;
    if (r.status >= 300)
      throw new Error(`${r.status}: ${JSON.stringify(r.body)}`);
    return r;
  };
  const login = async (collection: string, email: string): Promise<string> =>
    (
      await ok(
        call(
          nextbase,
          "POST",
          `/collections/${collection}/auth-with-password`,
          {
            body: { identity: email, password: PASSWORD },
          },
        ),
      )
    ).body.token as string;
  const fieldId = async (collection: string, name: string): Promise<string> => {
    const c = (await ok(admin("GET", `/collections/${collection}`)))
      .body as unknown as Collection;
    return c.fields.find((f) => f.name === name)?.id as string;
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    nextbase = new NextBase({ database: t.pool });
    await nextbase.createSuperuser("admin@example.com", PASSWORD);
    tokens.admin = await login("_superusers", "admin@example.com");
    ids.users = (
      await ok(
        admin("POST", "/collections", {
          name: "users",
          type: "auth",
          createRule: "",
          fields: [
            { name: "status", type: "text" },
            { name: "secret", type: "text", hidden: true },
            {
              name: "roles",
              type: "select",
              values: ["admin", "editor", "viewer"],
              maxSelect: 3,
            },
            { name: "prefs", type: "json" },
          ],
        }),
      )
    ).body.id as string;
    const people = {
      ann: { status: "active", secret: "s1", roles: ["admin", "editor"] },
      bob: { status: "banned", secret: "s2", roles: ["viewer"] },
      cy: { status: "active", secret: "", roles: [] },
    };
    for (const [name, values] of Object.entries(people)) {
      const reply = await ok(
        as(undefined, "POST", "/collections/users/records", {
          email: `${name}@example.com`,
          password: PASSWORD,
          passwordConfirm: PASSWORD,
          ...values,
        }),
      );
      ids[name] = reply.body.id as string;
      tokens[name] = await login("users", `${name}@example.com`);
    }
    await ok(
      admin("POST", "/collections", {
        name: "notes",
        listRule: "",
        viewRule: "",
        fields: [
          { name: "title", type: "text" },
          {
            name: "tags",
            type: "select",
            values: ["admin", "x"],
            maxSelect: 2,
          },
        ],
      }),
    );
    for (const title of ["50% off", "a\\b"]) {
      await ok(admin("POST", "/collections/notes/records", { title }));
    }
  });
  afterAll(async () => {
    // Log entries still waiting would be written to an ended pool.
    await nextbase.flush();
    await t.close();
  });

  describe("~ with a pattern", () => {
    it("refuses a pattern ending in a lone backslash with a 400", async () => {
      // The filter `title ~ "50%\\"` has the value `50%\`.
      const filter = encodeURIComponent('title ~ "50%\\\\"');
      const reply = await as(
        undefined,
        "GET",
        `/collections/notes/records?filter=${filter}`,
      );
      expect(reply.status).toBe(400);
      expect(reply.body.message).toMatch(/backslash/);
      // An escaped backslash is a literal one.
      const escaped = encodeURIComponent('title ~ "a\\\\\\\\b%"');
      const found = await ok(
        as(undefined, "GET", `/collections/notes/records?filter=${escaped}`),
      );
      expect((found.body.items as unknown[]).length).toBe(1);
    });

    it("refuses a request value used as such a pattern with a 400", async () => {
      await ok(
        admin("POST", "/collections", {
          name: "patterns",
          listRule: '"50% off" ~ @request.query.q',
        }),
      );
      const q = encodeURIComponent("50%\\");
      const reply = await as(
        undefined,
        "GET",
        `/collections/patterns/records?q=${q}`,
      );
      expect(reply.status).toBe(400);
      expect(
        (await as(undefined, "GET", "/collections/patterns/records?q=50%25"))
          .status,
      ).toBe(200);
    });

    it("refuses a stored rule whose own pattern ends in a lone backslash", async () => {
      const reply = await admin("POST", "/collections", {
        name: "badPattern",
        fields: [{ name: "title", type: "text" }],
        listRule: 'title ~ "%\\\\"',
      });
      expect(reply.status).toBe(400);
      expect(reply.body.data).toMatchObject({
        listRule: { code: "validation_invalid_rule" },
      });
    });
  });

  describe("@request.auth fields", () => {
    it("refuses a rule naming a field no auth collection has", async () => {
      const reply = await admin("POST", "/collections", {
        name: "typo",
        listRule: '@request.auth.stauts != "banned"',
      });
      expect(reply.status).toBe(400);
      expect(reply.body.data).toMatchObject({
        listRule: {
          code: "validation_invalid_rule",
          message: expect.stringMatching(/stauts/),
        },
      });
      for (const rule of [
        "@request.auth.password = ''",
        "@request.auth.tokenKey = ''",
        "@request.auth.status:lower = 'x'",
      ]) {
        expect(
          (
            await admin("POST", "/collections", {
              name: "typo",
              listRule: rule,
            })
          ).status,
        ).toBe(400);
      }
    });

    it("accepts system fields of auth collections", async () => {
      await ok(
        admin("POST", "/collections", {
          name: "systemFields",
          listRule:
            '@request.auth.id != "" && @request.auth.emailVerified = false && @request.auth.collectionName = "users" && @request.auth.email != ""',
        }),
      );
      const reply = await ok(
        as("ann", "GET", "/collections/systemFields/records"),
      );
      expect(reply.status).toBe(200);
    });

    it("refuses renaming or deleting an auth field a rule reads", async () => {
      await ok(
        admin("POST", "/collections", {
          name: "gated",
          listRule: '@request.auth.status != "banned"',
        }),
      );
      const status = await fieldId("users", "status");
      const users = (await ok(admin("GET", "/collections/users")))
        .body as unknown as Collection;
      const renamed = await admin("PATCH", "/collections/users", {
        fields: users.fields.map((f) =>
          f.id === status ? { ...f, name: "state" } : f,
        ),
      });
      expect(renamed.status).toBe(400);
      expect(renamed.body.message).toMatch(/listRule of gated/);
      const deleted = await admin("PATCH", "/collections/users", {
        fields: users.fields.filter((f) => f.id !== status),
      });
      expect(deleted.status).toBe(400);
      expect(deleted.body.message).toMatch(/listRule of gated/);
      // Still enforced.
      expect(
        (await as("bob", "GET", "/collections/gated/records")).body,
      ).toEqual(expect.objectContaining({ items: [] }));
    });

    it("reads hidden fields of the signed-in record, as rules read hidden fields of any record", async () => {
      await ok(
        admin("POST", "/collections", {
          name: "secrets",
          viewRule: '@request.auth.secret = "s1"',
          listRule: "",
        }),
      );
      const created = await ok(
        admin("POST", "/collections/secrets/records", {}),
      );
      const path = `/collections/secrets/records/${created.body.id}`;
      expect((await as("ann", "GET", path)).status).toBe(200);
      expect((await as("bob", "GET", path)).status).toBe(404);
      expect((await as(undefined, "GET", path)).status).toBe(404);
    });

    it("compares a field with several values like a field of the record", async () => {
      await ok(
        admin("POST", "/collections", {
          name: "adminOnly",
          listRule: '@request.auth.roles ?= "admin"',
          viewRule: '@request.auth.roles = "admin"',
          createRule: "@request.auth.roles:length >= 2",
          updateRule: '@request.auth.roles != ""',
        }),
      );
      const record = await ok(
        admin("POST", "/collections/adminOnly/records", {}),
      );
      const count = async (who: string | undefined): Promise<number> =>
        (
          (await ok(as(who, "GET", "/collections/adminOnly/records"))).body
            .items as unknown[]
        ).length;
      expect(await count("ann")).toBe(1);
      expect(await count("bob")).toBe(0);
      expect(await count("cy")).toBe(0);
      expect(await count(undefined)).toBe(0);
      // Every value must be "admin", and ann is also an editor.
      const path = `/collections/adminOnly/records/${record.body.id}`;
      expect((await as("ann", "GET", path)).status).toBe(404);
      // Written, though the caller cannot view the result.
      expect(
        (await as("ann", "POST", "/collections/adminOnly/records", {})).status,
      ).toBe(204);
      expect(
        (await as("bob", "POST", "/collections/adminOnly/records", {})).status,
      ).toBe(400);
      expect((await as("bob", "PATCH", path, {})).status).toBe(204);
      expect((await as("cy", "PATCH", path, {})).status).toBe(404);
    });

    it("matches a field with several values against a field of the record", async () => {
      await ok(
        admin("POST", "/collections", {
          name: "tagged",
          listRule: "tags ?= @request.auth.roles",
          fields: [
            {
              name: "tags",
              type: "select",
              values: ["admin", "viewer"],
              maxSelect: 2,
            },
          ],
        }),
      );
      await ok(
        admin("POST", "/collections/tagged/records", { tags: ["viewer"] }),
      );
      const count = async (who: string): Promise<number> =>
        (
          (await ok(as(who, "GET", "/collections/tagged/records"))).body
            .items as unknown[]
        ).length;
      expect(await count("ann")).toBe(0);
      expect(await count("bob")).toBe(1);
    });

    it("refuses comparing a JSON field of the signed-in record", async () => {
      const reply = await admin("POST", "/collections", {
        name: "jsonAuth",
        listRule: '@request.auth.prefs = "x"',
      });
      expect(reply.status).toBe(400);
      expect(reply.body.data).toMatchObject({
        listRule: { message: expect.stringMatching(/JSON/) },
      });
    });
  });

  describe("collection ids and names", () => {
    it("refuses a name that is another collection's id, in any case", async () => {
      // An id that is also a valid name.
      const id = "victim000000000";
      await ok(admin("POST", "/collections", { id, name: "victim" }));
      for (const name of [id, id.toUpperCase()]) {
        const reply = await admin("POST", "/collections", { name });
        expect(reply.status).toBe(400);
        expect(reply.body.data).toMatchObject({
          name: { code: "validation_not_unique" },
        });
      }
      const other = await ok(admin("POST", "/collections", { name: "other" }));
      const renamed = await admin("PATCH", `/collections/${other.body.id}`, {
        name: id,
      });
      expect(renamed.status).toBe(400);
    });

    it("refuses an id that is another collection's name, in any case", async () => {
      await ok(admin("POST", "/collections", { name: "Abcdefghijklmno" }));
      const reply = await admin("POST", "/collections", {
        id: "abcdefghijklmno",
        name: "imposter",
      });
      expect(reply.status).toBe(400);
      expect(reply.body.data).toMatchObject({
        id: { code: "validation_not_unique" },
      });
    });
  });

  it("refuses an index over values too large to index with a 400", async () => {
    await ok(
      admin("POST", "/collections", {
        name: "essays",
        fields: [{ name: "body", type: "text", max: 100_000 }],
      }),
    );
    // Different three-byte characters, which do not compress, are over the
    // most an index entry takes.
    const long = Array.from({ length: 3000 }, (_, i) =>
      String.fromCharCode(0x4e00 + ((i * 7919) % 20_000)),
    ).join("");
    await ok(admin("POST", "/collections/essays/records", { body: long }));
    const reply = await admin("PATCH", "/collections/essays", {
      indexes: [
        { name: "essays_body", fields: [await fieldId("essays", "body")] },
      ],
    });
    expect(reply.status).toBe(400);
    expect(reply.body.message).toMatch(/too large to index/);
    expect(reply.body.data).toMatchObject({
      indexes: { 0: { fields: { code: "validation_length_out_of_range" } } },
    });
  });

  it("reserves the names of filter keywords for fields", async () => {
    for (const name of ["true", "false", "null"]) {
      const reply = await admin("POST", "/collections", {
        name: "keywords",
        fields: [{ name, type: "text" }],
      });
      expect(reply.status).toBe(400);
      expect(reply.body.data).toMatchObject({
        fields: { 0: { name: { code: "validation_reserved_name" } } },
      });
    }
  });

  // Last: without the fix, the deletion breaks every later schema change.
  it("refuses deleting a collection that rules of others read with @collection", async () => {
    await ok(
      admin("POST", "/collections", {
        name: "teams",
        fields: [{ name: "name", type: "text" }],
      }),
    );
    await ok(
      admin("POST", "/collections", {
        name: "boards",
        listRule: '@collection.teams.name = "x"',
      }),
    );
    const reply = await admin("DELETE", "/collections/teams");
    expect(reply.status).toBe(400);
    expect(reply.body.message).toMatch(/listRule of boards/);
    // Other schema changes still work.
    await ok(admin("POST", "/collections", { name: "afterTeams" }));
  });
});

describe("migrating auth collections with clashing user fields", () => {
  let t: TestDatabase;

  beforeEach(async () => {
    t = await createTestDatabase();
  });
  afterEach(() => t.close());

  it("renames user fields named phone and phoneVerified before adding the system ones", async () => {
    const before = new NextBase({ database: t.pool });
    const admin = before.client({ superuser: true });
    await admin.collections.create({
      name: "members",
      type: "auth",
      fields: [
        { name: "mobile", type: "text" },
        { name: "mobileChecked", type: "bool" },
      ],
    });
    const members = await admin.collections.getOne("members");
    await admin.collections.create({
      name: "calls",
      type: "base",
      fields: [
        { name: "caller", type: "relation", collectionId: members.id },
        { name: "phone", type: "text" },
      ],
    });
    const record = await admin.collection("members").create({
      email: "ann@example.com",
      password: PASSWORD,
      passwordConfirm: PASSWORD,
      mobile: "0754 000 001",
      mobileChecked: true,
    });
    if (!record) throw new Error("A superuser views every record.");

    // Rewinds to a release before 0006, where `phone` and `phoneVerified`
    // were ordinary user fields.
    await t.pool.query(`
      DROP TABLE nextbase._phone_codes;
      ALTER TABLE nextbase.members DROP COLUMN "phone", DROP COLUMN "phoneVerified";
      ALTER TABLE nextbase.members RENAME COLUMN "mobile" TO "phone";
      ALTER TABLE nextbase.members RENAME COLUMN "mobileChecked" TO "phoneVerified";
      DELETE FROM nextbase._migrations WHERE name = '0006_phone';
    `);
    await t.pool.query(
      `UPDATE nextbase._collections
       SET fields = (
             SELECT jsonb_agg(CASE f->>'name'
               WHEN 'mobile' THEN jsonb_set(f, '{name}', '"phone"')
               WHEN 'mobileChecked' THEN jsonb_set(f, '{name}', '"phoneVerified"')
               ELSE f END)
             FROM jsonb_array_elements(fields) f
             WHERE f->>'id' NOT IN ('_phone', '_phoneVerified')),
           options = (options - 'phoneSignIn') || jsonb_build_object('authRule', $1::text),
           view_rule = $2
       WHERE name = 'members'`,
      ['phone != "" && phoneVerified = true', "@request.auth.phone = phone"],
    );
    await t.pool.query(
      "UPDATE nextbase._collections SET list_rule = $1 WHERE name = 'calls'",
      ['caller.phone != "" && phone != ""'],
    );

    await migrate(t.db);
    const after = new NextBase({ database: t.pool }).client({
      superuser: true,
    });
    const upgraded = (await after.collections.getOne(
      "members",
    )) as AuthCollection;
    const names = upgraded.fields.map((f) => [f.id, f.name, f.system]);
    expect(names).toContainEqual(["_phone", "phone", true]);
    expect(names).toContainEqual(["_phoneVerified", "phoneVerified", true]);
    expect(names).toContainEqual([expect.any(String), "user_phone", false]);
    expect(names).toContainEqual([
      expect.any(String),
      "user_phoneVerified",
      false,
    ]);
    expect(upgraded.authRule).toBe(
      'user_phone != "" && user_phoneVerified = true',
    );
    expect(upgraded.viewRule).toBe("@request.auth.user_phone = user_phone");
    expect((await after.collections.getOne("calls")).listRule).toBe(
      'caller.user_phone != "" && phone != ""',
    );
    const row = await after.collection("members").getOne(record.id);
    expect(row).toMatchObject({
      user_phone: "0754 000 001",
      user_phoneVerified: true,
      phone: "",
      phoneVerified: false,
    });
  });

  it("renames a user field named emailVerified before renaming verified", async () => {
    const before = new NextBase({ database: t.pool });
    const admin = before.client({ superuser: true });
    await admin.collections.create({
      name: "people",
      type: "auth",
      fields: [{ name: "confirmed", type: "bool" }],
    });
    const record = await admin.collection("people").create({
      email: "bob@example.com",
      password: PASSWORD,
      passwordConfirm: PASSWORD,
      emailVerified: true,
      confirmed: false,
    });
    if (!record) throw new Error("A superuser views every record.");

    // Rewinds to a release before 0007, with a user field `emailVerified`.
    await t.pool.query(`
      ALTER TABLE nextbase.people RENAME COLUMN "emailVerified" TO "verified";
      ALTER TABLE nextbase.people RENAME COLUMN "confirmed" TO "emailVerified";
      DELETE FROM nextbase._migrations WHERE name = '0007_email_verified';
    `);
    await t.pool.query(
      `UPDATE nextbase._collections
       SET fields = (
             SELECT jsonb_agg(CASE
               WHEN f->>'id' = '_verified' THEN jsonb_set(f, '{name}', '"verified"')
               WHEN f->>'name' = 'confirmed' THEN jsonb_set(f, '{name}', '"emailVerified"')
               ELSE f END)
             FROM jsonb_array_elements(fields) f),
           view_rule = $1
       WHERE name = 'people'`,
      ["verified = true && emailVerified = false"],
    );

    await migrate(t.db);
    const after = new NextBase({ database: t.pool }).client({
      superuser: true,
    });
    const upgraded = await after.collections.getOne("people");
    expect(upgraded.viewRule).toBe(
      "emailVerified = true && user_emailVerified = false",
    );
    expect(await after.collection("people").getOne(record.id)).toMatchObject({
      emailVerified: true,
      user_emailVerified: false,
    });
  });
});
