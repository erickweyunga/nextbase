import {
  type AuthStorage,
  AuthStore,
  ClientError,
  filter,
  NextBaseClient,
  type RecordModel,
} from "@nextbase/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseFilter } from "../src/filter/parser.ts";
import { NextBase } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "./postgres.ts";

/** The literal on the right of `x = <value>`, as the server parses it. */
function parsedLiteral(value: Parameters<typeof filter>[1]): unknown {
  const node = parseFilter(filter("x = {:v}", value)) as unknown as {
    right: { value: unknown };
  };
  return node.right.value;
}

describe("filter()", () => {
  it("quotes strings so the server reads back exactly the value", () => {
    for (const v of [
      "plain",
      'say "hi"',
      "it's",
      "back\\slash",
      "trailing\\",
      '\\"',
      "} {:v} && id != ''",
      "emoji 🎉 and\nnewline",
      "",
    ]) {
      expect(parsedLiteral({ v })).toBe(v);
    }
  });

  it("writes numbers in plain decimal notation", () => {
    for (const v of [0, -0, 42, -7.25, 1e21, -1.5e22, 1.5e-7, 5e-324, 0.1]) {
      expect(parsedLiteral({ v })).toBe(v === 0 ? 0 : v);
    }
    expect(filter("n = {:v}", { v: 123n })).toBe("n = 123");
  });

  it("writes booleans, nullish values, dates and JSON", () => {
    expect(
      filter("{:a} {:b} {:c} {:d}", {
        a: true,
        b: false,
        c: null,
        d: undefined,
      }),
    ).toBe("true false null null");
    const date = new Date("2026-10-19T08:00:00.000Z");
    expect(parsedLiteral({ v: date })).toBe("2026-10-19T08:00:00.000Z");
    expect(parsedLiteral({ v: { a: [1, "x"] } })).toBe('{"a":[1,"x"]}');
  });

  it("replaces every placeholder and rejects missing or unusable values", () => {
    expect(filter("a = {:x} || b = {:x}", { x: 1 })).toBe("a = 1 || b = 1");
    expect(() => filter("a = {:missing}", {})).toThrow("{:missing}");
    expect(() => filter("a = {:toString}", {})).toThrow("{:toString}");
    expect(() => filter("a = {:n}", { n: Number.NaN })).toThrow("finite");
    expect(() => filter("a = {:n}", { n: Number.POSITIVE_INFINITY })).toThrow(
      "finite",
    );
    expect(() => filter("a = {:d}", { d: new Date(Number.NaN) })).toThrow(
      "invalid date",
    );
  });
});

class MemoryStorage implements AuthStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

describe("AuthStore", () => {
  const record: RecordModel = {
    id: "abc",
    collectionId: "_superusers",
    collectionName: "_superusers",
  };

  it("keeps state in memory by default outside the browser", () => {
    const store = new AuthStore();
    expect(store.token).toBe("");
    expect(store.isValid).toBe(false);
    store.save("opaque-token", record);
    expect(store.isValid).toBe(true);
    expect(store.isSuperuser).toBe(true);
    expect(new AuthStore().token).toBe("");
  });

  it("counts as signed in with a token or a cookie session's record", () => {
    const store = new AuthStore();
    store.save("", record);
    expect(store.isValid).toBe(true);
    expect(store.isSuperuser).toBe(true);
    store.save("opaque-token", null);
    expect(store.isValid).toBe(true);
    expect(store.isSuperuser).toBe(false);
    store.clear();
    expect(store.isValid).toBe(false);
  });

  it("persists to storage and restores from it", () => {
    const storage = new MemoryStorage();
    new AuthStore({ storage }).save("opaque-token", record);
    const restored = new AuthStore({ storage });
    expect(restored.record).toEqual(record);
    expect(restored.isValid).toBe(true);
    restored.clear();
    expect(storage.items.size).toBe(0);
    expect(new AuthStore({ storage }).token).toBe("");
  });

  it("starts signed out from corrupt or unreadable storage", () => {
    const storage = new MemoryStorage();
    for (const raw of [
      "{",
      "null",
      '"x"',
      '{"token":5}',
      '{"token":"t","record":7}',
    ]) {
      storage.items.set("nextbase_auth", raw);
      const store = new AuthStore({ storage });
      expect(store.record).toBe(null);
      if (raw.includes('"t"')) expect(store.token).toBe("t");
      else expect(store.token).toBe("");
    }
    const broken: AuthStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const store = new AuthStore({ storage: broken });
    store.save("t", null);
    expect(store.token).toBe("t");
    store.clear();
    expect(store.token).toBe("");
  });

  it("notifies listeners until they unsubscribe", () => {
    const store = new AuthStore();
    const calls: [string, RecordModel | null][] = [];
    const off = store.onChange((t, r) => calls.push([t, r]), true);
    store.save("t", record);
    off();
    store.clear();
    expect(calls).toEqual([
      ["", null],
      ["t", record],
    ]);
  });
});

