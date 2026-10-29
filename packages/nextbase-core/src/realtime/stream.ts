import type { Collection } from "@nextbasejs/client";
import type { DB, Row, Tx } from "@nextbasejs/dbx";
import type { Principal } from "../auth/principal.ts";
import { bearerToken, findSession, sessionCookie } from "../auth/sessions.ts";
import { table } from "../db/system.ts";
import { ApiError } from "../errors.ts";
import { readJsonObject } from "../http.ts";
import {
  matchingRows,
  outputRecords,
  type RecordsContext,
  subscriptionCondition,
} from "../records/service.ts";
import { SCHEMA_RACE, type Schema, type SchemaCache } from "../schema/cache.ts";
import { CursorSigner } from "./cursor.ts";
import {
  type Cursor,
  compareCursors,
  type EventPage,
  eventRecord,
  headCursor,
  purgeEvents,
  readEvents,
  type StoredEvent,
} from "./events.ts";
import { type HubStream, PAGE, RealtimeHub } from "./hub.ts";
import { timings } from "./timings.ts";

/** Realtime subscriptions to records as they are created, updated and deleted. */
export interface RealtimeOptions<N extends string = string> {
  /** The collections that send events, by name, or `true` for all of them. */
  collections: true | readonly N[];
  /**
   * A direct connection string to listen for new events on, not one through
   * a transaction pooler, which cannot listen. Defaults to the `database`
   * string or `DATABASE_URL`.
   */
  listenUrl?: string;
  /**
   * How long a stream stays open, in seconds, before the client reconnects.
   * Keep it below your host's limit for streamed responses. Defaults to 240.
   */
  streamSeconds?: number;
}

/** Why a stream ended on purpose; the client reconnects at once. */
type EndReason = "timeout" | "signed_out" | "schema_changed";

const DEFAULT_STREAM_SECONDS = 240;
const MAX_TOPICS = 50;
/** Each topic weighs 1, and 1 more per relation it expands. */
const MAX_TOPIC_WEIGHT = 100;
/** Open streams per instance, of which signed-out callers may hold half. */
const MAX_STREAMS = 1_000;
const MAX_ANONYMOUS_STREAMS = 500;
/** Open streams per signed-in record, across its sessions. */
const MAX_STREAMS_PER_RECORD = 10;
// Chunks a stream queues for a slow client before it stops reading events.
// They wait in the log meanwhile, so nothing piles up in memory.
const QUEUED_CHUNKS = 16;
// Pages from the hub a stream may have waiting before it reads on by itself.
const QUEUED_PAGES = 4;
const SUPERUSERS = "_superusers";

/** What the realtime route gets from the request and from NextBase. */
export interface StreamContext {
  request: Request;
  db: DB;
  schema: Schema;
  principal: Principal;
  /** 0 means no limit. */
  statementTimeout: number;
}

interface Topic {
  collection: Collection;
  id: string | undefined;
  /** `filter`, `expand` and `fields`, as a list request takes them. */
  query: URLSearchParams;
}

/** NextBase's realtime: which writes log events, and the streams that send them. */
export class Realtime {
  /** Undefined when every collection sends events. */
  readonly #collections: ReadonlySet<string> | undefined;
  readonly #listenUrl: string | undefined;
  readonly #streamMs: number;
  readonly #db: () => DB;
  readonly #schemas: SchemaCache;
  readonly #waitUntil: (promise: Promise<unknown>) => void;
  #hub: RealtimeHub | undefined;
  #signer: Promise<CursorSigner> | undefined;
  #purgedAt = Number.NEGATIVE_INFINITY;
  /** Open streams by caller: a record's key, or "" when signed out. */
  readonly #callers = new Map<string, number>();

