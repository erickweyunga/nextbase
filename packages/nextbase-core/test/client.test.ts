import {
  type AuthStorage,
  AuthStore,
  ClientError,
  filter,
  NextBaseClient,
  type RealtimeEvent,
  type RecordModel,
} from "@nextbasejs/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseFilter } from "../src/filter/parser.ts";
import { NextBase } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "./postgres.ts";
import { waitFor } from "./wait.ts";

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
      isTimeout: false,
    });
  });

  it("tells aborts from timeouts, whatever the abort reason", async () => {
    // Rejects with the signal's reason, as fetch does.
    const nb = new NextBaseClient({
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    });
    const failure = (signal: AbortSignal) =>
      nb.health({ signal }).catch((e: unknown) => e);

    const timedOut = await failure(AbortSignal.timeout(5));
    expect(timedOut).toBeInstanceOf(ClientError);
    expect(timedOut).toMatchObject({
      status: 0,
      isAbort: false,
      isTimeout: true,
    });

    const controller = new AbortController();
    const reasoned = failure(controller.signal);
    controller.abort(new Error("The user left the page."));
    expect(await reasoned).toMatchObject({
      status: 0,
      isAbort: true,
      isTimeout: false,
    });

    const plain = new AbortController();
    const aborted = failure(plain.signal);
    plain.abort();
    expect(await aborted).toMatchObject({ isAbort: true, isTimeout: false });

    // Aborted while the body arrives, the request is not an invalid response.
    const reading = new AbortController();
    const slow = new NextBaseClient({
      fetch: async (_input, init) =>
        new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(new TextEncoder().encode('{"status"'));
              init?.signal?.addEventListener("abort", () =>
                stream.error(init.signal?.reason),
              );
            },
          }),
        ),
    });
    const body = slow
      .health({ signal: reading.signal })
      .catch((e: unknown) => e);
    reading.abort();
    expect(await body).toMatchObject({ status: 0, isAbort: true });
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

/**
 * A client whose requests wait until the test answers them, to finish
 * overlapping requests in any order.
 */
function heldClient() {
  const held: {
    method: string;
    path: string;
    body: string;
    answer(r: Response): void;
  }[] = [];
  const nb = new NextBaseClient({
    baseUrl: "http://example.test",
    fetch: (input, init) =>
      new Promise((resolve) => {
        held.push({
          method: init?.method ?? "GET",
          path: new URL(String(input)).pathname,
          body: typeof init?.body === "string" ? init.body : "",
          answer: resolve,
        });
      }),
  });
  // Answers the oldest matching request, or the one whose body contains
  // `sent`. Waits for it, as a method may do work before sending it.
  async function answer(
    method: string,
    path: string,
    body?: unknown,
    sent = "",
  ): Promise<void> {
    let i = -1;
    for (let tries = 0; i === -1 && tries < 100; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      i = held.findIndex(
        (r) => r.method === method && r.path === path && r.body.includes(sent),
      );
    }
    const [request] = held.splice(i, 1);
    if (!request) throw new Error(`No ${method} ${path} is in flight.`);
    request.answer(
      body instanceof Response
        ? body
        : body === undefined
          ? new Response(null, { status: 204 })
          : Response.json(body),
    );
  }
  return { nb, answer };
}

const user = (id: string): RecordModel => ({
  id,
  collectionId: "c1",
  collectionName: "users",
});

const currentSession = (record: RecordModel) => ({
  id: "s1",
  created: "2026-10-19T00:00:00.000Z",
  expires: "2026-10-26T00:00:00.000Z",
  userAgent: "",
  current: true,
  record,
});

