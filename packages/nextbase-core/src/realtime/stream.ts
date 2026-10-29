import type { Collection } from "@nextbasejs/client";
import type { DB, Row, Tx } from "@nextbasejs/dbx";
import type { Principal } from "../auth/principal.ts";
import { bearerToken, findSession, sessionCookie } from "../auth/sessions.ts";
import { ApiError } from "../errors.ts";
import { readJsonObject } from "../http.ts";
import {
  matchingRows,
  outputRecords,
  type RecordsContext,
  subscriptionCondition,
} from "../records/service.ts";
import { SCHEMA_RACE, type Schema, type SchemaCache } from "../schema/cache.ts";
import {
  type Cursor,
  compareCursors,
  type EventPage,
  eventRecord,
  formatCursor,
  headCursor,
  parseCursor,
  purgeEvents,
  readEvents,
  type StoredEvent,
} from "./events.ts";
import { RealtimeHub } from "./hub.ts";
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

/** What a read of the log leads to: messages to send, or a reset. */
type Outcome = { messages: string[] } | { head: Cursor };

/** Why a stream ended on purpose; the client reconnects at once. */
type EndReason = "timeout" | "signed_out" | "schema_changed";

const DEFAULT_STREAM_SECONDS = 240;
const MAX_TOPICS = 50;
// Events read per query; a stream reads on at once while pages are full.
const PAGE = 500;
// Chunks a stream queues for a slow client before it stops reading events.
// They wait in the log meanwhile, so nothing piles up in memory.
const QUEUED_CHUNKS = 16;
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
  #purgedAt = Number.NEGATIVE_INFINITY;

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
    const topics = parseTopics(await readJsonObject(request)).map(
      (input, i): Topic => {
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
      },
    );
    const lastId = request.headers.get("last-event-id");
    let resumed: Cursor | undefined;
    if (lastId !== null && lastId !== "") {
      resumed = parseCursor(lastId);
      if (!resumed)
        throw new ApiError(400, "Last-Event-ID is not an event id.");
    }
    const head = await headCursor(context.db);
    // An id from the future cannot be resumed from; nor one older than the
    // events kept, which the first read finds.
    const reset = resumed !== undefined && compareCursors(resumed, head) > 0;
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
      cursor: reset ? head : (resumed ?? head),
      reset,
      session,
      hub: this.#hub,
      schemas: this.#schemas,
      streamMs: this.#streamMs,
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

const encoder = new TextEncoder();

/**
 * One subscriber's stream. On each wake it reads the events after its
 * cursor, checks their records against its topics, and sends those it may
 * see. Between reads it holds no transaction and no connection.
 */