  constructor(
    options: true | RealtimeOptions,
    {
      db,
      database,
      schemas,
      waitUntil,
    }: {
      db: () => DB;
      /** The `database` option, when it is a connection string. */
      database: string | undefined;
      schemas: SchemaCache;
      waitUntil: (promise: Promise<unknown>) => void;
    },
  ) {
    const config: RealtimeOptions =
      options === true ? { collections: true } : options;
    if (config === null || typeof config !== "object") {
      throw new TypeError(
        "realtime must be true or an object such as { collections: [...] }.",
      );
    }
    const { collections, listenUrl, streamSeconds } = config;
    if (collections === true) {
      this.#collections = undefined;
    } else if (
      Array.isArray(collections) &&
      collections.every((name) => typeof name === "string" && name !== "")
    ) {
      this.#collections = new Set(collections);
    } else {
      throw new TypeError(
        "realtime.collections must be true or an array of collection names.",
      );
    }
    if (
      listenUrl !== undefined &&
      (typeof listenUrl !== "string" || listenUrl === "")
    ) {
      throw new TypeError("realtime.listenUrl must be a connection string.");
    }
    const seconds = streamSeconds ?? DEFAULT_STREAM_SECONDS;
    if (typeof seconds !== "number" || !(seconds > 0) || seconds === Infinity) {
      throw new RangeError("realtime.streamSeconds must be a positive number.");
    }
    this.#listenUrl = listenUrl ?? database;
    this.#streamMs = seconds * 1000;
    this.#db = db;
    this.#schemas = schemas;
    this.#waitUntil = waitUntil;
  }

  /** Whether writes to the collection log realtime events. */
  sends(collection: Collection): boolean {
    return (
      collection.type !== "view" &&
      collection.name !== SUPERUSERS &&
      (this.#collections?.has(collection.name) ?? true)
    );
  }

  /**
   * A write logged events: deletes those too old to keep, at most once per
   * `purgeMs` per instance, in the background. Events come only from writes,
   * so the log stays small even with no stream open.
   */
  logged(): void {
    const now = Date.now();
    if (now - this.#purgedAt < timings.purgeMs) return;
    this.#purgedAt = now;
    this.#waitUntil(
      purgeEvents(this.#db(), timings.retentionMs / 1000).catch(
        (error: unknown) => {
          console.error(
            "[nextbase] deleting old realtime events failed:",
            error,
          );
        },
      ),
    );
  }

  /**
   * Answers `POST /realtime`: checks every topic as a list or view request
   * would, then streams the events the caller may see.
   */
  async open(context: StreamContext): Promise<Response> {
    const { request, schema, principal } = context;
    const inputs = parseTopics(await readJsonObject(request));
    const topics = inputs.map((input, i): Topic => {
      try {
        const collection = schema.get(input.collection);
        if (!this.sends(collection)) {
          throw new ApiError(
            400,
            `The ${collection.name} collection does not send realtime events.`,
          );
        }
        const query = new URLSearchParams();
        for (const name of ["filter", "expand", "fields"] as const) {
          const value = input[name];
          if (value !== undefined && value !== "") query.set(name, value);
        }
        const topic = { collection, id: input.id, query };
        subscriptionCondition(
          topicContext(context.db, context, principal, topic),
          collection,
          topic.id,
          query,
        );
        return topic;
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        throw new ApiError(
          error.status,
          `Topic ${i + 1} was refused: ${error.message}`,
          {
            topics: {
              [i]: { code: "realtime_topic_refused", message: error.message },
            },
          },
        );
      }
    });
    const weight = topics.reduce(
      (sum, topic) => sum + 1 + relations(topic.query.get("expand")),
      0,
    );
    if (weight > MAX_TOPIC_WEIGHT) {
      throw new ApiError(
        400,
        `The topics weigh ${weight}, more than ${MAX_TOPIC_WEIGHT}: each counts 1, and 1 more for each relation it expands.`,
      );
    }
    const caller = callerKey(principal);
    this.#checkLimits(caller);
    // Counted at once, so streams opening together cannot pass the limits.
    this.#callers.set(caller, (this.#callers.get(caller) ?? 0) + 1);
    const release = (): void => {
      const left = (this.#callers.get(caller) ?? 1) - 1;
      if (left > 0) this.#callers.set(caller, left);
      else this.#callers.delete(caller);
    };
    let signer: CursorSigner;
    let head: Cursor;
    try {
      signer = await this.#cursorSigner();
      head = await headCursor(context.db);
    } catch (error) {
      release();
      throw error;
    }
    let cursor = head;
    let reset = false;
    const lastId = request.headers.get("last-event-id");
    if (lastId !== null && lastId !== "") {
      // An id signed for another caller, another state of the signed-in
      // record or another schema starts over at the head.
      const resumed = signer.verify(lastId, schema.version, principal);
      if (resumed && compareCursors(resumed, head) > 0) {
        console.warn(
          "[nextbase] realtime: an event id is ahead of the event log, as after restoring an older copy of the database. The client starts over.",
        );
      }
      if (resumed && compareCursors(resumed, head) <= 0) cursor = resumed;
      else reset = true;
    }
    const session = principal.session
      ? (bearerToken(request) ?? sessionCookie(request))
      : undefined;
    this.#hub ??= new RealtimeHub(
      this.#listenUrl ?? (process.env.DATABASE_URL || undefined),
      this.#db,
    );
    const stream = new Stream({
      context,
      topics,
      cursor,
      reset,
      session,
      hub: this.#hub,
      schemas: this.#schemas,
      signer,
      streamMs: this.#streamMs,
      closed: release,
    });
    return new Response(stream.body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        // no-transform keeps compression, such as `next start` adds, from
        // buffering the stream.
        "cache-control": "no-store, no-transform",
        // Tells nginx and similar proxies not to buffer the stream.
        "x-accel-buffering": "no",
      },
    });
  }

  /**
   * Each stream costs a little work per write, so their number is capped:
   * per instance, for signed-out callers together, who cannot be told
   * apart, and per signed-in record.
   */
  #checkLimits(caller: string): void {
    let open = 0;
    for (const count of this.#callers.values()) open += count;
    if (open >= MAX_STREAMS) {
      throw new ApiError(
        503,
        "Too many realtime streams are open. Try again later.",
      );
    }
    const mine = this.#callers.get(caller) ?? 0;
    if (caller === "" && mine >= MAX_ANONYMOUS_STREAMS) {
      throw new ApiError(
        503,
        "Too many realtime streams are open without signing in. Try again later.",
      );
    }
    // Superuser server code counts only against the instance.
    if (
      caller !== "" &&
      caller !== "superuser" &&
      mine >= MAX_STREAMS_PER_RECORD
    ) {
      throw new ApiError(
        429,
        `This account has ${MAX_STREAMS_PER_RECORD} realtime streams open, the most it may. Close one first.`,
      );
    }
  }

  // Signs with a key derived from NextBase's own secret, which the database
  // keeps, so every instance shares it and a restored copy keeps it.
  #cursorSigner(): Promise<CursorSigner> {
    this.#signer ??= this.#db()
      .newQuery(`SELECT setup_secret FROM {{${table("_meta")}}}`)
      .column<string>()
      .then(([secret]) => new CursorSigner(secret as string))
      .catch((error: unknown) => {
        this.#signer = undefined;
        throw error;
      });
    return this.#signer;
  }
}