describe("overlapping auth requests", () => {
  it("does not sign back in when getSession answers after a sign-out", async () => {
    const { nb, answer } = heldClient();
    nb.authStore.save("token-a", user("a"));
    const session = nb.getSession();
    const out = nb.signOut();
    await answer("DELETE", "/session");
    await out;
    await answer("GET", "/session", currentSession(user("a")));
    expect((await session)?.record.id).toBe("a");
    expect(nb.authStore.isValid).toBe(false);

    // Also for a cookie session, unknown to the store until getSession.
    const cookie = heldClient();
    const first = cookie.nb.getSession();
    const signOut = cookie.nb.signOut();
    await cookie.answer("DELETE", "/session");
    await signOut;
    await cookie.answer("GET", "/session", currentSession(user("a")));
    await first;
    expect(cookie.nb.authStore.isValid).toBe(false);
  });

  it("does not restore a session that ended while it was refreshed", async () => {
    const { nb, answer } = heldClient();
    nb.authStore.save("token-a", user("a"));
    const refresh = nb.collection("users").refreshSession();
    const out = nb.signOut();
    await answer("DELETE", "/session");
    await out;
    await answer("POST", "/collections/users/auth-refresh", {
      token: "token-a",
      record: user("a"),
    });
    await refresh;
    expect(nb.authStore.isValid).toBe(false);
  });

  it("keeps a sign-in made while an older session was being read", async () => {
    const { nb, answer } = heldClient();
    nb.authStore.save("token-a", user("a"));
    const session = nb.getSession();
    const signIn = nb.collection("users").signInWithPassword("b", "secret");
    await answer("POST", "/collections/users/auth-with-password", {
      token: "token-b",
      record: user("b"),
    });
    await signIn;
    await answer("GET", "/session", currentSession(user("a")));
    await session;
    expect(nb.authStore.token).toBe("token-b");
    expect(nb.authStore.record?.id).toBe("b");

    // A signed-out session answered after a sign-in signs nobody out.
    const late = nb.getSession();
    const again = nb.collection("users").signInWithPassword("c", "secret");
    await answer("POST", "/collections/users/auth-with-password", {
      token: "token-c",
      record: user("c"),
    });
    await again;
    await answer("GET", "/session", null);
    await late;
    expect(nb.authStore.record?.id).toBe("c");
  });

  it("keeps the latest sign-in or sign-out the user started", async () => {
    const { nb, answer } = heldClient();
    const users = nb.collection("users");
    // Answered in reverse order: the later sign-in wins.
    const first = users.signInWithPassword("a", "secret");
    const second = users.signInWithPassword("b", "secret");
    const signedIn = (id: string) =>
      answer(
        "POST",
        "/collections/users/auth-with-password",
        { token: `token-${id}`, record: user(id) },
        `"identity":"${id}"`,
      );
    await signedIn("b");
    await second;
    await signedIn("a");
    await first;
    expect(nb.authStore.record?.id).toBe("b");
    // In order, each saves its session.
    const third = users.signInWithPassword("c", "secret");
    const fourth = users.signInWithPassword("d", "secret");
    await signedIn("c");
    await third;
    expect(nb.authStore.record?.id).toBe("c");
    await signedIn("d");
    await fourth;
    expect(nb.authStore.record?.id).toBe("d");

    // A later sign-in that fails leaves the earlier one's session.
    const earlier = users.signInWithPassword("h", "secret");
    const failing = users.signInWithPassword("i", "wrong").catch(() => null);
    await answer(
      "POST",
      "/collections/users/auth-with-password",
      Response.json(
        { status: 400, message: "Failed to authenticate.", data: {} },
        { status: 400 },
      ),
      `"identity":"i"`,
    );
    await failing;
    await signedIn("h");
    await earlier;
    expect(nb.authStore.record?.id).toBe("h");

    // A sign-in answered after a later sign-out stays signed out.
    const signIn = users.signInWithPassword("e", "secret");
    const out = nb.signOut();
    await answer("DELETE", "/session");
    await out;
    await answer("POST", "/collections/users/auth-with-password", {
      token: "token-e",
      record: user("e"),
    });
    await signIn;
    expect(nb.authStore.isValid).toBe(false);

    // A sign-out answered after a later sign-in keeps the new session.
    nb.authStore.save("token-f", user("f"));
    const signOut = nb.signOut();
    const next = users.signInWithPassword("g", "secret");
    await answer("POST", "/collections/users/auth-with-password", {
      token: "token-g",
      record: user("g"),
    });
    await next;
    await answer("DELETE", "/session");
    await signOut;
    expect(nb.authStore.record?.id).toBe("g");
  });

  it("signs out after deleting the signed-in record only if it is still signed in", async () => {
    const { nb, answer } = heldClient();
    nb.authStore.save("token-a", user("a"));
    const deleted = nb.collection("users").delete("a");
    const signIn = nb.collection("users").signInWithPassword("b", "secret");
    await answer("POST", "/collections/users/auth-with-password", {
      token: "token-b",
      record: user("b"),
    });
    await signIn;
    await answer("DELETE", "/collections/users/records/a");
    await deleted;
    expect(nb.authStore.record?.id).toBe("b");
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
  afterAll(async () => {
    // Log entries still waiting would be written to an ended pool.
    await nextbase.flush();
    await t.close();
  });

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

  it("keeps the signed-in record current after an update that returns some fields", async () => {
    const nb = await signUp("fields@example.com");
    const me = nb.authStore.record as RecordModel;
    await nb
      .collection("users")
      .update(me.id, { name: "Cy" }, { fields: "id" });
    expect(nb.authStore.record).toMatchObject({ id: me.id, name: "Cy" });
  });

  it("stays signed in when signed in to another collection than a request needs", async () => {
    const nb = await signUp("elsewhere@example.com");
    const error = await nb
      .collection("_superusers")
      .refreshSession()
      .catch((e: unknown) => e);
    expect((error as ClientError).status).toBe(403);
    expect(nb.authStore.isValid).toBe(true);
  });

  it("signs out when a cookie session ends, which scripts cannot see", async () => {
    await signUp("cookie@example.com");
    // A browser: requests go over HTTP, carrying the session cookie.
    let cookie = "";
    const browser = new NextBaseClient({
      baseUrl: "http://localhost:3000/api/nextbase",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        request.headers.set("origin", "http://localhost:3000");
        if (cookie) request.headers.set("cookie", cookie);
        const response = await nextbase.handle(request);
        const set = /^nextbase_session=([^;]*)/.exec(
          response.headers.get("set-cookie") ?? "",
        );
        if (set) cookie = set[1] ? `nextbase_session=${set[1]}` : "";
        return response;
      },
      authStore: new AuthStore({ storage: null }),
    });
    const { record } = await browser
      .collection("users")
      .signInWithPassword("cookie@example.com", "password 123 456", {
        cookie: true,
      });
    expect(browser.authStore.token).toBe("");
    await browser.collection("notes").getList();
    expect(browser.authStore.isValid).toBe(true);
    // The session ends elsewhere, as when signed out on another device.
    await t.pool.query("DELETE FROM nextbase._sessions WHERE record_id = $1", [
      record.id,
    ]);
    await browser.collection("notes").getList();
    expect(browser.authStore.isValid).toBe(false);
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
      authRule: "emailVerified = true",
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
      ).emailVerified,
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

  it("expands and picks the record of a sign-up, sign-in and refresh", async () => {
    await admin.collections.create({
      name: "teams",
      // Rules see the account that signs in, not the anonymous caller.
      viewRule: "@request.auth.id != ''",
      fields: [{ name: "title", type: "text" }],
    });
    const team = await admin.collection("teams").create({ title: "Blue" });
    await admin.collections.create({
      name: "players",
      type: "auth",
      createRule: "",
      viewRule: "id = @request.auth.id",
      fields: [
        { name: "name", type: "text" },
        {
          name: "team",
          type: "relation",
          collectionId: (await admin.collections.getOne("teams")).id,
          maxSelect: 1,
        },
      ],
    });
    const players = nextbase.client().collection("players");
    const options = { expand: "team", fields: "id,name,expand.team.title" };
    const signedUp = await players.signUp(
      {
        email: "kim@example.com",
        password: "password 123 456",
        passwordConfirm: "password 123 456",
        name: "Kim",
        team: team?.id,
      },
      options,
    );
    const expected = {
      id: signedUp?.record.id,
      name: "Kim",
      expand: { team: { title: "Blue" } },
    };
    expect(signedUp?.record).toEqual(expected);

    const nb = nextbase.client();
    const signedIn = await nb
      .collection("players")
      .signInWithPassword("kim@example.com", "password 123 456", options);
    expect(signedIn.record).toEqual(expected);
    expect(
      (await nb.collection("players").refreshSession(options)).record,
    ).toEqual(expected);

    // A bad query is refused before a session starts.
    const sessions = async () =>
      (
        await t.pool.query(
          "SELECT count(*)::int AS n FROM nextbase._sessions WHERE record_id = $1",
          [expected.id],
        )
      ).rows[0].n;
    const before = await sessions();
    const tooDeep = await nextbase
      .client()
      .collection("players")
      .signInWithPassword("kim@example.com", "password 123 456", {
        expand: "a.b.c.d.e.f.g",
      })
      .catch((e: unknown) => e);
    expect((tooDeep as ClientError).status).toBe(400);
    expect(await sessions()).toBe(before);
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

interface FakeStream {
  headers: Headers;
  topics: Record<string, unknown>[];
  signal: AbortSignal;
  send(text: string): void;
  end(): void;
}

/**
 * A fake realtime endpoint. Each request gets a stream the test writes to,
 * or the next of `responses`, if any.
 */
function fakeRealtime(): {
  client: NextBaseClient;
  streams: FakeStream[];
  responses: Response[];
} {
  const streams: FakeStream[] = [];
  const responses: Response[] = [];
  const encoder = new TextEncoder();
  const client = new NextBaseClient({
    baseUrl: "https://app.example/api/nextbase",
    authStore: new AuthStore({ storage: null }),
    fetch: async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://app.example/api/nextbase/realtime");
      const { topics } = (await request.json()) as {
        topics: Record<string, unknown>[];
      };
      const prepared = responses.shift();
      if (prepared) return prepared;
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      request.signal.addEventListener("abort", () => {
        try {
          controller.error(request.signal.reason);
        } catch {
          // Already ended.
        }
      });
      streams.push({
        headers: request.headers,
        topics,
        signal: request.signal,
        send: (text) => controller.enqueue(encoder.encode(text)),
        end: () => controller.close(),
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return { client, streams, responses };
}

describe("realtime subscriptions", () => {
  it("multiplexes subscriptions and parses events however the stream splits them", async () => {
    const { client, streams } = fakeRealtime();
    const posts: RealtimeEvent[] = [];
    const one: RealtimeEvent[] = [];
    const offPosts = client
      .collection("posts")
      .subscribe("*", (e) => posts.push(e));
    const offOne = client
      .collection("users")
      .subscribe("u1", (e) => one.push(e), { filter: "a = 1", fields: "id" });
    await waitFor(() => streams.length === 1, "the stream");
    const [stream] = streams as [FakeStream];
    expect(stream.topics).toEqual([
      { collection: "posts" },
      { collection: "users", id: "u1", filter: "a = 1", fields: "id" },
    ]);
    expect(stream.headers.get("accept")).toBe("text/event-stream");
    expect(stream.headers.has("last-event-id")).toBe(false);
    // CRLF split between chunks, CR alone, comments, a field without a
    // value, data over two lines and an event of a type it does not know.
    for (const chunk of [
      "id: 1.1\n\n: ping\n\nid: 1.2\r",
      '\nevent: create\r\ndata: {"action":"create",',
      '\ndata: "topics":{"0":{"id":"p1"},"1":{"id":"u1"}}}\r\n\r',
      "\nevent: other\ndata: x\n\nevent: update\rdata",
      ': {"action":"update","topics":{"1":{"id":"u1","x":2}}}\r\r',
      "event: delete\ndata: {}\n",
    ]) {
      stream.send(chunk);
    }
    await waitFor(() => one.length === 2, "two events");
    expect(posts).toEqual([{ action: "create", record: { id: "p1" } }]);
    expect(one).toEqual([
      { action: "create", record: { id: "u1" } },
      { action: "update", record: { id: "u1", x: 2 } },
    ]);
    offPosts();
    offOne();
    await waitFor(() => stream.signal.aborted, "the abort");
    expect(streams).toHaveLength(1);
  });

  it("resumes after the last event id, at once after an end and after a wait on failure", async () => {
    const { client, streams } = fakeRealtime();
    const off = client.collection("posts").subscribe("*", () => {});
    await waitFor(() => streams.length === 1, "the stream");
    streams[0]?.send('id: 5.1\n\nevent: end\ndata: {"reason":"timeout"}\n\n');
    streams[0]?.end();
    await waitFor(() => streams.length === 2, "the second stream", 500);
    expect(streams[1]?.headers.get("last-event-id")).toBe("5.1");
    // Broken off without an end: the client waits before it reconnects.
    streams[1]?.send("id: 5.2\n\n");
    const broken = Date.now();
    streams[1]?.end();
    await waitFor(() => streams.length === 3, "the third stream", 3_000);
    expect(Date.now() - broken).toBeGreaterThanOrEqual(400);
    expect(streams[2]?.headers.get("last-event-id")).toBe("5.2");
    off();
    await waitFor(() => streams[2]?.signal.aborted === true, "the abort");
  });

  it("starts over when the session changes, and ends sessions the server ended", async () => {
    const { client, streams } = fakeRealtime();
    const off = client.collection("posts").subscribe("*", () => {});
    await waitFor(() => streams.length === 1, "the stream");
    expect(streams[0]?.headers.has("authorization")).toBe(false);
    client.authStore.save("token-1", { id: "u1" } as RecordModel);
    await waitFor(() => streams.length === 2, "the second stream");
    expect(streams[0]?.signal.aborted).toBe(true);
    expect(streams[1]?.headers.get("authorization")).toBe("Bearer token-1");
    streams[1]?.send('event: end\ndata: {"reason":"signed_out"}\n\n');
    streams[1]?.end();
    await waitFor(() => streams.length === 3, "the third stream");
    expect(client.authStore.isValid).toBe(false);
    expect(streams[2]?.headers.has("authorization")).toBe(false);
    off();
  });

  it("tells subscribers of resets and refusals, and survives callbacks that throw", async () => {
    const { client, streams, responses } = fakeRealtime();
    const resets: string[] = [];
    const errors: ClientError[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let off = (): void => {};
    try {
      responses.push(
        Response.json(
          {
            status: 403,
            message:
              "Topic 2 was refused: Only superusers can perform this action.",
            data: {
              topics: {
                1: { code: "realtime_topic_refused", message: "No." },
              },
            },
          },
          { status: 403 },
        ),
      );
      const seen: unknown[] = [];
      off = client.collection("posts").subscribe(
        "*",
        (e) => {
          seen.push(e.record.id);
          throw new Error("callback failed");
        },
        { onReset: () => resets.push("posts") },
      );
      client
        .collection("secrets")
        .subscribe("*", () => {}, { onError: (e) => errors.push(e) });
      await waitFor(() => streams.length === 1, "the stream");
      expect(errors.map((e) => e.status)).toEqual([403]);
      expect(streams[0]?.topics).toEqual([{ collection: "posts" }]);
      streams[0]?.send(
        'id: 1.1\nevent: create\ndata: {"action":"create","topics":{"0":{"id":"a"}}}\n\n' +
          "id: 2.0\nevent: reset\ndata: {}\n\n" +
          'id: 2.1\nevent: create\ndata: {"action":"create","topics":{"0":{"id":"b"}}}\n\n',
      );
      await waitFor(() => seen.length === 2, "both events");
      // Once when it went live, and once for the reset.
      expect(resets).toEqual(["posts", "posts"]);
      expect(error).toHaveBeenCalledTimes(2);
    } finally {
      error.mockRestore();
      off();
    }
  });
});
