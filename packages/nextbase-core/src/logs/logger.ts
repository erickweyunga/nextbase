import type { DB } from "@nextbasejs/dbx";
import { table } from "../db/system.ts";
import { newId } from "../random.ts";

/** Log levels, as stored: higher is more severe. */
export const LOG_LEVELS = { debug: -4, info: 0, warn: 4, error: 8 } as const;

export interface LogsOptions {
  /** Days entries are kept. Defaults to 7, and must be at least 1. */
  maxDays?: number;
  /** Entries below this level are not kept. Defaults to 0 (info). */
  minLevel?: number;
  /** Record the id of the signed-in record of each request. Defaults to false. */
  authId?: boolean;
  /** Record the client's IP, when `clientIp` knows it. Defaults to false. */
  ip?: boolean;
}

/** What a background failure was doing. */
export type FailureType =
  | "hook"
  | "storage"
  | "mail"
  | "sms"
  | "realtime"
  | "oauth2";

/**
 * How often each instance deletes expired entries, in milliseconds. Tests
 * shorten it; apps have no reason to.
 */
export const logTimings = { purgeMs: 600_000 };

const LOGS = table("_logs");
// Rows per insert: a flush of more is split.
const BATCH = 200;
// Entries waiting to be sent at most; more are dropped.
const MAX_BUFFERED = 1000;
// Expired rows each delete removes, so no delete holds locks for long.
const PURGE_BATCH = 10_000;
const MAX_ERROR = 1000;
const MAX_STACK = 4000;

interface Config {
  maxDays: number;
  minLevel: number;
  authId: boolean;
  ip: boolean;
}

interface Entry {
  id: string;
  created: string;
  level: number;
  message: string;
  data: Record<string, unknown>;
}

/**
 * Writes log entries to `_logs`, outside any transaction, so a request's own
 * writes never decide whether its entry is kept. Entries are buffered and
 * written together on the next tick, so a burst of requests costs one
 * insert, and one insert at most runs at a time per instance, so logging
 * never takes more than one connection. Writing never fails a request:
 * errors only go to the console.
 */
export class Logger {
  readonly #config: Config | undefined;
  readonly #db: () => DB;
  readonly #ready: () => Promise<void>;
  readonly #waitUntil: (promise: Promise<unknown>) => void;
  /** Entries not sent yet. */
  #buffer: Entry[] = [];
  /** The next tick, when a write is due to start. */
  #tick: Promise<void> | undefined;
  /** The write running: inserts, one after another, until the buffer is empty. */
  #writing: Promise<void> | undefined;
  #purging: Promise<void> | undefined;
  #dropping = false;
  #purgedAt = Number.NEGATIVE_INFINITY;
  /** Microseconds of the last entry, so times never go backwards. */
  #lastMicros = 0;

  constructor(
    options: false | LogsOptions | undefined,
    {
      db,
      ready,
      waitUntil,
    }: {
      db: () => DB;
      /** Resolves once `_logs` exists. */
      ready: () => Promise<void>;
      waitUntil: (promise: Promise<unknown>) => void;
    },
  ) {
    this.#config = options === false ? undefined : parseOptions(options ?? {});
    this.#db = db;
    this.#ready = ready;
    this.#waitUntil = waitUntil;
  }

  /** Undefined when logs are off. */
  get config(): Readonly<Config> | undefined {
    return this.#config;
  }

  /** Whether an entry at `level` would be kept. */
  keeps(level: number): boolean {
    return this.#config !== undefined && level >= this.#config.minLevel;
  }