/** Who a stream counts against: a record, or "" for anyone signed out. */
function callerKey(principal: Principal): string {
  if (principal.record && principal.collection) {
    return `${principal.collection.id}/${principal.record.id as string}`;
  }
  return principal.superuser ? "superuser" : "";
}

/** How many relations `expand` loads, nested ones included. */
function relations(expand: string | null): number {
  if (!expand) return 0;
  return new Set(
    expand.split(",").flatMap((path) => {
      const names = path.trim().split(".").filter(Boolean);
      return names.map((_, i) => names.slice(0, i + 1).join("."));
    }),
  ).size;
}

interface TopicInput {
  collection: string;
  id?: string;
  filter?: string;
  expand?: string;
  fields?: string;
}

// `{ topics: [{ collection, id?, filter?, expand?, fields? }] }`
function parseTopics(body: Record<string, unknown>): TopicInput[] {
  const { topics } = body;
  if (
    !Array.isArray(topics) ||
    topics.length === 0 ||
    topics.length > MAX_TOPICS
  ) {
    throw new ApiError(
      400,
      `topics must be an array of 1 to ${MAX_TOPICS} topics.`,
    );
  }
  return topics.map((topic: unknown, i) => {
    const problem = `Topic ${i + 1} must be an object with a collection name, and optionally an id, filter, expand and fields, all strings.`;
    if (topic === null || typeof topic !== "object" || Array.isArray(topic)) {
      throw new ApiError(400, problem);
    }
    const input = topic as Record<string, unknown>;
    if (typeof input.collection !== "string" || input.collection === "") {
      throw new ApiError(400, problem);
    }
    for (const name of ["id", "filter", "expand", "fields"]) {
      const value = input[name];
      if (value !== undefined && typeof value !== "string") {
        throw new ApiError(400, problem);
      }
    }
    return input as unknown as TopicInput;
  });
}

/** A topic's records are checked and output as a list request would. */
function topicContext(
  db: DB | Tx,
  context: StreamContext,
  principal: Principal,
  topic: Topic,
): RecordsContext {
  return {
    db,
    pool: context.db,
    schema: context.schema,
    principal,
    request: {
      method: "GET",
      query: Object.fromEntries(topic.query),
      headers: Object.fromEntries(context.request.headers),
      body: {},
    },
  };
}

