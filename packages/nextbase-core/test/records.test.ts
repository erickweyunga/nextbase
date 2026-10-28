import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextBase } from "../src/index.ts";
import { type CallOptions, type Reply, call as request } from "./http.ts";
import { createTestDatabase, type TestDatabase } from "./postgres.ts";

describe("records API", () => {
  let t: TestDatabase;
  let nextbase: NextBase;
  const tokens: Record<"admin" | "ann" | "bob", string> = {
    admin: "",
    ann: "",
    bob: "",
  };
  const ids: Record<string, string> = {};

  const call = (
    method: string,
    path: string,
    options?: CallOptions,
  ): Promise<Reply> => request(nextbase, method, path, options);
  const as = (
    who: keyof typeof tokens | undefined,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Reply> =>
    call(method, path, { token: who ? tokens[who] : undefined, body });
  const items = (reply: Reply): Record<string, unknown>[] =>
    reply.body.items as Record<string, unknown>[];

  async function login(
    collection: string,
    identity: string,
    password: string,
  ): Promise<Reply> {
    return call("POST", `/collections/${collection}/auth-with-password`, {
      body: { identity, password },
    });
  }

  async function signup(email: string, name: string): Promise<string> {
    const reply = await as(undefined, "POST", "/collections/users/records", {
      email,
      name,
      password: `password-of-${name}`,
      passwordConfirm: `password-of-${name}`,
    });
    expect(reply.status).toBe(200);
    return reply.body.id as string;
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    nextbase = new NextBase({ database: t.pool });
    await nextbase.createSuperuser("admin@example.com", "admin password 123");
    tokens.admin = (
      await login("_superusers", "admin@example.com", "admin password 123")
    ).body.token as string;

    const users = await as("admin", "POST", "/collections", {
      name: "users",
      type: "auth",
      listRule: "",
      viewRule: "",
      createRule: "",
      updateRule: "id = @request.auth.id",
      deleteRule: "id = @request.auth.id",
      fields: [{ name: "name", type: "text" }],
    });
    expect(users.status).toBe(200);
    ids.users = users.body.id as string;

    const posts = await as("admin", "POST", "/collections", {
      name: "posts",
      listRule: 'status = "live" || author = @request.auth.id',
      viewRule: 'status = "live" || author = @request.auth.id',
      createRule: '@request.auth.id != "" && author = @request.auth.id',
      updateRule:
        "author = @request.auth.id && @request.body.author:isset = false",
      deleteRule: "author = @request.auth.id",
      fields: [
        { name: "title", type: "text", required: true, max: 100 },
        { name: "status", type: "select", values: ["draft", "live"] },
        {
          name: "author",
          type: "relation",
          collectionId: ids.users,
          required: true,
        },
        { name: "tags", type: "select", values: ["a", "b", "c"], maxSelect: 3 },
        { name: "views", type: "number" },
        { name: "created", type: "autodate" },
      ],
    });
    expect(posts.status).toBe(200);
    ids.posts = posts.body.id as string;

    ids.ann = await signup("ann@example.com", "ann");
    ids.bob = await signup("bob@example.com", "bob");
    tokens.ann = (await login("users", "ann@example.com", "password-of-ann"))
      .body.token as string;
    tokens.bob = (await login("users", "bob@example.com", "password-of-bob"))
      .body.token as string;
  });
  afterAll(() => t.close());

  describe("create", () => {
    it("checks the create rule against the submitted record", async () => {
      expect(
        (
          await as(undefined, "POST", "/collections/posts/records", {
            title: "x",
            author: ids.ann,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await as("ann", "POST", "/collections/posts/records", {
            title: "x",
            author: ids.bob,
          })
        ).status,
      ).toBe(400);
      const draft = await as("ann", "POST", "/collections/posts/records", {
        title: "Ann's draft",
        status: "draft",
        author: ids.ann,
      });
      expect(draft).toMatchObject({
        status: 200,
        body: { title: "Ann's draft", author: ids.ann, tags: [], views: 0 },
      });
      expect(draft.body.created).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
      ids.draft = draft.body.id as string;
      const live = await as("ann", "POST", "/collections/posts/records", {
        title: "Hello world",
        status: "live",
        author: ids.ann,
        tags: ["a"],
      });
      ids.live = live.body.id as string;
      const bobs = await as("bob", "POST", "/collections/posts/records", {
        title: "Bob's draft",
        status: "draft",
        author: ids.bob,
      });
      ids.bobDraft = bobs.body.id as string;
    });

    it("reports every invalid value", async () => {
      const reply = await as("ann", "POST", "/collections/posts/records", {
        title: "x".repeat(101),
        status: "archived",
        author: "nobody000000000",
        tags: ["a", "a"],
        views: "many",
      });
      expect(reply).toMatchObject({
        status: 400,
        body: {
          data: {
            title: { code: "validation_length_out_of_range" },
            status: { code: "validation_invalid_value" },
            tags: { code: "validation_not_unique" },
            views: { code: "validation_invalid_type" },
          },
        },
      });
      const missing = await as("admin", "POST", "/collections/posts/records", {
        author: "nobody000000000",
      });
      expect(missing.body.data).toMatchObject({
        title: { code: "validation_required" },
        author: { code: "validation_missing_relation" },
      });
      // The create rule refuses Ann this author, so she does not learn
      // whether the record exists.
      const refused = await as("ann", "POST", "/collections/posts/records", {
        author: "nobody000000000",
      });
      expect(refused.body.data).toEqual({
        title: { code: "validation_required", message: "Cannot be blank." },
      });
    });

    it("returns 204 when the creator may not view the record", async () => {
      await as("admin", "POST", "/collections", {
        name: "inbox",
        createRule: "",
        fields: [{ name: "message", type: "text" }],
      });
      expect(
        (
          await as(undefined, "POST", "/collections/inbox/records", {
            message: "hi",
          })
        ).status,
      ).toBe(204);
      expect(
        (await as(undefined, "GET", "/collections/inbox/records")).status,
      ).toBe(403);
      expect(
        items(await as("admin", "GET", "/collections/inbox/records")),
      ).toHaveLength(1);
    });
  });

  describe("list and view", () => {
    it("lists only what the list rule allows", async () => {
      const titles = async (who?: keyof typeof tokens): Promise<unknown[]> =>
        items(
          await as(who, "GET", "/collections/posts/records?sort=title"),
        ).map((p) => p.title);
      expect(await titles()).toEqual(["Hello world"]);
      expect(await titles("ann")).toEqual(["Ann's draft", "Hello world"]);
      expect(await titles("bob")).toEqual(["Bob's draft", "Hello world"]);
      expect(await titles("admin")).toEqual([
        "Ann's draft",
        "Bob's draft",
        "Hello world",
      ]);
    });

    it("filters, sorts and paginates", async () => {
      const page = await as(
        "admin",
        "GET",
        "/collections/posts/records?filter=" +
          encodeURIComponent('title ~ "draft"') +
          "&sort=-title&perPage=1",
      );
      expect(page.body).toMatchObject({
        page: 1,
        perPage: 1,
        totalItems: 2,
        totalPages: 2,
      });
      expect(items(page).map((p) => p.title)).toEqual(["Bob's draft"]);
      const skip = await as(
        "admin",
        "GET",
        "/collections/posts/records?skipTotal=1&page=2&perPage=1&sort=title",
      );
      expect(skip.body).toMatchObject({ totalItems: -1, totalPages: -1 });
      expect(items(skip).map((p) => p.title)).toEqual(["Bob's draft"]);
      const tagged = await as(
        undefined,
        "GET",
        "/collections/posts/records?filter=" +
          encodeURIComponent('tags ?= "a"'),
      );
      expect(items(tagged)).toHaveLength(1);
    });

    it("rejects bad list parameters", async () => {
      for (const query of [
        "perPage=0",
        "perPage=1001",
        "page=x",
        "sort=tags",
        "sort=nope",
        `filter=${encodeURIComponent("nope = 1")}`,
      ]) {
        expect(
          (await as("admin", "GET", `/collections/posts/records?${query}`))
            .status,
        ).toBe(400);
      }
    });

    it("hides records the view rule rejects", async () => {
      expect(
        (await as("bob", "GET", `/collections/posts/records/${ids.draft}`))
          .status,
      ).toBe(404);
      expect(
        (await as("ann", "GET", `/collections/posts/records/${ids.draft}`))
          .status,
      ).toBe(200);
      expect(
        (
          await as(
            undefined,
            "GET",
            "/collections/posts/records/missing00000000",
          )
        ).status,
      ).toBe(404);
    });

    it("expands relations and selects fields", async () => {
      const reply = await as(
        "bob",
        "GET",
        `/collections/posts/records/${ids.live}?expand=author&fields=id,title,expand.author.name,expand.author.email`,
      );
      expect(reply.body).toEqual({
        id: ids.live,
        title: "Hello world",
        expand: { author: { name: "ann", email: "" } },
      });
    });

    it("shows an auth record's email only to itself or when visible", async () => {
      expect(
        (await as("bob", "GET", `/collections/users/records/${ids.ann}`)).body
          .email,
      ).toBe("");
      expect(
        (await as("ann", "GET", `/collections/users/records/${ids.ann}`)).body
          .email,
      ).toBe("ann@example.com");
      const listed = items(
        await as("ann", "GET", "/collections/users/records"),
      );
      expect(
        listed.every((u) => !("password" in u) && !("tokenKey" in u)),
      ).toBe(true);
      // Filters cannot probe hidden emails either.
      const probe = await as(
        "bob",
        "GET",
        "/collections/users/records?filter=" +
          encodeURIComponent('email = "ann@example.com"'),
      );
      expect(items(probe)).toHaveLength(0);
    });
  });

  describe("update", () => {
    it("applies the update rule to the stored record and the submitted body", async () => {
      expect(
        (
          await as("bob", "PATCH", `/collections/posts/records/${ids.draft}`, {
            title: "taken",
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await as("ann", "PATCH", `/collections/posts/records/${ids.draft}`, {
            author: ids.bob,
          })
        ).status,
      ).toBe(404);
      const updated = await as(
        "ann",
        "PATCH",
        `/collections/posts/records/${ids.draft}`,
        { title: "Renamed", "tags+": ["b", "c"], "views+": 5 },
      );
      expect(updated.body).toMatchObject({
        title: "Renamed",
        tags: ["b", "c"],
        views: 5,
      });
      const again = await as(
        "ann",
        "PATCH",
        `/collections/posts/records/${ids.draft}`,
        { "tags-": "b", "+tags": "a", "views-": 2 },
      );
      expect(again.body).toMatchObject({ tags: ["a", "c"], views: 3 });
    });

    it("does not reveal validation errors to callers the rule rejects", async () => {
      expect(
        (
          await as("bob", "PATCH", `/collections/posts/records/${ids.draft}`, {
            title: "",
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await as("ann", "PATCH", `/collections/posts/records/${ids.draft}`, {
            title: "",
          })
        ).status,
      ).toBe(400);
    });

    it("protects auth fields and revokes other sessions on password change", async () => {
      const path = `/collections/users/records/${ids.bob}`;
      expect(
        (await as("bob", "PATCH", path, { emailVerified: true })).body.data,
      ).toMatchObject({ emailVerified: { code: "validation_forbidden" } });
      expect(
        (await as("bob", "PATCH", path, { email: "new@example.com" })).body
          .data,
      ).toMatchObject({ email: { code: "validation_forbidden" } });
      const noOld = await as("bob", "PATCH", path, {
        password: "new password 1234!",
        passwordConfirm: "new password 1234!",
      });
      expect(noOld.body.data).toMatchObject({
        oldPassword: { code: "validation_invalid_old_password" },
      });
      // Bob is also signed in on another device.
      const phone = (await login("users", "bob@example.com", "password-of-bob"))
        .body.token as string;
      const changed = await as("bob", "PATCH", path, {
        password: "new password 1234!",
        passwordConfirm: "new password 1234!",
        oldPassword: "password-of-bob",
      });
      expect(changed.status).toBe(200);
      // The other device is signed out; the session that made the change is not.
      expect(
        (await call("GET", "/collections/posts/records", { token: phone }))
          .status,
      ).toBe(401);
      expect(
        (await as("bob", "GET", "/collections/posts/records")).status,
      ).toBe(200);
      expect(
        (await login("users", "bob@example.com", "new password 1234!")).status,
      ).toBe(200);
    });

    it("lets superusers verify records and change emails", async () => {
      const reply = await as(
        "admin",
        "PATCH",
        `/collections/users/records/${ids.ann}`,
        { emailVerified: true },
      );
      expect(reply.body).toMatchObject({ emailVerified: true });
    });

    it("reports unique violations on the indexed fields", async () => {
      const duplicate = await as(
        undefined,
        "POST",
        "/collections/users/records",
        {
          email: "ANN@example.com",
          password: "whatever12345678",
          passwordConfirm: "whatever12345678",
        },
      );
      expect(duplicate).toMatchObject({
        status: 400,
        body: { data: { email: { code: "validation_not_unique" } } },
      });
    });
  });

  describe("auth rule", () => {
    it("requires records to meet the authRule to sign in", async () => {
      await as("admin", "PATCH", "/collections/users", {
        authRule: "emailVerified = true",
      });
      expect(
        (await login("users", "bob@example.com", "new password 1234!")).status,
      ).toBe(403);
      expect(
        (await login("users", "ann@example.com", "password-of-ann")).status,
      ).toBe(200);
      await as("admin", "PATCH", "/collections/users", { authRule: "" });
    });
  });

  describe("rules on save", () => {
    it("rejects invalid rules and changes that would break them", async () => {
      expect(
        await as("admin", "PATCH", "/collections/posts", {
          listRule: "nope = 1",
        }),
      ).toMatchObject({
        status: 400,
        body: { data: { listRule: { code: "validation_invalid_rule" } } },
      });
      const collection = (await as("admin", "GET", "/collections/posts"))
        .body as { fields: { id: string; name: string }[] };
      const renamed = collection.fields.map((f) =>
        f.name === "status" ? { ...f, name: "state" } : f,
      );
      expect(
        await as("admin", "PATCH", "/collections/posts", { fields: renamed }),
      ).toMatchObject({
        status: 400,
        body: { data: { listRule: { code: "validation_invalid_rule" } } },
      });
      const users = (await as("admin", "GET", "/collections/users")).body as {
        fields: { name: string }[];
      };
      expect(
        await as("admin", "PATCH", "/collections/users", {
          fields: users.fields.filter((f) => f.name !== "id"),
        }),
      ).toMatchObject({ status: 200 });
    });
  });

  describe("delete", () => {
    it("applies the delete rule", async () => {
      expect(
        (await as("bob", "DELETE", `/collections/posts/records/${ids.draft}`))
          .status,
      ).toBe(404);
      expect(
        (await as("ann", "DELETE", `/collections/posts/records/${ids.draft}`))
          .status,
      ).toBe(204);
      expect(
        (await as("ann", "GET", `/collections/posts/records/${ids.draft}`))
          .status,
      ).toBe(404);
    });

    it("follows a cycle of cascades once, deleting every record on it", async () => {
      const admin = nextbase.client({ superuser: true });
      const nodes = await admin.collections.create({ name: "nodes" });
      // Each node points at the next, and deleting one deletes those that
      // point at it, around the cycle.
      await admin.collections.update("nodes", {
        fields: [
          {
            name: "next",
            type: "relation",
            collectionId: nodes.id,
            cascadeDelete: true,
          },
        ],
      });
      const ids = ["node00000000001", "node00000000002", "node00000000003"];
      for (const id of ids) await admin.collection("nodes").create({ id });
      for (const [i, id] of ids.entries()) {
        await admin
          .collection("nodes")
          .update(id, { next: ids[(i + 1) % ids.length] });
      }
      await admin.collection("nodes").delete(ids[0] as string);
      expect(await admin.collection("nodes").getFullList()).toEqual([]);
    });

    it("lets a cascade delete records that require the ones it deletes", async () => {
      const admin = nextbase.client({ superuser: true });
      const ca = await admin.collections.create({ name: "ca" });
      const cb = await admin.collections.create({
        name: "cb",
        fields: [
          { name: "a", type: "relation", collectionId: ca.id, required: true },
        ],
      });
      // Deleting a cb deletes the ca pointing at it, and that ca is what the
      // cb itself requires.
      await admin.collections.update("ca", {
        fields: [
          {
            name: "b",
            type: "relation",
            collectionId: cb.id,
            cascadeDelete: true,
          },
        ],
      });
      const [a, b, other] = [
        "ca0000000000001",
        "cb0000000000001",
        "cb0000000000002",
      ];
      await admin.collection("ca").create({ id: a });
      await admin.collection("cb").create({ id: b, a });
      await admin.collection("ca").update(a, { b });
      await admin.collection("cb").create({ id: other, a });

      // Another cb still requires the ca, so neither goes.
      await expect(admin.collection("cb").delete(b)).rejects.toMatchObject({
        status: 400,
      });
      await admin.collection("cb").delete(other);
      await admin.collection("cb").delete(b);
      expect(await admin.collection("ca").getFullList()).toEqual([]);
      expect(await admin.collection("cb").getFullList()).toEqual([]);
    });

    it("cascades whatever order the fields that reference a record come in", async () => {
      const admin = nextbase.client({ superuser: true });
      const targets = await admin.collections.create({ name: "targets" });
      const req = {
        name: "req",
        type: "relation",
        collectionId: targets.id,
        required: true,
      } as const;
      const casc = {
        name: "casc",
        type: "relation",
        collectionId: targets.id,
        cascadeDelete: true,
      } as const;
      for (const [name, fields] of [
        ["reqfirst", [req, casc]],
        ["cascfirst", [casc, req]],
      ] as const) {
        await admin.collections.create({ name, fields: [...fields] });
        const target = `${name}0000000`.slice(0, 15);
        await admin.collection("targets").create({ id: target });
        await admin.collection(name).create({ req: target, casc: target });
        await admin.collection("targets").delete(target);
        expect(await admin.collection(name).getFullList()).toEqual([]);
      }
    });

    it("cascades, clears or blocks on records that reference the deleted one", async () => {
      await as("admin", "POST", "/collections", {
        name: "comments",
        listRule: "",
        createRule: "",
        fields: [
          {
            name: "post",
            type: "relation",
            collectionId: ids.posts,
            cascadeDelete: true,
          },
          {
            name: "mentions",
            type: "relation",
            collectionId: ids.users,
            maxSelect: 5,
          },
        ],
      });
      const comment = await as(
        "admin",
        "POST",
        "/collections/comments/records",
        { post: ids.live, mentions: [ids.ann, ids.bob] },
      );
      expect(comment.status).toBe(200);

      // posts.author is required and does not cascade: Ann cannot go while her post exists.
      expect(
        (await as("ann", "DELETE", `/collections/users/records/${ids.ann}`))
          .status,
      ).toBe(400);
      expect(
        (await as("ann", "DELETE", `/collections/posts/records/${ids.live}`))
          .status,
      ).toBe(204);
      expect(
        items(await as("admin", "GET", "/collections/comments/records")),
      ).toHaveLength(0);

      const second = await as(
        "admin",
        "POST",
        "/collections/comments/records",
        { mentions: [ids.ann, ids.bob] },
      );
      expect(
        (await as("ann", "DELETE", `/collections/users/records/${ids.ann}`))
          .status,
      ).toBe(204);
      expect(
        (
          await as(
            "admin",
            "GET",
            `/collections/comments/records/${second.body.id}`,
          )
        ).body.mentions,
      ).toEqual([ids.bob]);
    });

    it("keeps superuser-only collections closed to everyone else", async () => {
      expect(
        (await as("bob", "GET", "/collections/_superusers/records")).status,
      ).toBe(403);
      expect(
        items(await as("admin", "GET", "/collections/_superusers/records")),
      ).toHaveLength(1);
    });
  });
});
