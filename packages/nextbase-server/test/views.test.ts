import {
  ClientError,
  type CollectionInput,
  type NextBaseClient,
} from "@nextbase/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextBase } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "./postgres.ts";

describe("view collections", () => {
  let t: TestDatabase;
  let nextbase: NextBase;
  let admin: NextBaseClient;
  let users = "";
  const ids: Record<string, string> = {};

  const failure = async (promise: Promise<unknown>): Promise<ClientError> => {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClientError);
    return error as ClientError;
  };
  const view = (name: string, viewQuery: string, extra: CollectionInput = {}) =>
    admin.collections.create({
      name,
      type: "view",
      viewQuery,
      listRule: "",
      viewRule: "",
      ...extra,
    });
  /** The viewQuery problem a definition is rejected with. */
  const rejected = async (viewQuery: string): Promise<string> => {
    const error = await view("rejected", viewQuery).catch((e: unknown) => e);
    expect(error, viewQuery).toBeInstanceOf(ClientError);
    if (!(error instanceof ClientError)) {
      await admin.collections.delete("rejected");
      return "";
    }
    expect(error.status).toBe(400);
    return (
      (error.data.viewQuery as { message: string } | undefined)?.message ??
      error.message
    );
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    nextbase = new NextBase({ database: t.pool });
    admin = nextbase.client({ superuser: true });
    users = (
      await admin.collections.create({
        name: "users",
        type: "auth",
        createRule: "",
        fields: [{ name: "name", type: "text" }],
      })
    ).id;
    const posts = await admin.collections.create({
      name: "posts",
      listRule: "",
      viewRule: "",
      fields: [
        { id: "posttitle0", name: "title", type: "text" },
        { name: "author", type: "relation", collectionId: users, maxSelect: 1 },
      ],
    });
    await admin.collections.create({
      name: "comments",
      fields: [
        {
          name: "post",
          type: "relation",
          collectionId: posts.id,
          maxSelect: 1,
          cascadeDelete: true,
        },
        { name: "body", type: "text" },
        { name: "created", type: "autodate" },
      ],
    });
    ids.ann = (
      (await admin.collection("users").create({
        email: "ann@example.com",
        name: "Ann",
        password: "password 123 456",
        passwordConfirm: "password 123 456",
      })) as { id: string }
    ).id;
    for (const [title, comments] of [
      ["hello", 3],
      ["quiet", 0],
      ["news", 1],
    ] as const) {
      const post = (await admin
        .collection("posts")
        .create({ title, author: ids.ann })) as { id: string };
      ids[title] = post.id;
      for (let i = 0; i < comments; i++) {
        await admin
          .collection("comments")
          .create({ post: post.id, body: `#${i}` });
      }
    }
  });
  afterAll(() => t.close());

  it("lists, filters, sorts and views rows of a query, with fields derived from its columns", async () => {
    const stats = await view(
      "post_stats",
      `SELECT p.id, p.title, count(c.id) AS comments, max(c.created) AS last_comment,
              (count(c.id) > 0) AS discussed, jsonb_build_object('title', p.title) AS meta
       FROM posts p LEFT JOIN comments c ON c.post = p.id
       GROUP BY p.id, p.title;`,
    );
    expect(stats.fields.map((f) => [f.name, f.type])).toEqual([
      ["id", "text"],
      ["title", "text"],
      ["comments", "number"],
      ["last_comment", "date"],
      ["discussed", "bool"],
      ["meta", "json"],
    ]);
    expect(stats).toMatchObject({
      type: "view",
      indexes: [],
      createRule: null,
    });

    const list = await admin
      .collection("post_stats")
      .getList(1, 10, { sort: "-comments,title" });
    expect(list.totalItems).toBe(3);
    expect(list.items.map((r) => [r.title, r.comments, r.discussed])).toEqual([
      ["hello", 3, true],
      ["news", 1, true],
      ["quiet", 0, false],
    ]);
    expect(list.items[0]?.last_comment).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    expect(list.items[2]?.last_comment).toBe("");
    expect(list.items[0]).toMatchObject({
      collectionName: "post_stats",
      meta: { title: "hello" },
    });

    const nb = nextbase.client();
    const filtered = await nb.collection("post_stats").getFullList({
      filter: 'comments >= 1 && meta.title ~ "e" && last_comment != ""',
      sort: "title",
    });
    expect(filtered.map((r) => r.title)).toEqual(["hello", "news"]);
    // A NULL column is blank: posts without comments have no last comment.
    expect(
      (await nb.collection("post_stats").getFirstListItem('last_comment = ""'))
        .title,
    ).toBe("quiet");
    expect(
      (await nb.collection("post_stats").getOne(ids.news as string)).comments,
    ).toBe(1);
  });

  it("applies list and view rules", async () => {
    await view("signed_in_stats", "SELECT p.id, p.title FROM posts p", {
      listRule: "@request.auth.id != ''",
      viewRule: null,
    });
    const anonymous = nextbase.client();
    expect(
      (await anonymous.collection("signed_in_stats").getList()).totalItems,
    ).toBe(0);
    expect(
      (
        await failure(
          anonymous.collection("signed_in_stats").getOne(ids.hello as string),
        )
      ).status,
    ).toBe(403);
    const ann = nextbase.client();
    await ann
      .collection("users")
      .signInWithPassword("ann@example.com", "password 123 456");
    expect((await ann.collection("signed_in_stats").getList()).totalItems).toBe(
      3,
    );
  });

  it("is read-only, even for superusers and in batches", async () => {
    for (const write of [
      () => admin.collection("post_stats").create({ id: "x", title: "y" }),
      () =>
        admin
          .collection("post_stats")
          .update(ids.hello as string, { title: "y" }),
      () => admin.collection("post_stats").delete(ids.hello as string),
      () =>
        admin
          .createBatch()
          .collection("post_stats")
          .delete(ids.hello as string)
          .send(),
    ]) {
      const error = await failure(write());
      expect(error.message).toMatch(/read-only/);
    }
    const create = await failure(
      view("bad_rules", "SELECT id FROM posts", { createRule: "" }),
    );
    expect(create.data).toMatchObject({
      createRule: { code: "validation_read_only" },
    });
    const fields = await failure(
      view("bad_fields", "SELECT id FROM posts", { fields: [] }),
    );
    expect(fields.data).toMatchObject({
      fields: { code: "validation_read_only" },
    });
    // Relations need a table to reference.
    const post_stats = await admin.collections.getOne("post_stats");
    const relation = await failure(
      admin.collections.create({
        name: "links",
        fields: [
          { name: "stats", type: "relation", collectionId: post_stats.id },
        ],
      }),
    );
    expect(relation.status).toBe(400);
  });

  it("rejects queries that are invalid or read what the view role may not", async () => {
    expect(await rejected("SELEC id FROM posts")).toMatch(/syntax error/);
    expect(await rejected("SELECT id FROM nope")).toMatch(
      /"nope" does not exist/,
    );
    expect(await rejected("SELECT title FROM posts")).toMatch(
      /needs an id column/,
    );
    expect(await rejected("SELECT id, 1 + 1 FROM posts")).toMatch(
      /Name every column/,
    );
    expect(await rejected("SELECT id, ARRAY[1] AS a FROM posts")).toMatch(
      /type _int4/,
    );
    expect(await rejected("SELECT 1 AS id")).toMatch(/id column must be text/);
    // The role can only read, so a second statement cannot write.
    expect(await rejected("SELECT '1' AS id; DELETE FROM posts")).toMatch(
      /permission denied for table posts/,
    );
    expect((await admin.collection("posts").getList()).totalItems).toBe(3);
    // NextBase's system tables and other roles' catalogs.
    expect(await rejected("SELECT id FROM _sessions")).toMatch(
      /permission denied for table _sessions/,
    );
    expect(await rejected("SELECT setup_secret AS id FROM _meta")).toMatch(
      /permission denied for table _meta/,
    );
    expect(await rejected("SELECT rolname::text AS id FROM pg_authid")).toMatch(
      /permission denied/,
    );
    expect(
      await rejected(
        "SELECT p.id, (SELECT max(token_hash) FROM _sessions) AS t FROM posts p",
      ),
    ).toMatch(/permission denied for table _sessions/);
    // Secrets of auth collections, directly or through whole rows.
    expect(await rejected("SELECT id, password FROM users")).toMatch(
      /permission denied for table users/,
    );
    expect(await rejected('SELECT id, "tokenKey" AS k FROM users')).toMatch(
      /permission denied/,
    );
    expect(
      await rejected("SELECT u.id, row_to_json(u) AS j FROM users u"),
    ).toMatch(/permission denied/);
    expect(await rejected("SELECT * FROM _superusers")).toMatch(
      /permission denied/,
    );
    // Privileged functions.
    expect(await rejected("SELECT pg_read_file('/etc/hosts') AS id")).toMatch(
      /permission denied for function pg_read_file/,
    );
    // Named columns of auth collections are fine, and so is counting rows.
    await view(
      "people",
      "SELECT u.id, u.name, u.email, (SELECT count(*) FROM users) AS total FROM users u",
    );
    expect((await admin.collection("people").getFullList())[0]).toMatchObject({
      name: "Ann",
      total: 1,
    });
    await admin.collections.delete("people");
  });

  it("runs every read of a view as the view role", async () => {
    // These pass at save time, since nothing evaluates them, and fail when
    // read: the role cannot read _meta, even through SQL given as text.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await view(
        "sneaky",
        "SELECT p.id, query_to_xml('SELECT setup_secret FROM nextbase._meta', true, true, '')::text AS x FROM posts p",
      );
      const error = await failure(admin.collection("sneaky").getList());
      expect(error.status).toBe(500);
      expect(JSON.stringify(error.data) + error.message).not.toMatch(/secret/);
      expect(String(errors.mock.calls[0]?.[1])).toMatch(
        /permission denied for table _meta/,
      );
    } finally {
      errors.mockRestore();
      await admin.collections.delete("sneaky");
    }
    // Rules elsewhere would read views as NextBase itself, so they cannot.
    const rule = await failure(
      admin.collections.update("posts", {
        listRule: "@collection.post_stats.comments > 0",
      }),
    );
    expect(rule.data).toMatchObject({
      listRule: { message: expect.stringMatching(/cannot read the view/) },
    });
  });

  it("stops records API statements that run past statementTimeout", async () => {
    await view(
      "slow",
      "SELECT p.id, pg_sleep(0.3)::text AS waited FROM posts p",
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const strict = new NextBase({ database: t.pool, statementTimeout: 100 });
      const error = await failure(
        strict.client({ superuser: true }).collection("slow").getList(),
      );
      expect(error).toMatchObject({
        status: 500,
        message: "The request took too long and was stopped.",
      });
      // The default (8 seconds) lets it finish, and so does 0, which is off.
      const off = new NextBase({ database: t.pool, statementTimeout: 0 });
      expect(
        (await off.client({ superuser: true }).collection("slow").getList())
          .totalItems,
      ).toBe(3);
      expect((await admin.collection("slow").getList()).totalItems).toBe(3);
    } finally {
      errors.mockRestore();
      await admin.collections.delete("slow");
    }
    expect(() => new NextBase({ statementTimeout: -1 })).toThrow(RangeError);
  });

  it("works for a database user that is not a superuser, given CREATEROLE", async () => {
    const limited = await createTestDatabase("CREATEROLE");
    try {
      const instance = new NextBase({ database: limited.pool });
      const su = instance.client({ superuser: true });
      await su.collections.create({
        name: "users",
        type: "auth",
        fields: [{ name: "name", type: "text" }],
      });
      await su.collection("users").create({
        email: "x@example.com",
        name: "X",
        password: "password 123 456",
        passwordConfirm: "password 123 456",
      });
      await su.collections.create({
        name: "names",
        type: "view",
        listRule: "",
        viewQuery: "SELECT u.id, u.name FROM users u",
      });
      expect(
        (await instance.client().collection("names").getFullList())[0],
      ).toMatchObject({ name: "X" });
      const secret = await failure(
        su.collections.create({
          name: "hashes",
          type: "view",
          viewQuery: "SELECT id, password FROM users",
        }),
      );
      expect(secret.data).toMatchObject({
        viewQuery: { message: expect.stringMatching(/permission denied/) },
      });
      // Fields added later are granted to the role.
      const users = await su.collections.getOne("users");
      await su.collections.update("users", {
        fields: [...users.fields, { name: "bio", type: "text" }],
      });
      await su.collections.create({
        name: "bios",
        type: "view",
        viewQuery: "SELECT u.id, u.bio FROM users u",
      });
    } finally {
      await limited.close();
    }
  });

  it("explains that views need CREATEROLE when the database user lacks it", async () => {
    const plain = await createTestDatabase("NOCREATEROLE");
    try {
      const su = new NextBase({ database: plain.pool }).client({
        superuser: true,
      });
      await su.collections.create({
        name: "things",
        fields: [{ name: "name", type: "text" }],
      });
      const error = await failure(
        su.collections.create({
          name: "thing_names",
          type: "view",
          viewQuery: "SELECT t.id FROM things t",
        }),
      );
      expect(error.status).toBe(400);
      expect(error.message).toMatch(/CREATEROLE/);
      // Everything else keeps working.
      expect(await su.collection("things").create({ name: "a" })).toMatchObject(
        { name: "a" },
      );
    } finally {
      await plain.close();
    }
  });

  it("follows schema changes, and blocks those that would break it", async () => {
    const titles = await view(
      "titles",
      "SELECT p.id, upper(p.title) AS loud FROM posts p",
    );
    // A view of a view.
    await view(
      "short_titles",
      "SELECT t.id, left(t.loud, 2) AS short FROM titles t",
    );

    // Renaming a collection or a field it reads keeps the view working.
    await admin.collections.update("posts", { name: "articles" });
    expect(
      (await admin.collection("titles").getFullList({ sort: "loud" })).map(
        (r) => r.loud,
      ),
    ).toEqual(["HELLO", "NEWS", "QUIET"]);

    // Dropping what it reads is refused, with a reason.
    const posts = await admin.collections.getOne("articles");
    const drop = await failure(
      admin.collections.update("articles", {
        fields: posts.fields.filter((f) => f.name !== "title"),
      }),
    );
    expect(drop.message).toMatch(/A view depends on/);
    await admin.collections.create({
      name: "labels",
      fields: [{ name: "name", type: "text" }],
    });
    await view("label_names", "SELECT l.id, l.name FROM labels l");
    expect((await failure(admin.collections.delete("labels"))).message).toMatch(
      /A view depends on/,
    );
    await admin.collections.delete("label_names");
    await admin.collections.delete("labels");
    expect((await failure(admin.collections.delete("titles"))).message).toMatch(
      /A view depends on/,
    );

    // Changing the query re-derives fields, keeping ids of unchanged names.
    const changed = await admin.collections.update("titles", {
      name: "loud_titles",
      viewQuery:
        "SELECT a.id, upper(a.title) AS loud, length(a.title) AS size FROM articles a",
    });
    expect(changed.fields.find((f) => f.name === "loud")?.id).toBe(
      titles.fields.find((f) => f.name === "loud")?.id,
    );
    expect(changed.fields.map((f) => f.name)).toEqual(["id", "loud", "size"]);
    expect(
      (await admin.collection("short_titles").getFullList({ sort: "short" }))[0]
        ?.short,
    ).toBe("HE");

    // Rules can only use fields the query has.
    const rule = await failure(
      admin.collections.update("loud_titles", { listRule: "nope = 1" }),
    );
    expect(rule.data).toMatchObject({
      listRule: { code: "validation_invalid_rule" },
    });

    await admin.collections.delete("short_titles");
    await admin.collections.delete("loud_titles");
    await admin.collections.delete("post_stats");
    await admin.collections.delete("signed_in_stats");
    // Nothing depends on the table any more.
    await admin.collections.update("articles", { name: "posts" });
  });
});