  /** Buffers an entry, if logs are on and its level is kept. */
  add(level: number, message: string, data: Record<string, unknown>): void {
    if (!this.keeps(level)) return;
    if (this.#buffer.length >= MAX_BUFFERED) {
      if (!this.#dropping) {
        this.#dropping = true;
        console.warn(
          `[nextbase] ${MAX_BUFFERED} log entries are waiting to be written; new ones are dropped until they are.`,
        );
      }
      return;
    }
    this.#buffer.push({
      id: newId(),
      created: this.#now(),
      level,
      message: storableText(message),
      data: storable(data) as Record<string, unknown>,
    });
    if (this.#buffer.length >= BATCH) this.#write();
    else this.#schedule();
  }

  /**
   * Reports work that failed in the background, after the response: to the
   * console, as before logs existed, and as an error entry.
   */
  failure(type: FailureType, what: string, error: unknown): void {
    console.error(`[nextbase] ${what}:`, error);
    this.add(LOG_LEVELS.error, capitalize(what), {
      type,
      error: errorMessage(error).slice(0, MAX_ERROR),
      ...(error instanceof Error &&
        error.stack !== undefined && {
          stack: error.stack.slice(0, MAX_STACK),
        }),
    });
  }

  /**
   * Resolves once every entry added so far is written, or failed to be, and
   * a running delete of expired entries is done. Never rejects.
   */
  async flush(): Promise<void> {
    for (;;) {
      if (this.#buffer.length > 0) this.#write();
      const work = [this.#tick, this.#writing, this.#purging].filter(
        (p) => p !== undefined,
      );
      if (work.length === 0) return;
      await Promise.all(work);
    }
  }

  /** Starts a write on the next tick, so entries added meanwhile join it. */
  #schedule(): void {
    if (this.#tick || this.#writing) return;
    this.#tick = new Promise<void>((resolve) => setImmediate(resolve)).then(
      () => {
        this.#tick = undefined;
        this.#write();
        return this.#writing;
      },
    );
    this.#waitUntil(this.#tick);
  }

  /** Starts writing the buffer, unless a write already runs: it takes them. */
  #write(): void {
    if (this.#writing || this.#buffer.length === 0) return;
    this.#writing = this.#drain().finally(() => {
      this.#writing = undefined;
      // Added after the last insert took the buffer.
      if (this.#buffer.length > 0) this.#schedule();
    });
    this.#waitUntil(this.#writing);
  }

  async #drain(): Promise<void> {
    while (this.#buffer.length > 0) {
      const rows = this.#buffer.splice(0, BATCH);
      if (this.#buffer.length === 0) this.#dropping = false;
      try {
        await this.#ready();
        const db = this.#db();
        await insertEntries(db, rows);
        this.#purge(db);
      } catch (error) {
        console.error("[nextbase] writing log entries failed:", error);
      }
    }
  }

  /** Deletes expired entries, at most once per `purgeMs` per instance. */
  #purge(db: DB): void {
    const config = this.#config;
    const now = Date.now();
    if (!config || this.#purging || now - this.#purgedAt < logTimings.purgeMs) {
      return;
    }
    this.#purgedAt = now;
    this.#purging = purgeLogs(db, config.maxDays)
      .catch((error: unknown) => {
        console.error("[nextbase] deleting expired log entries failed:", error);
      })
      .finally(() => {
        this.#purging = undefined;
      });
    this.#waitUntil(this.#purging);
  }

  /**
   * The wall time in microseconds, as timestamptz keeps it: at least a
   * microsecond after the last entry's, so entries of one instance sort in
   * the order they were added.
   */
  #now(): string {
    const micros = Math.max(this.#lastMicros + 1, Date.now() * 1000);
    this.#lastMicros = micros;
    const fraction = String(micros % 1000).padStart(3, "0");
    return new Date(Math.floor(micros / 1000))
      .toISOString()
      .replace("Z", `${fraction}Z`);
  }
}

function parseOptions(options: LogsOptions): Config {
  if (options === null || typeof options !== "object") {
    throw new TypeError("logs must be false or an object.");
  }
  const { maxDays = 7, minLevel = LOG_LEVELS.info } = options;
  if (typeof maxDays !== "number" || !Number.isFinite(maxDays) || maxDays < 1) {
    throw new RangeError("logs.maxDays must be a number of days, at least 1.");
  }
  if (typeof minLevel !== "number" || !Number.isFinite(minLevel)) {
    throw new RangeError(
      "logs.minLevel must be a number, such as 0 for info or 4 for warn.",
    );
  }
  for (const key of ["authId", "ip"] as const) {
    if (options[key] !== undefined && typeof options[key] !== "boolean") {
      throw new TypeError(`logs.${key} must be a boolean.`);
    }
  }
  return {
    maxDays,
    minLevel,
    authId: options.authId ?? false,
    ip: options.ip ?? false,
  };
}

/** One insert for every row: they travel as one JSON array. */
async function insertEntries(db: DB, rows: Entry[]): Promise<void> {
  await db
    .newQuery(
      `INSERT INTO {{${LOGS}}} (id, created, level, message, data)
       SELECT id, created, level, message, data
       FROM jsonb_to_recordset({:rows}::jsonb)
         AS r(id text, created timestamptz, level smallint, message text, data jsonb)`,
    )
    .bind({ rows: JSON.stringify(rows) })
    .execute();
}

/** Deletes entries older than `maxDays`, oldest first, in batches. */
export async function purgeLogs(db: DB, maxDays: number): Promise<void> {
  for (;;) {
    const { rowsAffected } = await db
      .newQuery(
        `DELETE FROM {{${LOGS}}} WHERE id IN (
           SELECT id FROM {{${LOGS}}}
           WHERE created < now() - make_interval(secs => {:seconds})
           ORDER BY created
           LIMIT ${PURGE_BATCH}
         )`,
      )
      .bind({ seconds: maxDays * 86_400 })
      .execute();
    if (rowsAffected < PURGE_BATCH) return;
  }
}

/** The message of a thrown value, whatever it is. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "Unknown error";
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Text Postgres can store, in strings at any depth: jsonb refuses NUL
 * characters and unpaired surrogates, and one bad entry would fail the whole
 * insert.
 */
function storable(value: unknown): unknown {
  if (typeof value === "string") {
    return value.toWellFormed().replaceAll("\0", "�");
  }
  if (Array.isArray(value)) return value.map(storable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [storableText(k), storable(v)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

function storableText(text: string): string {
  return text.toWellFormed().replaceAll("\0", "\uFFFD");
}