/**
 * Errors a stored record causes when read back, such as a value that no
 * longer fits a field changed since it was written: Postgres's data
 * exceptions and type mismatches. The page is skipped with a reset rather
 * than failing the stream on every reconnect.
 */
function unreadable(error: unknown): boolean {
  const { code } = error as { code?: unknown };
  return (
    typeof code === "string" && (code.startsWith("22") || code === "42804")
  );
}

const encoder = new TextEncoder();

/**
 * One subscriber's stream. It follows the hub, which reads each new page of
 * events once for every caught-up stream, or reads pages after its own
 * cursor until it catches up. It checks their records against its topics
 * and sends those it may see. Between pages it holds no transaction and no
 * connection.
 */
class Stream implements HubStream {
  readonly body: ReadableStream<Uint8Array>;
  readonly #context: StreamContext;
  readonly #topics: readonly Topic[];
  readonly #collectionIds: string[];
  readonly #session: string | undefined;
  readonly #schemas: SchemaCache;
  readonly #signer: CursorSigner;
  readonly #hub: RealtimeHub;
  readonly #closed: () => void;
  #principal: Principal;
  #cursor: Cursor;
  /** The last event id the client was sent. */
  #sent: string | undefined;
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  #done = false;
  #running = false;
  /** Events may be ready, for a stream that does not follow the hub. */
  #dirty = false;
  #following = false;
  readonly #pages: EventPage[] = [];
  #room: (() => void) | undefined;
  readonly #timers: ReturnType<typeof setTimeout>[] = [];
  readonly #cleanup: (() => void)[] = [];

