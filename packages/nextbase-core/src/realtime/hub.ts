import type { DB } from "@nextbasejs/dbx";
import pg from "pg";
import type { ActiveSession } from "../auth/sessions.ts";
import {
  CHANNEL,
  type Cursor,
  compareCursors,
  type EventPage,
  headCursor,
  lastPosition,
  readEvents,
} from "./events.ts";
import { timings } from "./timings.ts";

/** Events read per query; a reader reads on at once while pages are full. */
export const PAGE = 500;

/** An open stream, as the hub sees it. */
export interface HubStream {
  /** The token of the stream's session, if it has one. */
  readonly session: string | undefined;
  /**
   * Its session as read just before the hub hands it a page: undefined
   * once the session ended.
   */
  sessionRead(active: ActiveSession | undefined): void;
  /**
   * The next page of events, read once for every stream that follows the
   * hub, after its session was read. It may start before the stream's own
   * cursor.
   */
  page(page: EventPage): void;
  /** Events may be ready: a stream that does not follow reads them itself. */
  wake(): void;
  /** The hub stopped handing it pages: it reads on from its own cursor. */
  unfollowed(): void;
}

/** Reads the sessions of several tokens with one query. */
export type ReadSessions = (
  tokens: readonly string[],
) => Promise<(ActiveSession | undefined)[]>;

/**
 * Wakes this instance's open streams when events may have been committed,
 * and reads each new page of events once for all streams that are caught
 * up. A stream behind, such as one that resumed, reads its own pages until
 * it catches up, then follows.
 *
 * It listens for the notification writes send on a connection of its own,
 * which transaction poolers do not support, so it uses `listenUrl`. While it
 * cannot listen, it polls the log instead, and keeps trying to listen.
 *
 * It holds the connection only while streams are open: the first stream
 * starts it and the last one stops it, so an idle instance, such as a
 * suspended serverless function, keeps nothing open.
 */
export class RealtimeHub {
  readonly #listenUrl: string | undefined;
  readonly #db: () => DB;
  readonly #sessions: ReadSessions;
  readonly #streams = new Set<HubStream>();
  readonly #following = new Set<HubStream>();
  /** After the last event handed to followers; unset until first read. */
  #cursor: Cursor | undefined;
  /** The run whose read is going on, if any. */
  #reading: number | undefined;
  /** A read was asked for while one went on. */
  #dirty = false;
  /** Bumped on every start and stop, so work of an earlier run is dropped. */
  #run = 0;
  #client: pg.Client | undefined;
  #listening = false;
  #attempts = 0;
  #reconnect: ReturnType<typeof setTimeout> | undefined;
  #health: ReturnType<typeof setInterval> | undefined;
  #poll: ReturnType<typeof setInterval> | undefined;
  #polled: string | undefined;
  #warned = false;

  constructor(
    listenUrl: string | undefined,
    db: () => DB,
    sessions: ReadSessions,
  ) {
    this.#listenUrl = listenUrl;
    this.#db = db;
    this.#sessions = sessions;
  }

  /** How many streams are open on this instance. */
  get size(): number {
    return this.#streams.size;
  }