describe("NextBaseClient", () => {
  it("reports network failures and aborts with status 0", async () => {
    const failing = new NextBaseClient({
      baseUrl: "http://example.test/api/nextbase",
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    const error = await failing.health().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClientError);
    expect(error).toMatchObject({
      status: 0,
      message: "fetch failed",
      isAbort: false,
    });

    const aborting = new NextBaseClient({
      fetch: () => Promise.reject(new DOMException("aborted", "AbortError")),
    });
    expect(await aborting.health().catch((e: unknown) => e)).toMatchObject({
      status: 0,
      isAbort: true,
    });
  });

  it("reports non-JSON responses with their status", async () => {
    const proxy = new NextBaseClient({
      fetch: async () => new Response("<h1>Bad gateway</h1>", { status: 502 }),
    });
    expect(await proxy.health().catch((e: unknown) => e)).toMatchObject({
      status: 502,
      message: "The request failed with status 502.",
    });
    const garbled = new NextBaseClient({
      fetch: async () => new Response("{", { status: 200 }),
    });
    expect(await garbled.health().catch((e: unknown) => e)).toMatchObject({
      status: 0,
      message: "The server sent an invalid response.",
    });
  });

  it("builds URLs from the base URL, query and options", async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const nb = new NextBaseClient({
      baseUrl: "https://app.example/api/nextbase/",
      fetch: async (input, init) => {
        seen.push({ url: String(input), init });
        return Response.json({
          page: 1,
          perPage: 5,
          totalItems: 0,
          totalPages: 0,
          items: [],
        });
      },
    });
    nb.authStore.save("tok", null);
    await nb.collection("posts").getList(2, 5, {
      filter: nb.filter("title = {:t}", { t: "a&b" }),
      sort: "-created",
      expand: undefined,
      query: { custom: "1" },
      headers: { "x-extra": "yes" },
      cache: "no-store",
    });
    const url = new URL(seen[0]?.url ?? "");
    expect(url.origin + url.pathname).toBe(
      "https://app.example/api/nextbase/collections/posts/records",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      custom: "1",
      page: "2",
      perPage: "5",
      filter: 'title = "a&b"',
      sort: "-created",
    });
    expect(seen[0]?.init).toMatchObject({
      cache: "no-store",
      headers: { authorization: "Bearer tok", "x-extra": "yes" },
    });
    await nb.collection("posts").getOne("../../collections");
    expect(seen[1]?.url).toBe(
      "https://app.example/api/nextbase/collections/posts/records/..%2F..%2Fcollections",
    );
  });
});

