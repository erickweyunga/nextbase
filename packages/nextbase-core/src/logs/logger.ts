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
export type FailureType = "hook" | "storage" | "mail" | "sms" | "realtime";

/**
 * How often each instance deletes expired entries, in milliseconds. Tests
 * shorten it; apps have no reason to.
 */
export const logTimings = { purgeMs: 600_000 };

const LOGS = table("_logs");
// Rows per insert: a flush of more is split.
const BATCH = 200;
// Entries waiting to be written at most; more are dropped.
const MAX_PENDING = 1000;
// Expired rows each delete removes, so no delete holds locks for long.
const PURGE_BATCH = 10_000;
const MAX_ERROR = 2000;
const MAX_STACK = 8000;

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
 * insert. Writing never fails a request: errors only go to the console.
 */
export class Logger {
  readonly #config: Config | undefined;
  readonly #db: () => DB;
  readonly #ready: () => Promise<void>;
  readonly #waitUntil: (promise: Promise<unknown>) => void;
  #buffer: Entry[] = [];
  #scheduled = false;
  /** Entries buffered or being written. */
  #pending = 0;
  #dropping = false;
  #purgedAt = Number.NEGATIVE_INFINITY;

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
    if (this.#pending >= MAX_PENDING) {
      if (!this.#dropping) {
        this.#dropping = true;
        console.warn(
          `[nextbase] more than ${MAX_PENDING} log entries are waiting to be written; new ones are dropped until they are.`,
        );
      }
      return;
    }
    this.#pending++;
    this.#buffer.push({
      id: newId(),
      created: now(),
      level,
      message: storableText(message),
      data: storable(data) as Record<string, unknown>,
    });
    if (this.#buffer.length >= BATCH) {
      this.#waitUntil(this.#write(this.#buffer.splice(0)));
    } else if (!this.#scheduled) {
      this.#scheduled = true;
      this.#waitUntil(
        new Promise((resolve) => setImmediate(resolve)).then(() => {
          this.#scheduled = false;
          return this.#write(this.#buffer.splice(0));
        }),
      );
    }
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

  async #write(rows: Entry[]): Promise<void> {
    if (rows.length === 0) return;
    try {
      await this.#ready();
      const db = this.#db();
      for (let i = 0; i < rows.length; i += BATCH) {
        await insertEntries(db, rows.slice(i, i + BATCH));
      }
      this.#purge(db);
    } catch (error) {
      console.error("[nextbase] writing log entries failed:", error);
    } finally {
      this.#pending -= rows.length;
      if (this.#pending === 0) this.#dropping = false;
    }
  }

  /** Deletes expired entries, at most once per `purgeMs` per instance. */
  #purge(db: DB): void {
    const config = this.#config;
    const now = Date.now();
    if (!config || now - this.#purgedAt < logTimings.purgeMs) return;
    this.#purgedAt = now;
    this.#waitUntil(
      purgeLogs(db, config.maxDays).catch((error: unknown) => {
        console.error("[nextbase] deleting expired log entries failed:", error);
      }),
    );
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

/**
 * The time in microseconds, as timestamptz keeps it, so entries of one
 * instance sort in the order they were added.
 */
function now(): string {
  const ms = performance.timeOrigin + performance.now();
  const micros = String(Math.floor((ms % 1) * 1000)).padStart(3, "0");
  return new Date(Math.floor(ms)).toISOString().replace("Z", `${micros}Z`);
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
