import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextBase } from "../src/index.ts";
import { call } from "./http.ts";
import { createTestDatabase, type TestDatabase } from "./postgres.ts";

/** Wraps `pool` to count the queries sent to Postgres, including those inside transactions. */
function counting(pool: pg.Pool): { pool: pg.Pool; trips: () => number } {
  let count = 0;
  const countQueries = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        if (prop === "query") {
          return (...args: unknown[]) => {
            count++;
            return value.apply(target, args);
          };
        }
        if (prop === "connect") {
          return async () => countQueries(await value.apply(target));
        }
        return value.bind(target);
      },
    });
  return {
    pool: countQueries(pool),
    trips: () => {
      const n = count;
      count = 0;
      return n;
    },
  };
}

describe("round trips per request", () => {
  let t: TestDatabase;
  let nextbase: NextBase;
  let token: string;
  let noteId: string;
  let memberId: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    nextbase = new NextBase({ database: t.pool });
    await nextbase.createSuperuser("admin@example.com", "admin password 123");
    const admin = nextbase.client({ superuser: true });
    const members = await admin.collections.create({
      name: "members",
      type: "auth",
      listRule: "",
      viewRule: "",
    });
    await admin.collections.create({
      name: "posts",
      listRule: "",
      viewRule: "",
      createRule: '@request.auth.id != ""',
      updateRule: "author = @request.auth.id",
      deleteRule: "author = @request.auth.id",
      fields: [
        { name: "title", type: "text" },
        {
          name: "author",
          type: "relation",
          collectionId: members.id,
          maxSelect: 1,
        },
      ],
    });
    await admin.collections.create({
      name: "notes",
      listRule: "",
      viewRule: "",
      fields: [{ name: "title", type: "text" }],
    });
    for (const title of ["one", "two", "three"]) {
      const note = await admin.collection("notes").create({ title });
      noteId = note?.id ?? "";
    }
    const member = await admin.collection("members").create({
      email: "robin@example.com",
      password: "password 123 456",
      passwordConfirm: "password 123 456",
    });
    memberId = member?.id ?? "";
    const signIn = await call(
      nextbase,
      "POST",
      "/collections/members/auth-with-password",
      {
        body: { identity: "robin@example.com", password: "password 123 456" },
      },
    );
    token = signIn.body.token as string;
  });

  afterAll(() => t.close());

  /**
   * A second NextBase, like another server process. Its first request is
   * made here, because that one also loads the schema and checks that a
   * superuser exists.
   */
  const another = async () => {
    const { pool, trips } = counting(t.pool);
    const other = new NextBase({ database: pool });
    await call(other, "GET", "/collections/notes/records");
    trips();
    return { other, trips };
  };

  it("takes three for server code: begin with the checks, the page with its total, commit", async () => {
    const { other, trips } = await another();
    const notes = other.client({ superuser: true }).collection("notes");
    const list = await notes.getList();
    expect(list.totalItems).toBe(3);
    expect(list.items.map((n) => n.title).sort()).toEqual([
      "one",
      "three",
      "two",
    ]);
    expect(list.items[0]).not.toHaveProperty("_total");
    expect(trips()).toBe(3);

    expect((await notes.getOne(noteId)).title).toBe("three");
    expect(trips()).toBe(3);

    const anonymous = await other.client().collection("notes").getList();
    expect(anonymous.totalItems).toBe(3);
    expect(trips()).toBe(3);
  });

  it("takes one more with a session, to check it", async () => {
    const { other, trips } = await another();
    const reply = await call(other, "GET", "/collections/notes/records", {
      token,
    });
    expect(reply.body.totalItems).toBe(3);
    expect(trips()).toBe(4);
  });

  it("counts a page past the end with one more query", async () => {
    const { other, trips } = await another();
    const notes = other.client({ superuser: true }).collection("notes");
    const page = await notes.getList(2, 2);
    expect([page.items.length, page.totalItems, page.totalPages]).toEqual([
      1, 3, 2,
    ]);
    expect(trips()).toBe(3);

    const past = await notes.getList(5, 2);
    expect([past.items.length, past.totalItems, past.totalPages]).toEqual([
      0, 3, 2,
    ]);
    expect(trips()).toBe(4);

    const none = await notes.getList(1, 30, { filter: 'title = "four"' });
    expect([none.totalItems, none.totalPages]).toEqual([0, 0]);
    const skipped = await notes.getList(1, 30, { skipTotal: true });
    expect([skipped.items.length, skipped.totalItems]).toEqual([3, -1]);
    expect(trips()).toBe(6);
  });

  it("takes seven to create or update a record and five to delete one", async () => {
    const { other, trips } = await another();
    const created = await call(other, "POST", "/collections/posts/records", {
      token,
      body: { title: "draft", author: memberId },
    });
    expect(created.status).toBe(200);
    expect(trips()).toBe(7);

    const path = `/collections/posts/records/${created.body.id}`;
    const updated = await call(other, "PATCH", path, {
      token,
      body: { title: "final" },
    });
    expect(updated.body.title).toBe("final");
    expect(trips()).toBe(7);

    expect((await call(other, "DELETE", path, { token })).status).toBe(204);
    expect(trips()).toBe(5);
  });

  it("takes six to sign in with a password", async () => {
    const { other, trips } = await another();
    const signIn = await call(
      other,
      "POST",
      "/collections/members/auth-with-password",
      {
        body: { identity: "robin@example.com", password: "password 123 456" },
      },
    );
    expect(signIn.status).toBe(200);
    expect(trips()).toBe(6);
  });

  it("sees schema changes made elsewhere on the next read", async () => {
    const { other } = await another();
    const admin = nextbase.client({ superuser: true });
    const notes = await admin.collections.getOne("notes");
    await admin.collections.update("notes", {
      fields: [...notes.fields, { name: "pinned", type: "bool" }],
    });
    await admin.collections.create({ name: "tags", listRule: "" });

    const reader = other.client();
    expect((await reader.collection("notes").getOne(noteId)).pinned).toBe(
      false,
    );
    expect((await reader.collection("tags").getList()).totalItems).toBe(0);

    await admin.collections.update("notes", { listRule: null });
    await expect(reader.collection("notes").getList()).rejects.toMatchObject({
      status: 403,
    });
  });
});