describe("the SDK against a real instance", () => {
  let t: TestDatabase;
  let nextbase: NextBase;
  let admin: NextBaseClient;

  interface Note extends RecordModel {
    title: string;
    owner: string;
    rank: number;
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    nextbase = new NextBase({ database: t.pool });
    admin = nextbase.client({ superuser: true });
    await admin.collections.create({
      name: "users",
      type: "auth",
      createRule: "",
      viewRule: "id = @request.auth.id",
      updateRule: "id = @request.auth.id",
      deleteRule: "id = @request.auth.id",
      fields: [{ name: "name", type: "text" }],
    });
    const users = await admin.collections.getOne("users");
    await admin.collections.create({
      name: "notes",
      listRule: "owner = @request.auth.id",
      viewRule: "owner = @request.auth.id",
      createRule: "owner = @request.auth.id",
      updateRule: "owner = @request.auth.id",
      fields: [
        { name: "title", type: "text", required: true },
        {
          name: "owner",
          type: "relation",
          collectionId: users.id,
          maxSelect: 1,
        },
        { name: "rank", type: "number" },
      ],
    });
  });
  afterAll(() => t.close());

  async function signUp(email: string): Promise<NextBaseClient> {
    const nb = nextbase.client();
    await nb.collection("users").create({
      email,
      password: "password 123 456",
      passwordConfirm: "password 123 456",
      name: email.split("@")[0],
    });
    await nb.collection("users").signInWithPassword(email, "password 123 456");
    return nb;
  }

  it("runs superuser-only APIs only for a superuser client", async () => {
    expect((await admin.collections.getFullList()).map((c) => c.name)).toEqual(
      expect.arrayContaining(["_superusers", "users", "notes"]),
    );
    const error = await nextbase
      .client()
      .collections.getFullList()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClientError);
    expect((error as ClientError).status).toBe(401);
    // An HTTP request cannot claim the in-process superuser.
    const response = await nextbase.handle(
      new Request("http://localhost/api/nextbase/collections"),
    );
    expect(response.status).toBe(401);
  });

  it("signs in, keeps the auth store current, and signs out on 401", async () => {
    const nb = await signUp("ann@example.com");
    const me = nb.authStore.record as RecordModel;
    expect(nb.authStore.isValid).toBe(true);
    expect(me).toMatchObject({
      collectionName: "users",
      email: "ann@example.com",
      name: "ann",
    });

    const changes: string[] = [];
    nb.authStore.onChange((t) => changes.push(t));
    await nb.collection("users").update(me.id, { name: "Ann" });
    expect(nb.authStore.record?.name).toBe("Ann");

    const refreshed = await nb.collection("users").refreshSession();
    expect(refreshed.record.name).toBe("Ann");
    expect(nb.authStore.token).toBe(refreshed.token);

    // A password change signs out the other sessions, which then get a 401.
    const other = nextbase.client();
    await other
      .collection("users")
      .signInWithPassword("ann@example.com", "password 123 456");
    await nb.collection("users").update(me.id, {
      oldPassword: "password 123 456",
      password: "password 456 789",
      passwordConfirm: "password 456 789",
    });
    const error = await other
      .collection("users")
      .getOne(me.id)
      .catch((e: unknown) => e);
    expect((error as ClientError).status).toBe(401);
    expect(other.authStore.isValid).toBe(false);
    // The session that changed the password stays signed in.
    expect((await nb.getSession())?.record.id).toBe(me.id);
    expect(changes.length).toBeGreaterThanOrEqual(2);
  });

  it("lists, pages and finds records with safe filters", async () => {
    const nb = await signUp("bo@example.com");
    const owner = nb.authStore.record?.id as string;
    const notes = nb.collection<Note>("notes");
    const titles = ["alpha", 'quote "q"', "back\\slash", "delta", "echo"];
    for (const [rank, title] of titles.entries()) {
      const note = await notes.create({ title, owner, rank });
      expect(note).toMatchObject({ title, rank });
    }

    const page = await notes.getList(1, 2, { sort: "rank" });
    expect(page).toMatchObject({
      page: 1,
      perPage: 2,
      totalItems: 5,
      totalPages: 3,
    });
    expect(page.items.map((n) => n.title)).toEqual(["alpha", 'quote "q"']);

    expect(
      (await notes.getFullList({ batch: 2, sort: "-rank" })).map((n) => n.rank),
    ).toEqual([4, 3, 2, 1, 0]);
    await expect(notes.getFullList({ batch: 0 })).rejects.toThrow(RangeError);

    for (const title of titles) {
      const found = await notes.getFirstListItem(
        nb.filter("title = {:title}", { title }),
      );
      expect(found.title).toBe(title);
    }
    const missing = await notes
      .getFirstListItem(nb.filter("title = {:t}", { t: "none" }))
      .catch((e: unknown) => e);
    expect((missing as ClientError).status).toBe(404);

    const one = await notes.getOne(page.items[0]?.id as string, {
      expand: "owner",
      fields: "title,expand.owner.name",
    });
    expect(one).toEqual({ title: "alpha", expand: { owner: { name: "bo" } } });

    // Another user sees none of them.
    const stranger = await signUp("cy@example.com");
    expect(
      (await stranger.collection<Note>("notes").getList()).totalItems,
    ).toBe(0);
  });

  it("returns field errors and null for records the caller may not view", async () => {
    const nb = await signUp("di@example.com");
    const owner = nb.authStore.record?.id as string;
    const invalid = await nb
      .collection("notes")
      .create({ owner })
      .catch((e: unknown) => e);
    expect(invalid).toBeInstanceOf(ClientError);
    expect((invalid as ClientError).status).toBe(400);
    expect((invalid as ClientError).data).toMatchObject({
      title: { code: "validation_required" },
    });

    // Created, then handed to another owner: the caller can no longer view it.
    const note = (await nb
      .collection<Note>("notes")
      .create({ title: "x", owner })) as Note;
    const other = await signUp("ed@example.com");
    expect(
      await admin
        .collection("notes")
        .update(note.id, { owner: other.authStore.record?.id }),
    ).toMatchObject({ id: note.id });
    const notFound = await nb
      .collection("notes")
      .getOne(note.id)
      .catch((e: unknown) => e);
    expect((notFound as ClientError).status).toBe(404);

    const anonymous = nextbase.client();
    expect(
      await anonymous.collection("users").create({
        email: "fay@example.com",
        password: "password 123 456",
        passwordConfirm: "password 123 456",
      }),
    ).toBe(null);
  });

  it("signs up and in with one call", async () => {
    const nb = nextbase.client();
    const signedUp = await nb.collection("users").signUp({
      email: "una@example.com",
      name: "Una",
      password: "password 123 456",
      passwordConfirm: "password 123 456",
    });
    expect(signedUp?.token).toMatch(/^[\w-]{43}$/);
    expect(signedUp?.record).toMatchObject({
      email: "una@example.com",
      name: "Una",
    });
    expect(nb.authStore.record?.email).toBe("una@example.com");
    expect((await nb.getSession())?.record.id).toBe(signedUp?.record.id);

    // Validation errors come back as usual, and nothing is created.
    const invalid = await nextbase
      .client()
      .collection("users")
      .signUp({
        email: "una@example.com",
        password: "short",
        passwordConfirm: "short",
      })
      .catch((e: unknown) => e);
    expect((invalid as ClientError).status).toBe(400);
    expect((invalid as ClientError).data).toMatchObject({
      password: { code: "validation_length_out_of_range" },
    });
    const duplicate = await nextbase
      .client()
      .collection("users")
      .signUp({
        email: "UNA@example.com",
        password: "password 123 456",
        passwordConfirm: "password 123 456",
      })
      .catch((e: unknown) => e);
    expect((duplicate as ClientError).data).toMatchObject({
      email: { code: "validation_not_unique" },
    });
  });

  it("creates the account but signs nobody in while the auth rule says no", async () => {
    await admin.collections.create({
      name: "members",
      type: "auth",
      createRule: "",
      authRule: "verified = true",
    });
    const nb = nextbase.client();
    expect(
      await nb.collection("members").signUp({
        email: "vic@example.com",
        password: "password 123 456",
        passwordConfirm: "password 123 456",
      }),
    ).toBeNull();
    expect(nb.authStore.isValid).toBe(false);
    expect(
      (
        await admin
          .collection("members")
          .getFirstListItem('email = "vic@example.com"')
      ).verified,
    ).toBe(false);

    // A collection without public sign-up refuses it.
    await admin.collections.create({ name: "staff", type: "auth" });
    const closed = await nextbase
      .client()
      .collection("staff")
      .signUp({
        email: "x@example.com",
        password: "password 123 456",
        passwordConfirm: "password 123 456",
      })
      .catch((e: unknown) => e);
    expect((closed as ClientError).status).toBe(403);
    expect((await admin.collection("staff").getList()).totalItems).toBe(0);
    // Base collections have no accounts.
    const base = await nb
      .collection("notes")
      .signUp({ title: "x" })
      .catch((e: unknown) => e);
    expect((base as ClientError).status).toBe(404);
  });

  it("signs out after deleting the signed-in record", async () => {
    const nb = await signUp("gil@example.com");
    await nb.collection("users").delete(nb.authStore.record?.id as string);
    expect(nb.authStore.token).toBe("");
    expect(nb.authStore.record).toBe(null);
  });

  it("completes first-run setup", async () => {
    const fresh = await createTestDatabase();
    try {
      const instance = new NextBase({ database: fresh.pool });
      const nb = instance.client();
      expect(await nb.setupStatus()).toEqual({ required: true });
      const error = await nb
        .setup({
          token: "forged",
          email: "root@example.com",
          password: "a long password",
        })
        .catch((e: unknown) => e);
      expect((error as ClientError).status).toBe(403);
      expect(await nb.setupStatus()).toEqual({ required: true });
    } finally {
      await fresh.close();
    }
  });
});
