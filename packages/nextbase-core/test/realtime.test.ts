import {
  AuthStore,
  type ClientError,
  type Collection,
  NextBaseClient,
  type RealtimeEvent,
  type RecordModel,
} from "@nextbasejs/client";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError, NextBase, type SmsMessage } from "../src/index.ts";
import { headCursor, readEvents, writeEvents } from "../src/realtime/events.ts";
import { timings } from "../src/realtime/timings.ts";
import { call, origin } from "./http.ts";
import { createTestDatabase, type TestDatabase } from "./postgres.ts";
import { waitFor } from "./wait.ts";

const PASSWORD = "password 123 456";
const ADMIN = "admin@example.com";
const ADMIN_PASSWORD = "admin password 123";

interface Message {
  type: string;
  id?: string;
  data?: Record<string, unknown>;
}

interface OpenStream {
  status: number;
  headers: Headers;
  /** The error body, when the stream was refused. */
  body: Record<string, unknown>;
  messages: Message[];
  /** The create, update and delete events, as the first topic got them. */
  records: () => { action: string; record: Record<string, unknown> }[];
  /** The id the client would send back in Last-Event-ID. */
  lastId: () => string | undefined;
  ended: () => boolean;
  close: () => Promise<void>;
}

/** Opens a realtime stream over HTTP and collects its messages. */
async function open(
  nextbase: NextBase,
  topics: Record<string, unknown>[],
  options: { token?: string; lastEventId?: string } = {},
): Promise<OpenStream> {
  const controller = new AbortController();
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.lastEventId) headers["last-event-id"] = options.lastEventId;
  const response = await nextbase.handle(
    new Request(`${origin}/api/nextbase/realtime`, {
      method: "POST",
      headers,
      body: JSON.stringify({ topics }),
      signal: controller.signal,
    }),
  );
  const messages: Message[] = [];
  let ended = false;
  let lastId: string | undefined;
  const reading = response.ok
    ? (async () => {
        const reader = (response.body as ReadableStream<Uint8Array>)
          .pipeThrough(new TextDecoderStream())
          .getReader();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += value;
          let end = buffer.indexOf("\n\n");
          while (end !== -1) {
            const message: Message = { type: "" };
            for (const line of buffer.slice(0, end).split("\n")) {
              const [field, ...rest] = line.split(": ");
              const value = rest.join(": ");
              if (field === "id") message.id = lastId = value;
              else if (field === "event") message.type = value;
              else if (field === "data") message.data = JSON.parse(value);
            }
            messages.push(message);
            buffer = buffer.slice(end + 2);
            end = buffer.indexOf("\n\n");
          }
        }
      })().finally(() => {
        ended = true;
      })
    : Promise.resolve();
  return {
    status: response.status,
    headers: response.headers,
    body: response.ok
      ? {}
      : ((await response.json()) as Record<string, unknown>),
    messages,
    records: () =>
      messages
        .filter((m) => ["create", "update", "delete"].includes(m.type))
        .map((m) => ({
          action: m.type,
          record: (m.data?.topics as Record<string, Record<string, unknown>>)?.[
            "0"
          ] as Record<string, unknown>,
        })),
    lastId: () => lastId,
    ended: () => ended,
    close: async () => {
      controller.abort();
      await reading.catch(() => {});
    },
  };
}

/** A promise with its resolve, to hold a hook until a test lets it go. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** How many connections of the test database are listening for events. */
async function listeners(t: TestDatabase): Promise<number> {
  const { rows } = await t.pool.query(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND query = 'LISTEN nextbase_realtime'",
  );
  return rows[0].n as number;
}

/** Wraps `pool` to count the queries sent to Postgres, including those in transactions. */
function counting(pool: pg.Pool): {
  pool: pg.Pool;
  trips: () => number;
  peek: () => number;
} {
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
    peek: () => count,
  };
}