  /** Wakes `stream` whenever events may be ready. Returns the unsubscribe. */
  subscribe(stream: HubStream): () => void {
    this.#streams.add(stream);
    if (this.#streams.size === 1) this.#start();
    return () => {
      this.#following.delete(stream);
      if (!this.#streams.delete(stream)) return;
      if (this.#streams.size === 0) this.#stop();
    };
  }

  /**
   * Hands `stream` the pages the hub reads from now on, if they leave no
   * gap after `cursor`. False when the stream must read on by itself.
   */
  follow(stream: HubStream, cursor: Cursor): boolean {
    if (
      !this.#streams.has(stream) ||
      this.#cursor === undefined ||
      compareCursors(cursor, this.#cursor) < 0
    ) {
      return false;
    }
    this.#following.add(stream);
    return true;
  }

  unfollow(stream: HubStream): void {
    this.#following.delete(stream);
  }

  #wakeAll(): void {
    void this.#read();
    for (const stream of this.#streams) {
      if (!this.#following.has(stream)) stream.wake();
    }
  }

  /** Reads the new pages once, for every stream that follows. */
  async #read(): Promise<void> {
    const run = this.#run;
    // A read of an earlier run, still going on after a stop, does not hold
    // up this run's.
    if (this.#reading === run) {
      this.#dirty = true;
      return;
    }
    this.#reading = run;
    this.#dirty = false;
    try {
      const db = this.#db();
      if (this.#cursor === undefined) {
        const head = await headCursor(db);
        // A read from before a stop must not set the new start's cursor.
        if (run !== this.#run) return;
        this.#cursor ??= head;
      }
      for (;;) {
        const page = await readEvents(
          db,
          this.#cursor as Cursor,
          undefined,
          PAGE,
        );
        if (run !== this.#run) return;
        if (page.lost) {
          // Too far behind, as after a long stall: start again at the
          // head, and let each stream find out what it missed.
          const head = await headCursor(db);
          if (run !== this.#run) return;
          this.#cursor = head;
          this.#unfollowAll();
          return;
        }
        const last = page.events.at(-1);
        if (!last) return;
        await this.#readSessions();
        if (run !== this.#run) return;
        for (const stream of this.#following) stream.page(page);
        this.#cursor = last.cursor;
        if (page.events.length < PAGE) return;
      }
    } catch (error) {
      console.error("[nextbase] realtime: reading events failed:", error);
      if (run === this.#run) this.#unfollowAll();
    } finally {
      if (this.#reading === run) this.#reading = undefined;
      // Asked for while this read went on, by this run or the next.
      if (this.#dirty && this.#reading === undefined) void this.#read();
    }
  }

  /**
   * Reads the sessions of the streams that follow, with one query, so none
   * gets a page after its session ended, and rules see the signed-in
   * record as it is now.
   */
  async #readSessions(): Promise<void> {
    const streams = [...this.#following].filter((s) => s.session);
    if (streams.length === 0) return;
    const tokens = [...new Set(streams.map((s) => s.session as string))];
    const found = await this.#sessions(tokens);
    const byToken = new Map(tokens.map((token, i) => [token, found[i]]));
    for (const stream of streams) {
      if (this.#following.has(stream)) {
        stream.sessionRead(byToken.get(stream.session as string));
      }
    }
  }

  // Streams that stop following read on from their own cursor.
  #unfollowAll(): void {
    const streams = [...this.#following];
    this.#following.clear();
    for (const stream of streams) stream.unfollowed();
  }

  #start(): void {
    const run = ++this.#run;
    this.#attempts = 0;
    this.#cursor = undefined;
    // Polls until it listens, so events flow while it connects.
    this.#startPolling();
    if (this.#listenUrl === undefined) {
      this.#warn(
        "there is no connection string to listen on, so it checks for new events every second. Set realtime.listenUrl, or use a connection string.",
      );
      return;
    }
    void this.#listen(run, this.#listenUrl);
  }

  #stop(): void {
    this.#run++;
    this.#following.clear();
    this.#cursor = undefined;
    clearTimeout(this.#reconnect);
    this.#reconnect = undefined;
    clearInterval(this.#health);
    this.#health = undefined;
    this.#stopPolling();
    this.#listening = false;
    const client = this.#client;
    this.#client = undefined;
    client?.end().catch(() => {});
  }

  async #listen(run: number, url: string): Promise<void> {
    const client = new pg.Client({
      connectionString: url,
      // Starts the system's keepalive probes after 10 seconds idle rather
      // than its default two hours. Probes still take minutes to give up,
      // so the health check below is what notices a dead connection.
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      // The default waits forever on a database that does not answer.
      connectionTimeoutMillis: 10_000,
    });
    // Without a listener a failed connection would crash the process.
    client.on("error", () => this.#lost(run, client));
    client.on("end", () => this.#lost(run, client));
    client.on("notification", () => {
      if (run === this.#run) this.#wakeAll();
    });
    this.#client = client;
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
    } catch (error) {
      if (run !== this.#run) return;
      this.#warn(
        `it cannot listen for notifications (${(error as Error).message}), so it checks for new events every second until it can.`,
      );
      this.#lost(run, client);
      return;
    }
    // Stopped while connecting: `#stop` ended the connection.
    if (run !== this.#run) return;
    this.#listening = true;
    this.#attempts = 0;
    this.#stopPolling();
    this.#checkHealth(run, client);
    // Notifications sent while not listening were missed.
    this.#wakeAll();
  }

  /**
   * Queries the listening connection now and then. A connection that died
   * without the server saying so, as in a failover, hears nothing and
   * reports no error, so one that does not answer in time counts as lost.
   */
  #checkHealth(run: number, client: pg.Client): void {
    clearInterval(this.#health);
    this.#health = setInterval(() => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("no answer")),
          timings.healthTimeoutMs,
        );
      });
      Promise.race([client.query("SELECT 1"), late])
        .catch(() => this.#lost(run, client))
        .finally(() => clearTimeout(timer));
    }, timings.healthMs);
    this.#health.unref?.();
  }

  /** The connection failed or ended: poll, and listen again later. */
  #lost(run: number, client: pg.Client): void {
    if (run !== this.#run || this.#client !== client) return;
    this.#client = undefined;
    this.#listening = false;
    clearInterval(this.#health);
    this.#health = undefined;
    client.end().catch(() => {});
    this.#startPolling();
    const delay = Math.min(
      timings.maxReconnectMs,
      timings.reconnectMs * 2 ** this.#attempts++,
    );
    clearTimeout(this.#reconnect);
    this.#reconnect = setTimeout(() => {
      this.#reconnect = undefined;
      if (run === this.#run) void this.#listen(run, this.#listenUrl as string);
    }, delay);
    this.#reconnect.unref?.();
  }

  #startPolling(): void {
    if (this.#poll || this.#listening) return;
    this.#polled = undefined;
    const run = this.#run;
    let polling = false;
    this.#poll = setInterval(() => {
      if (polling) return;
      polling = true;
      lastPosition(this.#db())
        .then((position) => {
          if (run !== this.#run || position === this.#polled) return;
          this.#polled = position;
          this.#wakeAll();
        })
        .catch((error: unknown) => {
          console.error(
            "[nextbase] realtime: polling for events failed:",
            error,
          );
        })
        .finally(() => {
          polling = false;
        });
    }, timings.pollMs);
    this.#poll.unref?.();
    // Events may have been committed since the connection was lost.
    this.#wakeAll();
  }

  #stopPolling(): void {
    clearInterval(this.#poll);
    this.#poll = undefined;
  }

  // Once per instance, so a database that never takes LISTEN does not fill
  // the log.
  #warn(problem: string): void {
    if (this.#warned) return;
    this.#warned = true;
    console.warn(`[nextbase] realtime: ${problem}`);
  }
}
