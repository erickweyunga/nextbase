import type { DB } from "@nextbasejs/dbx";
import pg from "pg";
import { CHANNEL, lastEventId } from "./events.ts";
import { timings } from "./timings.ts";

type Wake = () => void;

/**
 * Wakes this instance's open streams when events may have been committed.
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
  readonly #streams = new Set<Wake>();
  /** Bumped on every start and stop, so work of an earlier run is dropped. */
  #run = 0;
  #client: pg.Client | undefined;
  #listening = false;
  #attempts = 0;
  #reconnect: ReturnType<typeof setTimeout> | undefined;
  #poll: ReturnType<typeof setInterval> | undefined;
  #polled: string | undefined;
  #warned = false;

  constructor(listenUrl: string | undefined, db: () => DB) {
    this.#listenUrl = listenUrl;
    this.#db = db;
  }

  /** Calls `wake` whenever events may be ready. Returns the unsubscribe. */
  subscribe(wake: Wake): () => void {
    this.#streams.add(wake);
    if (this.#streams.size === 1) this.#start();
    return () => {
      if (!this.#streams.delete(wake)) return;
      if (this.#streams.size === 0) this.#stop();
    };
  }

  #wakeAll(): void {
    for (const wake of this.#streams) wake();
  }

  #start(): void {
    const run = ++this.#run;
    this.#attempts = 0;
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
    clearTimeout(this.#reconnect);
    this.#reconnect = undefined;
    this.#stopPolling();
    this.#listening = false;
    const client = this.#client;
    this.#client = undefined;
    client?.end().catch(() => {});
  }

  async #listen(run: number, url: string): Promise<void> {
    const client = new pg.Client({
      connectionString: url,
      // Keeps an idle connection from being dropped silently on the way.
      keepAlive: true,
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
    // Notifications sent while not listening were missed.
    this.#wakeAll();
  }

  /** The connection failed or ended: poll, and listen again later. */
  #lost(run: number, client: pg.Client): void {
    if (run !== this.#run || this.#client !== client) return;
    this.#client = undefined;
    this.#listening = false;
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
      lastEventId(this.#db())
        .then((id) => {
          if (run !== this.#run || id === this.#polled) return;
          this.#polled = id;
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