describe("realtime", () => {
  const defaults = { ...timings };
  let t: TestDatabase;
  let nextbase: NextBase;
  let admin: NextBaseClient;
  const pending: Promise<unknown>[] = [];
  const texts: SmsMessage[] = [];
  const people = ["alice", "bob", "carol", "dave"] as const;
  const tokens = { alice: "", bob: "", carol: "", dave: "", admin: "" };
  const ids = { alice: "", bob: "", carol: "", dave: "" };
  let slow = gate();
  let entered = gate();
  const streams: OpenStream[] = [];

  const flush = async (): Promise<void> => {
    while (pending.length > 0) await Promise.all(pending.splice(0));
  };
  const signIn = async (email: string, password = PASSWORD) =>
    (
      await call(nextbase, "POST", "/collections/users/auth-with-password", {
        body: { identity: email, password },
      })
    ).body.token as string;
  const subscribe = async (
    topics: Record<string, unknown>[],
    options: { token?: string; lastEventId?: string; via?: NextBase } = {},
  ): Promise<OpenStream> => {
    const stream = await open(options.via ?? nextbase, topics, options);
    streams.push(stream);
    if (stream.status === 200) {
      // Subscribed once the first message, the cursor, arrives.
      await waitFor(() => stream.messages.length > 0, "the stream to start");
    }
    return stream;
  };
  /**
   * Waits until `stream` got `n` record events whose records `keep` keeps.
   * A stream may also get writes committed shortly before it started, which
   * a transaction of another test file, on another database of the server,
   * held back. So tests count only their own records.
   */
  const received = async (
    stream: OpenStream,
    n: number,
    keep: (record: Record<string, unknown>) => boolean = () => true,
  ) => {
    const kept = () => stream.records().filter((e) => keep(e.record));
    await waitFor(() => kept().length >= n, `${n} events`);
    return kept();
  };

  beforeAll(async () => {
    Object.assign(timings, {
      pollMs: 30,
      reconnectMs: 20,
      maxReconnectMs: 100,
      heartbeatMs: 100,
      sessionMs: 50,
      purgeMs: 0,
    });
    t = await createTestDatabase();
    nextbase = new NextBase({
      database: t.pool,
      waitUntil: (promise) => pending.push(promise),
      sms: {
        countries: ["TZ"],
        send: async (message) => {
          texts.push(message);
        },
      },
      realtime: {
        collections: [
          "users",
          "rooms",
          "messages",
          "posts",
          "comments",
          "locked",
          "items",
          "lounge",
        ],
        listenUrl: t.url,
      },
      hooks: {
        items: {
          async onCreate(e) {
            if (e.record.title === "slow") {
              entered.open();
              await slow.promise;
            }
            if (e.record.title === "boom") throw new ApiError(400, "Boom.");
          },
        },
      },
    });
    await nextbase.createSuperuser(ADMIN, ADMIN_PASSWORD);
    admin = nextbase.client({ superuser: true });
    const users = await admin.collections.create({
      name: "users",
      type: "auth",
      phoneSignIn: true,
      identityFields: ["email", "phone"],
      createRule: "",
      listRule: "",
      viewRule: "",
      updateRule: "id = @request.auth.id",
      fields: [{ name: "name", type: "text" }],
    });
    const rooms = await admin.collections.create({
      name: "rooms",
      listRule: "",
      viewRule: "",
      fields: [{ name: "name", type: "text" }],
    });
    await admin.collections.create({
      name: "messages",
      listRule: "public = true || author = @request.auth.id",
      viewRule: "public = true || author = @request.auth.id",
      createRule: "author = @request.auth.id",
      updateRule: "author = @request.auth.id",
      fields: [
        { name: "text", type: "text" },
        { name: "public", type: "bool" },
        { name: "secret", type: "text", hidden: true },
        { name: "room", type: "relation", collectionId: rooms.id },
        {
          name: "author",
          type: "relation",
          collectionId: users.id,
          maxSelect: 1,
        },
      ],
    });
    const posts = await admin.collections.create({
      name: "posts",
      listRule: "",
      viewRule: "",
      fields: [{ name: "title", type: "text" }],
    });
    await admin.collections.create({
      name: "comments",
      listRule: "",
      viewRule: "",
      fields: [
        { name: "text", type: "text" },
        {
          name: "post",
          type: "relation",
          collectionId: posts.id,
          cascadeDelete: true,
        },
      ],
    });
    await admin.collections.create({
      name: "locked",
      fields: [{ name: "text", type: "text" }],
    });
    await admin.collections.create({
      name: "items",
      listRule: "",
      viewRule: "",
      fields: [{ name: "title", type: "text", required: true }],
    });
    await admin.collections.create({
      name: "lounge",
      listRule: '@request.auth.name = "vip"',
      viewRule: '@request.auth.name = "vip"',
      fields: [{ name: "text", type: "text" }],
    });
    await admin.collections.create({
      name: "notes",
      listRule: "",
      viewRule: "",
      fields: [{ name: "text", type: "text" }],
    });
    for (const name of people) {
      const record = await admin.collection("users").create({
        email: `${name}@example.com`,
        name,
        password: PASSWORD,
        passwordConfirm: PASSWORD,
      });
      ids[name] = record?.id ?? "";
      tokens[name] = await signIn(`${name}@example.com`);
    }
    tokens.admin = (
      await call(
        nextbase,
        "POST",
        "/collections/_superusers/auth-with-password",
        {
          body: { identity: ADMIN, password: ADMIN_PASSWORD },
        },
      )
    ).body.token as string;
  });

  afterAll(async () => {
    await Promise.all(streams.map((s) => s.close()));
    await waitFor(async () => (await listeners(t)) === 0, "listeners to stop");
    await flush();
    Object.assign(timings, defaults);
    await t.close();
  });

  it("sends creates, updates and deletes once, in order, as a list would return them", async () => {
    const stream = await subscribe(
      [{ collection: "messages", expand: "author" }],
      { token: tokens.alice },
    );
    const created = await admin.collection("messages").create({
      text: "hello",
      public: true,
      secret: "s",
      author: ids.bob,
    });
    const id = created?.id as string;
    await admin.collection("messages").update(id, { text: "edited" });
    await admin.collection("messages").delete(id);
    expect(stream.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(stream.headers.get("cache-control")).toBe("no-store, no-transform");
    const events = await received(stream, 3, (r) => r.id === id);
    expect(events.map((e) => e.action)).toEqual(["create", "update", "delete"]);
    expect(events.map((e) => e.record.text)).toEqual([
      "hello",
      "edited",
      // A delete sends the record as it was.
      "edited",
    ]);
    for (const { record } of events) {
      expect(record.id).toBe(id);
      expect(record.collectionName).toBe("messages");
      expect(record).not.toHaveProperty("secret");
      // Bob's email is not visible to Alice, as in a list.
      expect(record.expand).toMatchObject({
        author: { id: ids.bob, name: "bob", email: "" },
      });
      expect(record.expand).not.toHaveProperty("author.password");
      expect(record.expand).not.toHaveProperty("author.tokenKey");
    }
    // Ids increase in commit order.
    const order = stream.messages
      .filter((m) => m.type !== "")
      .map((m) => m.id as string);
    expect([...order].sort(byId)).toEqual(order);
    expect(stream.lastId()).toBe(order.at(-1));
  });

  it("shapes records with fields, and shows a record's own email to it", async () => {
    const shaped = await subscribe(
      [{ collection: "messages", fields: "id,text" }],
      { token: tokens.alice },
    );
    const own = await subscribe([{ collection: "users", id: ids.alice }], {
      token: tokens.alice,
    });
    const other = await subscribe([{ collection: "users", id: ids.alice }], {
      token: tokens.bob,
    });
    await admin.collection("messages").create({ text: "fields", public: true });
    await admin.collection("users").update(ids.alice, { name: "Alice" });
    const [message] = await received(shaped, 1, (r) => r.text === "fields");
    expect(Object.keys(message?.record ?? {})).toEqual(["id", "text"]);
    const renamed = (r: Record<string, unknown>) => r.name === "Alice";
    const [mine] = await received(own, 1, renamed);
    expect(mine?.record).toMatchObject({
      name: "Alice",
      email: "alice@example.com",
    });
    expect(mine?.record).not.toHaveProperty("password");
    expect(mine?.record).not.toHaveProperty("tokenKey");
    const [theirs] = await received(other, 1, renamed);
    expect(theirs?.record).toMatchObject({ name: "Alice", email: "" });
  });

  it("sends each subscriber only what its rules and filter allow", async () => {
    const bob = await subscribe([{ collection: "messages" }], {
      token: tokens.bob,
    });
    const anonymous = await subscribe([{ collection: "messages" }]);
    const superuser = await subscribe([{ collection: "messages" }], {
      token: tokens.admin,
    });
    const filtered = await subscribe(
      [{ collection: "messages", filter: 'text ~ "match"' }],
      { token: tokens.alice },
    );
    const alice = nextbase.client();
    alice.authStore.save(tokens.alice as string, null);
    const hidden = await alice
      .collection("messages")
      .create({ text: "private match", author: ids.alice });
    await alice
      .collection("messages")
      .create({ text: "public", public: true, author: ids.alice });
    // One record, under the view rule.
    const one = await subscribe(
      [{ collection: "messages", id: hidden?.id as string }],
      { token: tokens.bob },
    );
    const mine = await subscribe(
      [{ collection: "messages", id: hidden?.id as string }],
      { token: tokens.alice },
    );
    await alice
      .collection("messages")
      .update(hidden?.id as string, { text: "private match 2" });
    await alice
      .collection("messages")
      .create({ text: "last", public: true, author: ids.alice });

    const written = ["private match", "public", "private match 2", "last"];
    const ours = (r: Record<string, unknown>) =>
      written.includes(r.text as string);
    const texts = async (s: OpenStream, n: number) =>
      (await received(s, n, ours)).map((e) => e.record.text);
    expect(await texts(bob, 2)).toEqual(["public", "last"]);
    expect(await texts(anonymous, 2)).toEqual(["public", "last"]);
    expect(await texts(superuser, 4)).toEqual(written);
    expect(await texts(filtered, 2)).toEqual([
      "private match",
      "private match 2",
    ]);
    await received(mine, 1, (r) => r.text === "private match 2");
    // Bob got the last event, so he would have got the update by now.
    await waitFor(
      () => one.lastId() === superuser.lastId(),
      "the stream to pass the update",
    );
    expect(one.records()).toEqual([]);
  });

  it("refuses topics a list or view request would refuse", async () => {
    const refused = async (
      topics: Record<string, unknown>[],
      token?: string,
    ) => {
      const stream = await subscribe(topics, { ...(token && { token }) });
      return { status: stream.status, body: stream.body };
    };
    const locked = await refused(
      [{ collection: "rooms" }, { collection: "locked" }],
      tokens.alice,
    );
    expect(locked.status).toBe(403);
    expect(locked.body.data).toEqual({
      topics: {
        1: {
          code: "realtime_topic_refused",
          message: "Only superusers can perform this action.",
        },
      },
    });
    expect(
      (await refused([{ collection: "locked" }], tokens.admin)).status,
    ).toBe(200);
    expect((await refused([{ collection: "notes" }])).status).toBe(400);
    expect(
      (await refused([{ collection: "_superusers" }], tokens.admin)).status,
    ).toBe(400);
    expect((await refused([{ collection: "missing" }])).status).toBe(404);
    expect(
      (await refused([{ collection: "rooms", filter: "nope = 1" }])).status,
    ).toBe(400);
    expect(
      (await refused([{ collection: "rooms", expand: "a.b.c.d.e.f.g" }]))
        .status,
    ).toBe(400);
    expect(
      (await refused([{ collection: "rooms", id: "bad id" }])).status,
    ).toBe(404);
    expect((await refused([])).status).toBe(400);
    expect((await refused([{ collection: 1 }])).status).toBe(400);
    expect(
      (
        await refused(
          Array.from({ length: 51 }, () => ({ collection: "rooms" })),
        )
      ).status,
    ).toBe(400);
    const malformed = await open(nextbase, [{ collection: "rooms" }], {
      lastEventId: "nope",
    });
    expect(malformed.status).toBe(400);
  });

  it("sends nothing for writes that roll back", async () => {
    const stream = await subscribe([{ collection: "items" }], {
      token: tokens.admin,
    });
    await expect(
      admin.collection("items").create({ title: "boom" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      admin
        .createBatch()
        .collection("items")
        .create({ title: "batched" })
        .collection("items")
        .create({ title: "" })
        .send(),
    ).rejects.toMatchObject({ status: 400 });
    await admin
      .createBatch()
      .collection("items")
      .create({ title: "one" })
      .collection("items")
      .create({ title: "two" })
      .collection("items")
      .create({ title: "three" })
      .send();
    const events = await received(stream, 3);
    expect(events.map((e) => e.record.title)).toEqual(["one", "two", "three"]);
    const { rows } = await t.pool.query(
      "SELECT count(*)::int AS n FROM nextbase._realtime_events WHERE record->>'title' IN ('boom', 'batched')",
    );
    expect(rows[0].n).toBe(0);
  });

  it("sends cascades, cleared relations and NextBase's own writes", async () => {
    const stream = await subscribe(
      [
        { collection: "comments" },
        { collection: "messages" },
        { collection: "users" },
      ],
      { token: tokens.admin },
    );
    const post = await admin.collection("posts").create({ title: "p" });
    const comment = await admin
      .collection("comments")
      .create({ text: "c", post: post?.id });
    const room = await admin.collection("rooms").create({ name: "r" });
    const message = await admin
      .collection("messages")
      .create({ text: "in room", room: room?.id });
    await admin.collection("posts").delete(post?.id as string);
    await admin.collection("rooms").delete(room?.id as string);
    // A sign-up with a texted code: NextBase creates the record itself.
    const phone = "+255712345678";
    const nb = nextbase.client();
    await nb.collection("users").requestPhoneCode(phone);
    await flush();
    const code = /\b(\d{6})\b/.exec(texts.at(-1)?.text ?? "")?.[1] as string;
    await nb.collection("users").signInWithPhoneCode(phone, code);

    const ours = [comment?.id, message?.id];
    const events = () =>
      stream.messages
        .filter((m) => m.data?.topics)
        .map((m) => {
          const [[topic, record]] = Object.entries(
            m.data?.topics as Record<string, Record<string, unknown>>,
          ) as [[string, Record<string, unknown>]];
          return { action: m.type, topic, record };
        })
        .filter(
          ({ record }) =>
            ours.includes(record.id as string) || record.phone === phone,
        );
    await waitFor(() => events().length >= 5, "5 events");
    expect(
      events().map(({ action, topic, record }) => [action, topic, record.id]),
    ).toEqual([
      ["create", "0", comment?.id],
      ["create", "1", message?.id],
      // The cascade deletes the comment, and the room leaves the message.
      ["delete", "0", comment?.id],
      ["update", "1", message?.id],
      ["create", "2", expect.any(String)],
    ]);
    expect(events()[3]?.record.room).toBe("");
    expect(events()[4]?.record.phone).toBe(phone);
  });

  it("never logs superusers, nor collections without realtime", async () => {
    await nextbase.createSuperuser("second@example.com", ADMIN_PASSWORD);
    await admin.collection("notes").create({ text: "n" });
    const { rows } = await t.pool.query(
      "SELECT count(*)::int AS n FROM nextbase._realtime_events WHERE collection_id IN ('_superusers', (SELECT id FROM nextbase._collections WHERE name = 'notes'))",
    );
    expect(rows[0].n).toBe(0);
  });

  it("waits for a transaction that started writing first, so none is skipped", async () => {
    const stream = await subscribe([{ collection: "items" }], {
      token: tokens.admin,
    });
    slow = gate();
    entered = gate();
    const writing = admin.collection("items").create({ title: "slow" });
    // The slow create logged its event and holds its transaction open.
    await entered.promise;
    await admin.collection("items").create({ title: "fast" });
    slow.open();
    await writing;
    const events = await received(stream, 2, (r) =>
      ["slow", "fast"].includes(r.title as string),
    );
    expect(events.map((e) => e.record.title)).toEqual(["slow", "fast"]);
  });

  it("reads events again that wait behind a transaction that never notifies", async () => {
    // The stream's instance counts its queries, so the test knows when it
    // has read the log.
    const counted = counting(t.pool);
    const watcher = new NextBase({
      database: counted.pool,
      realtime: { collections: ["items"], listenUrl: t.url },
    });
    const before = await listeners(t);
    const stream = await subscribe([{ collection: "items" }], {
      via: watcher,
    });
    // Listening, so it no longer polls, which would count too.
    await waitFor(async () => (await listeners(t)) > before, "a listener");
    const blocker = new pg.Client({ connectionString: t.url });
    await blocker.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_current_xact_id()");
      await admin.collection("items").create({ title: "held" });
      counted.trips();
      // BEGIN, the read and COMMIT: the stream read the log, and found the
      // event waiting behind the blocker.
      await waitFor(() => counted.peek() >= 3, "the stream to read the log");
      const held = (r: Record<string, unknown>) => r.title === "held";
      expect(stream.records().filter((e) => held(e.record))).toEqual([]);
      // It writes no events, so its end notifies nothing.
      await blocker.query("COMMIT");
    } finally {
      await blocker.end();
    }
    const events = await received(stream, 1, (r) => r.title === "held");
    expect(events.map((e) => e.record.title)).toEqual(["held"]);
  });

  it("reads no event behind a transaction still running", async () => {
    const collection = { id: "gap", fields: [] } as unknown as Collection;
    const start = await headCursor(t.db);
    const read = () => readEvents(t.db, start, ["gap"], 500);
    const early = await t.db.begin();
    try {
      // The early transaction logs its event first, then the late one
      // commits: the late event waits, or a cursor would pass the early one.
      await writeEvents(early, collection, "create", [{ id: "early" }]);
      await t.db.transaction((late) =>
        writeEvents(late, collection, "create", [{ id: "late" }]),
      );
      const waiting = await read();
      expect(waiting.events).toEqual([]);
      expect(waiting.held).toBe(true);
      await early.commit();
    } finally {
      if (!early.done) await early.rollback();
    }
    // Transactions of other test files, on other databases of the server,
    // can hold both back a while longer: transaction ids are server-wide.
    await waitFor(async () => {
      const ids = (await read()).events.map((e) => e.recordId);
      // Never the late one without the early one.
      expect(ids).toEqual(["early", "late"].slice(0, ids.length));
      return ids.length === 2;
    }, "the events");
    await t.pool.query(
      "DELETE FROM nextbase._realtime_events WHERE collection_id = 'gap'",
    );
  });

  it("resumes after the last event id, without losing or repeating events", async () => {
    const first = await subscribe([{ collection: "rooms" }], {
      token: tokens.alice,
    });
    const start = first.lastId();
    expect(start).toMatch(/^\d+\.\d+$/);
    await first.close();
    await admin.collection("rooms").create({ name: "missed 1" });
    await admin.collection("rooms").create({ name: "missed 2" });
    const resumed = await subscribe([{ collection: "rooms" }], {
      token: tokens.alice,
      lastEventId: start as string,
    });
    const missed = (r: Record<string, unknown>) =>
      String(r.name).startsWith("missed");
    const events = await received(resumed, 2, missed);
    expect(events.map((e) => e.record.name)).toEqual(["missed 1", "missed 2"]);
    const afterOne = resumed.messages.find(
      (m) =>
        (m.data?.topics as Record<string, Record<string, unknown>>)?.["0"]
          ?.name === "missed 1",
    )?.id as string;
    const again = await subscribe([{ collection: "rooms" }], {
      token: tokens.alice,
      lastEventId: afterOne,
    });
    const rest = await received(again, 1, missed);
    expect(rest.map((e) => e.record.name)).toEqual(["missed 2"]);
  });

  it("resets a subscriber whose events were deleted as too old", async () => {
    const first = await subscribe([{ collection: "rooms" }], {
      token: tokens.alice,
    });
    const old = first.lastId() as string;
    await first.close();
    await admin.collection("rooms").create({ name: "forgotten" });
    await t.pool.query(
      "UPDATE nextbase._realtime_events SET created = now() - interval '1 day'",
    );
    // A write deletes old events in the background.
    await admin.collection("rooms").create({ name: "kept" });
    await flush();
    const stream = await subscribe([{ collection: "rooms" }], {
      token: tokens.alice,
      lastEventId: old,
    });
    await waitFor(
      () => stream.messages.some((m) => m.type === "reset"),
      "a reset",
    );
    await admin.collection("rooms").create({ name: "after" });
    await received(stream, 1, (r) => r.name === "after");
    expect(stream.records().map((e) => e.record.name)).not.toContain(
      "forgotten",
    );

    // An id from the future resets too.
    const future = await subscribe([{ collection: "rooms" }], {
      lastEventId: "99999999999.1",
    });
    expect(future.messages[0]?.type).toBe("reset");
  });

  it("ends the stream when its session ends", async () => {
    const carol = await subscribe([{ collection: "rooms" }], {
      token: tokens.carol,
    });
    await call(nextbase, "DELETE", "/session", { token: tokens.carol });
    await waitFor(carol.ended, "the stream to end");
    expect(carol.messages.at(-1)).toEqual({
      type: "end",
      data: { reason: "signed_out" },
    });

    // A password change ends the record's other sessions.
    const other = await signIn("dave@example.com");
    const dave = await subscribe([{ collection: "rooms" }], {
      token: tokens.dave,
    });
    const reply = await call(
      nextbase,
      "PATCH",
      `/collections/users/records/${ids.dave}`,
      {
        token: other,
        body: {
          oldPassword: PASSWORD,
          password: "a new password 1",
          passwordConfirm: "a new password 1",
        },
      },
    );
    expect(reply.status).toBe(200);
    await waitFor(dave.ended, "the stream to end");
    expect(dave.messages.at(-1)?.data).toEqual({ reason: "signed_out" });
  });

  it("checks rules with the signed-in record as it is now", async () => {
    const lounge = await subscribe([{ collection: "lounge" }], {
      token: tokens.bob,
    });
    await admin.collection("users").update(ids.bob, { name: "vip" });
    // Once the stream reads the session again, Bob's new name lets him in.
    let n = 0;
    await waitFor(async () => {
      await admin.collection("lounge").create({ text: `after ${n++}` });
      return lounge.records().length > 0;
    }, "a record let in by the new name");
    await admin.collection("users").update(ids.bob, { name: "bob" });
  });

  it("ends the stream after streamSeconds", async () => {
    const short = new NextBase({
      database: t.pool,
      realtime: { collections: true, listenUrl: t.url, streamSeconds: 0.2 },
    });
    const stream = await subscribe([{ collection: "rooms" }], { via: short });
    await waitFor(stream.ended, "the stream to end");
    expect(stream.messages.at(-1)).toEqual({
      type: "end",
      data: { reason: "timeout" },
    });
  });

  it("delivers writes made through another instance, and polls when it cannot listen", async () => {
    const other = new NextBase({
      database: t.pool,
      realtime: { collections: true, listenUrl: t.url },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const deaf = new NextBase({
        database: t.pool,
        realtime: {
          collections: ["rooms"],
          listenUrl: "postgres://localhost:1/nextbase_none",
        },
      });
      const listening = await subscribe([{ collection: "rooms" }], {
        via: other,
      });
      const polling = await subscribe([{ collection: "rooms" }], {
        via: deaf,
      });
      await admin.collection("rooms").create({ name: "elsewhere" });
      const elsewhere = (r: Record<string, unknown>) => r.name === "elsewhere";
      await received(listening, 1, elsewhere);
      await received(polling, 1, elsewhere);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/cannot listen/);
      await polling.close();
      await listening.close();
    } finally {
      warn.mockRestore();
    }
  });

  it("holds no connection while idle, and stops listening once streams close", async () => {
    await Promise.all(streams.map((s) => s.close()));
    await waitFor(async () => (await listeners(t)) === 0, "listeners to stop");
    const stream = await subscribe([{ collection: "rooms" }]);
    await waitFor(async () => (await listeners(t)) === 1, "a listener");
    await admin.collection("rooms").create({ name: "idle" });
    await received(stream, 1, (r) => r.name === "idle");
    await waitFor(
      () => t.pool.totalCount === t.pool.idleCount,
      "connections to return to the pool",
    );
    await stream.close();
    await waitFor(async () => (await listeners(t)) === 0, "listeners to stop");
  });

  it("logs a batch's creates with one statement, so they stay together", async () => {
    // Old events are deleted on the first write only, out of the count.
    timings.purgeMs = 60_000;
    const counted = counting(t.pool);
    const instance = new NextBase({
      database: counted.pool,
      realtime: { collections: ["rooms"], listenUrl: t.url },
    });
    const client = instance.client({ superuser: true });
    const batch = (n: number) => {
      const b = client.createBatch();
      for (let i = 0; i < n; i++)
        b.collection("rooms").create({ name: `b${i}` });
      return b.send();
    };
    await batch(2);
    counted.trips();
    // Two creates take as many queries as twenty.
    await batch(2);
    const two = counted.trips();
    await batch(20);
    expect(counted.trips()).toBe(two);
    timings.purgeMs = 0;
  });
});

describe("realtime client", () => {
  const defaults = { ...timings };
  let t: TestDatabase;
  let nextbase: NextBase;
  let admin: NextBaseClient;
  let userId: string;

  /** A browser-like client that talks to `nextbase` over its handler. */
  const browser = (): NextBaseClient =>
    new NextBaseClient({
      baseUrl: `${origin}/api/nextbase`,
      fetch: (input, init) => nextbase.handle(new Request(input, init)),
      authStore: new AuthStore({ storage: null }),
    });

  beforeAll(async () => {
    Object.assign(timings, { pollMs: 30, sessionMs: 50, heartbeatMs: 100 });
    t = await createTestDatabase();
    nextbase = new NextBase({
      database: t.pool,
      realtime: { collections: true, listenUrl: t.url, streamSeconds: 0.3 },
    });
    admin = nextbase.client({ superuser: true });
    await admin.collections.create({
      name: "users",
      type: "auth",
      listRule: "",
      viewRule: "",
      fields: [{ name: "name", type: "text" }],
    });
    await admin.collections.create({
      name: "tasks",
      listRule: '@request.auth.id != ""',
      viewRule: '@request.auth.id != ""',
      fields: [{ name: "title", type: "text" }],
    });
    await admin.collections.create({
      name: "secrets",
      fields: [{ name: "text", type: "text" }],
    });
    userId =
      (
        await admin.collection("users").create({
          email: "user@example.com",
          password: PASSWORD,
          passwordConfirm: PASSWORD,
        })
      )?.id ?? "";
  });

  afterAll(async () => {
    await waitFor(async () => (await listeners(t)) === 0, "listeners to stop");
    Object.assign(timings, defaults);
    await t.close();
  });

  it("subscribes, survives stream ends without losing events, and unsubscribes", async () => {
    const nb = browser();
    await nb
      .collection("users")
      .signInWithPassword("user@example.com", PASSWORD);
    const tasks: RealtimeEvent[] = [];
    const users: RealtimeEvent[] = [];
    const offTasks = nb
      .collection("tasks")
      .subscribe("*", (e) => tasks.push(e), { fields: "id,title" });
    const offUser = nb
      .collection("users")
      .subscribe(userId, (e) => users.push(e));
    // Streams end every 0.3 seconds; writes across several are all sent once.
    for (let i = 0; i < 6; i++) {
      await admin.collection("tasks").create({ title: `t${i}` });
      await waitFor(() => tasks.length > i, `task ${i}`);
    }
    await admin.collection("users").update(userId, { name: "renamed" });
    // Its create may come too, if held back until the stream started.
    const updates = () => users.filter((e) => e.action === "update");
    await waitFor(() => updates().length === 1, "the user update");
    expect(tasks.map((e) => e.record.title)).toEqual(
      Array.from({ length: 6 }, (_, i) => `t${i}`),
    );
    expect(Object.keys(tasks[0]?.record ?? {})).toEqual(["id", "title"]);
    expect(updates()[0]).toMatchObject({
      action: "update",
      record: { id: userId, name: "renamed" },
    });
    offTasks();
    offUser();
    await waitFor(async () => (await listeners(t)) === 0, "the stream to stop");
  });

  it("starts over when the session changes, and reports refused topics", async () => {
    const nb = browser();
    const seen: RecordModel[] = [];
    const errors: ClientError[] = [];
    const off = nb
      .collection("tasks")
      .subscribe("*", (e) => seen.push(e.record));
    const refused = nb
      .collection("secrets")
      .subscribe("*", () => {}, { onError: (e) => errors.push(e) });
    await waitFor(() => errors.length === 1, "the refusal");
    expect(errors[0]?.status).toBe(403);
    refused();
    // Signed out, the list rule refuses every task.
    await admin.collection("tasks").create({ title: "unseen" });
    await nb
      .collection("users")
      .signInWithPassword("user@example.com", PASSWORD);
    await waitFor(async () => (await listeners(t)) === 1, "the stream");
    await admin.collection("tasks").create({ title: "seen" });
    await waitFor(
      () => seen.some((r) => r.title === "seen"),
      "the task seen once signed in",
    );
    off();
  });
});

function byId(a: string, b: string): number {
  const [at, as] = a.split(".").map(BigInt) as [bigint, bigint];
  const [bt, bs] = b.split(".").map(BigInt) as [bigint, bigint];
  if (at !== bt) return at < bt ? -1 : 1;
  return as < bs ? -1 : as > bs ? 1 : 0;
}