class Stream {
  readonly body: ReadableStream<Uint8Array>;
  readonly #context: StreamContext;
  readonly #topics: readonly Topic[];
  readonly #collectionIds: string[];
  readonly #session: string | undefined;
  readonly #schemas: SchemaCache;
  #principal: Principal;
  #cursor: Cursor;
  /** The last cursor the client was sent, as an event id. */
  #sent: string | undefined;
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  #closed = false;
  #running = false;
  #dirty = false;
  #room: (() => void) | undefined;
  #retry: ReturnType<typeof setTimeout> | undefined;
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
    streamMs,
  }: {
    context: StreamContext;
    topics: readonly Topic[];
    cursor: Cursor;
    reset: boolean;
    session: string | undefined;
    hub: RealtimeHub;
    schemas: SchemaCache;
    streamMs: number;
  }) {
    this.#context = context;
    this.#topics = topics;
    this.#collectionIds = [...new Set(topics.map((t) => t.collection.id))];
    this.#principal = context.principal;
    this.#session = session;
    this.#schemas = schemas;
    this.#cursor = cursor;
    this.body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.#controller = controller;
          // The client resumes from here if the stream breaks before any
          // event, so nothing written after it subscribed is missed.
          if (reset) this.#sendReset();
          else this.#sendCursor();
          this.#begin(hub, streamMs);
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

  #begin(hub: RealtimeHub, streamMs: number): void {
    const { signal } = this.#context.request;
    if (signal.aborted) {
      this.#close();
      return;
    }
    const abort = (): void => this.#close();
    signal.addEventListener("abort", abort, { once: true });
    this.#cleanup.push(() => signal.removeEventListener("abort", abort));
    this.#cleanup.push(hub.subscribe(() => this.#wake()));
    this.#after(streamMs, () => this.#end("timeout"));
    this.#repeat(timings.heartbeatMs, () => this.#heartbeat());
    if (this.#session !== undefined) {
      const session = this.#session;
      this.#repeat(timings.sessionMs, () => {
        void this.#checkSession(session);
      });
    }
    this.#wake();
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

  #wake(): void {
    if (this.#closed) return;
    this.#dirty = true;
    if (!this.#running) void this.#pump();
  }

  async #pump(): Promise<void> {
    this.#running = true;
    try {
      while (this.#dirty && !this.#closed) {
        this.#dirty = false;
        // Reads on while pages are full.
        while ((await this.#waitForRoom()) && (await this.#read()));
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
  }

  /** Waits while the client is behind. False once the stream is closed. */
  async #waitForRoom(): Promise<boolean> {
    while (!this.#closed && (this.#controller?.desiredSize ?? 0) <= 0) {
      await new Promise<void>((resolve) => {
        this.#room = resolve;
      });
    }
    return !this.#closed;
  }

  /** Reads and sends one page of events. True when there may be more. */
  async #read(): Promise<boolean> {
    const { db, statementTimeout } = this.#context;
    const result = await db.transaction(
      async (tx): Promise<{ page: EventPage } & Outcome> => {
        const page = await readEvents(
          tx,
          this.#cursor,
          this.#collectionIds,
          PAGE,
        );
        if (page.schemaVersion > this.#context.schema.version) {
          return { page, messages: [] };
        }
        // Some events after the cursor are gone: start again at the head.
        if (page.lost) return { page, head: await headCursor(tx) };
        return { page, messages: await this.#messages(tx, page.events) };
      },
      {
        readOnly: true,
        ...(statementTimeout > 0 && { statementTimeout }),
      },
    );
    if (this.#closed) return false;
    const { page } = result;
    // Rules or collections may have changed: the client reconnects, and its
    // topics are checked again.
    if (page.schemaVersion > this.#context.schema.version) {
      this.#end("schema_changed");
      return false;
    }
    if ("head" in result) {
      this.#cursor = result.head;
      this.#sendReset();
      return true;
    }
    if (page.held) this.#retryLater();
    for (const message of result.messages) this.#send(message);
    const last = page.events.at(-1);
    if (last) this.#cursor = last.cursor;
    return page.events.length === PAGE;
  }

  /** The messages for a page of events, in order. */
  async #messages(tx: Tx, events: readonly StoredEvent[]): Promise<string[]> {
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
      const id = formatCursor(event.cursor);
      const data = JSON.stringify({
        action: event.action,
        topics: Object.fromEntries(found),
      });
      messages.push(`id: ${id}\nevent: ${event.action}\ndata: ${data}\n\n`);
    }
    return messages;
  }

  /**
   * Events of finished transactions wait behind one still running, which
   * notifies nothing if it writes no events, so they are read again soon.
   */
  #retryLater(): void {
    if (this.#retry) return;
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      this.#wake();
    }, timings.pollMs);
    this.#retry.unref?.();
  }

  async #checkSession(token: string): Promise<void> {
    if (this.#closed) return;
    try {
      const { active } = await findSession(
        this.#context.db,
        this.#schemas,
        token,
        { extend: false },
      );
      if (this.#closed) return;
      if (!active || active.session.id !== this.#principal.session?.id) {
        this.#end("signed_out");
        return;
      }
      // Rules that read `@request.auth` see the record as it is now.
      this.#principal = {
        ...this.#principal,
        collection: active.collection,
        record: active.record,
      };
    } catch (error) {
      console.error("[nextbase] realtime session check failed:", error);
      this.#close();
    }
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
    const id = formatCursor(this.#cursor);
    if (id === this.#sent) return false;
    this.#send(`id: ${id}\n\n`);
    return true;
  }

  /** Tells the client it may have missed events, and where it resumes. */
  #sendReset(): void {
    this.#send(`id: ${formatCursor(this.#cursor)}\nevent: reset\ndata: {}\n\n`);
  }

  #end(reason: EndReason): void {
    if (this.#closed) return;
    this.#sendCursor();
    this.#send(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`);
    this.#close();
  }

  #send(message: string): void {
    if (this.#closed || !this.#controller) return;
    const id = /^id: (.*)$/m.exec(message)?.[1];
    if (id !== undefined) this.#sent = id;
    this.#controller.enqueue(encoder.encode(message));
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const timer of this.#timers) clearTimeout(timer);
    clearTimeout(this.#retry);
    for (const cleanup of this.#cleanup.splice(0)) cleanup();
    const room = this.#room;
    this.#room = undefined;
    room?.();
    try {
      this.#controller?.close();
    } catch {
      // Already closed or cancelled by the client.
    }
  }
}