  constructor({
    context,
    topics,
    cursor,
    reset,
    session,
    hub,
    schemas,
    signer,
    streamMs,
    closed,
  }: {
    context: StreamContext;
    topics: readonly Topic[];
    cursor: Cursor;
    reset: boolean;
    session: string | undefined;
    hub: RealtimeHub;
    schemas: SchemaCache;
    signer: CursorSigner;
    streamMs: number;
    closed: () => void;
  }) {
    this.#context = context;
    this.#topics = topics;
    this.#collectionIds = [...new Set(topics.map((t) => t.collection.id))];
    this.#principal = context.principal;
    this.#session = session;
    this.#schemas = schemas;
    this.#signer = signer;
    this.#hub = hub;
    this.#closed = closed;
    this.#cursor = cursor;
    this.body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.#controller = controller;
          // The client resumes from here if the stream breaks before any
          // event, so nothing written after it subscribed is missed.
          if (reset) this.#sendReset();
          else this.#sendCursor();
          this.#begin(streamMs);
        },
        pull: () => {
          const room = this.#room;
          this.#room = undefined;
          room?.();
        },
        cancel: () => this.#close(),
      },
      new CountQueuingStrategy({ highWaterMark: QUEUED_CHUNKS }),
    );
  }

  #begin(streamMs: number): void {
    const { signal } = this.#context.request;
    if (signal.aborted) {
      this.#close();
      return;
    }
    const abort = (): void => this.#close();
    signal.addEventListener("abort", abort, { once: true });
    this.#cleanup.push(() => signal.removeEventListener("abort", abort));
    this.#cleanup.push(this.#hub.subscribe(this));
    this.#after(streamMs, () => this.#end("timeout"));
    this.#repeat(timings.heartbeatMs, () => this.#heartbeat());
    // Pages with events check the session too; this covers idle streams.
    if (this.#session !== undefined) {
      this.#repeat(timings.sessionMs, () => {
        void this.#checkSession().catch((error: unknown) => {
          console.error("[nextbase] realtime session check failed:", error);
          this.#close();
        });
      });
    }
    this.wake();
  }

  #after(ms: number, run: () => void): void {
    this.#keep(setTimeout(run, ms));
  }

  #repeat(ms: number, run: () => void): void {
    this.#keep(setInterval(run, ms));
  }

  // Cleared on close; they never keep the process alive on their own.
  #keep(timer: ReturnType<typeof setTimeout>): void {
    timer.unref?.();
    this.#timers.push(timer);
  }

  wake(): void {
    if (this.#done || this.#following) return;
    this.#dirty = true;
    this.#pump();
  }

  page(page: EventPage): void {
    if (this.#done) return;
    if (this.#pages.length >= QUEUED_PAGES) {
      // Too far behind to keep up: read on from the cursor instead.
      this.#hub.unfollow(this);
      this.#following = false;
      this.#pages.length = 0;
      this.wake();
      return;
    }
    this.#pages.push(page);
    this.#pump();
  }

  #pump(): void {
    if (this.#running) return;
    this.#running = true;
    void (async () => {
      try {
        while (!this.#done) {
          const hasWork =
            this.#pages.length > 0 || (this.#dirty && !this.#following);
          if (!hasWork || !(await this.#waitForRoom())) break;
          const page = this.#pages.shift();
          if (page) {
            await this.#deliver(page);
          } else {
            this.#dirty = false;
            await this.#readOwn();
          }
        }
      } catch (error) {
        if (SCHEMA_RACE.has((error as { code?: string }).code ?? "")) {
          this.#end("schema_changed");
        } else {
          console.error("[nextbase] realtime stream failed:", error);
          this.#close();
        }
      } finally {
        this.#running = false;
      }
    })();
  }

  /** Waits while the client is behind. False once the stream is closed. */
  async #waitForRoom(): Promise<boolean> {
    while (!this.#done && (this.#controller?.desiredSize ?? 0) <= 0) {
      await new Promise<void>((resolve) => {
        this.#room = resolve;
      });
    }
    return !this.#done;
  }

  /** Reads pages after the cursor until caught up, then follows the hub. */
  async #readOwn(): Promise<void> {
    for (;;) {
      const page = await readEvents(
        this.#context.db,
        this.#cursor,
        this.#collectionIds,
        PAGE,
      );
      if (this.#done) return;
      if (page.lost) {
        this.#cursor = await headCursor(this.#context.db);
        this.#sendReset();
        continue;
      }
      await this.#deliver(page);
      if (this.#done) return;
      if (page.events.length < PAGE) break;
      if (!(await this.#waitForRoom())) return;
    }
    // In the same turn as the check, so the hub hands over no page between.
    this.#following = this.#hub.follow(this, this.#cursor);
  }

  /** Sends what the stream may see of a page, and moves the cursor past it. */
  async #deliver(page: EventPage): Promise<void> {
    // Rules or collections may have changed: the client reconnects, and its
    // topics are checked again.
    if (page.schemaVersion > this.#context.schema.version) {
      this.#end("schema_changed");
      return;
    }
    const events = page.events.filter(
      (event) => compareCursors(event.cursor, this.#cursor) > 0,
    );
    const last = events.at(-1);
    if (!last) return;
    const relevant = events.some(
      (event) =>
        event.record !== null &&
        this.#collectionIds.includes(event.collectionId),
    );
    if (relevant) {
      // Nothing more for a session that ended, nor rules checked with a
      // record that changed.
      if (this.#session !== undefined && !(await this.#checkSession())) return;
      const { db, statementTimeout } = this.#context;
      let messages: string[];
      try {
        // Rules that read nothing and topics that expand nothing need no
        // query, nor a transaction.
        messages = this.#queries(events)
          ? await db.transaction((tx) => this.#messages(tx, events), {
              readOnly: true,
              ...(statementTimeout > 0 && { statementTimeout }),
            })
          : await this.#messages(db, events);
      } catch (error) {
        if (!unreadable(error)) throw error;
        console.warn(
          "[nextbase] realtime: skipped events whose records cannot be read back, such as after a field changed:",
          error,
        );
        this.#cursor = last.cursor;
        this.#sendReset();
        return;
      }
      if (this.#done) return;
      for (const message of messages) this.#send(message);
    }
    this.#cursor = last.cursor;
  }

  /** Whether the messages for `events` take queries: rules or expands. */
  #queries(events: readonly StoredEvent[]): boolean {
    const { db } = this.#context;
    return this.#topics.some(
      (topic) =>
        events.some((e) => e.collectionId === topic.collection.id) &&
        (topic.query.has("expand") ||
          (subscriptionCondition(
            topicContext(db, this.#context, this.#principal, topic),
            topic.collection,
            topic.id,
            topic.query,
          )?.build(db, {}) ?? "") !== ""),
    );
  }

  /** The messages for a page of events, in order. */
  async #messages(
    tx: DB | Tx,
    events: readonly StoredEvent[],
  ): Promise<string[]> {
    // Each event's record per topic that may see it.
    const records = events.map(() => new Map<number, unknown>());
    for (const collectionId of this.#collectionIds) {
      const positions: number[] = [];
      for (const [n, event] of events.entries()) {
        if (event.collectionId === collectionId && event.record) {
          positions.push(n);
        }
      }
      if (positions.length === 0) continue;
      const indexes = [...this.#topics.keys()].filter(
        (k) => this.#topics[k]?.collection.id === collectionId,
      );
      const collection = (this.#topics[indexes[0] as number] as Topic)
        .collection;
      const rows = positions.map((n) =>
        eventRecord(collection, (events[n] as StoredEvent).record as Row),
      );
      const contexts = indexes.map((k) =>
        topicContext(
          tx,
          this.#context,
          this.#principal,
          this.#topics[k] as Topic,
        ),
      );
      const matches = await matchingRows(
        tx,
        collection,
        rows,
        indexes.map((k, j) => {
          const topic = this.#topics[k] as Topic;
          return subscriptionCondition(
            contexts[j] as RecordsContext,
            collection,
            topic.id,
            topic.query,
          );
        }),
      );
      for (const [j, k] of indexes.entries()) {
        // Positions in `rows` of the records this topic may see.
        const visible = [...rows.keys()].filter((r) => matches[r]?.[j]);
        if (visible.length === 0) continue;
        const output = await outputRecords(
          contexts[j] as RecordsContext,
          collection,
          visible.map((r) => rows[r] as Row),
          (this.#topics[k] as Topic).query,
        );
        for (const [v, r] of visible.entries()) {
          records[positions[r] as number]?.set(k, output[v]);
        }
      }
    }
    const messages: string[] = [];
    for (const [n, event] of events.entries()) {
      const found = records[n] as Map<number, unknown>;
      if (found.size === 0) continue;
      const data = JSON.stringify({
        action: event.action,
        topics: Object.fromEntries(found),
      });
      messages.push(
        `id: ${this.#id(event.cursor)}\nevent: ${event.action}\ndata: ${data}\n\n`,
      );
    }
    return messages;
  }

  /**
   * Reads the session again: ends the stream when it ended, and otherwise
   * checks rules from now on with the signed-in record as it is now. False
   * when the stream ended.
   */
  async #checkSession(): Promise<boolean> {
    if (this.#done || this.#session === undefined) return !this.#done;
    const { active } = await findSession(
      this.#context.db,
      this.#schemas,
      this.#session,
      { extend: false },
    );
    if (this.#done) return false;
    if (!active || active.session.id !== this.#principal.session?.id) {
      this.#end("signed_out");
      return false;
    }
    this.#principal = {
      ...this.#principal,
      collection: active.collection,
      record: active.record,
    };
    // Ids are signed for the record as it is: a changed one gets a new id.
    this.#sendCursor();
    return true;
  }

  #id(cursor: Cursor): string {
    return this.#signer.sign(
      cursor,
      this.#context.schema.version,
      this.#principal,
    );
  }

  /** Keeps proxies from closing an idle stream, and moves the client's cursor on. */
  #heartbeat(): void {
    if (!this.#sendCursor()) this.#send(":\n\n");
  }

  /**
   * Sends the cursor as an event id without data, which moves the client's
   * last event id on without an event. True if it was sent.
   */
  #sendCursor(): boolean {
    const id = this.#id(this.#cursor);
    if (id === this.#sent) return false;
    this.#send(`id: ${id}\n\n`);
    return true;
  }

  /** Tells the client it may have missed events, and where it resumes. */
  #sendReset(): void {
    this.#send(`id: ${this.#id(this.#cursor)}\nevent: reset\ndata: {}\n\n`);
  }

  #end(reason: EndReason): void {
    if (this.#done) return;
    this.#sendCursor();
    this.#send(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`);
    this.#close();
  }

  #send(message: string): void {
    if (this.#done || !this.#controller) return;
    const id = /^id: (.*)$/m.exec(message)?.[1];
    if (id !== undefined) this.#sent = id;
    this.#controller.enqueue(encoder.encode(message));
  }

  #close(): void {
    if (this.#done) return;
    this.#done = true;
    for (const timer of this.#timers) clearTimeout(timer);
    for (const cleanup of this.#cleanup.splice(0)) cleanup();
    this.#pages.length = 0;
    const room = this.#room;
    this.#room = undefined;
    room?.();
    try {
      this.#controller?.close();
    } catch {
      // Already closed or cancelled by the client.
    }
    this.#closed();
  }
}
