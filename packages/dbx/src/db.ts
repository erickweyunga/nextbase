import {
  Builder,
  type DBOptions,
  type Queryable,
  type QueryConfig,
  type QueryResult,
} from "./builder.ts";
import { queryWithSignal } from "./cancel.ts";

/** The part of a `pg` PoolClient that dbx calls. */
export interface PoolClient extends Queryable {
  release(destroy?: boolean | Error): void;
}

/** The part of a `pg` Pool that dbx calls. */
export interface Pool extends Queryable {
  connect(): Promise<PoolClient>;
}

export interface TxOptions {
  isolation?:
    | "serializable"
    | "repeatable read"
    | "read committed"
    | "read uncommitted";
  readOnly?: boolean;
  deferrable?: boolean;
}

const ISOLATION_LEVELS: ReadonlySet<string> = new Set([
  "serializable",
  "repeatable read",
  "read committed",
  "read uncommitted",
]);

/** Thrown when a transaction is used after it was committed or rolled back. */
export class TxDoneError extends Error {
  constructor() {
    super("dbx: transaction has already been committed or rolled back.");
    this.name = "TxDoneError";
  }
}

/**
 * The entry point. Queries run on the pool; each statement may use a
 * different connection, so use `transaction()` for work that must share one.
 *
 * The pool belongs to the caller, who also ends it.
 */
export class DB extends Builder {
  readonly pool: Pool;

  constructor(pool: Pool, options: DBOptions = {}) {
    super(
      {
        query: (config, signal) =>
          signal ? queryPool(pool, config, signal) : pool.query(config),
      },
      options,
    );
    this.pool = pool;
  }

  /**
   * Returns a DB on the same pool whose queries and transactions abort with
   * `signal`, for example a request's signal. See `Query.withSignal()`.
   */
  withSignal(signal: AbortSignal | undefined): DB {
    return new DB(this.pool, { ...this.options, signal });
  }

  /** Starts a transaction on a dedicated connection. Prefer `transaction()`. */
  async begin(options: TxOptions = {}): Promise<Tx> {
    const text = beginSQL(options);
    const client = await connect(this.pool, this.options.signal);
    try {
      await client.query({ text, values: [] });
    } catch (error) {
      client.release(asError(error));
      throw error;
    }
    return new Tx(client, this.options, this.pool);
  }

  /**
   * Runs `fn` in a transaction. It commits when `fn` resolves and rolls back
   * when it rejects, then settles with `fn`'s result or error. `fn` may commit
   * or roll back itself.
   */
  async transaction<T>(
    fn: (tx: Tx) => Promise<T>,
    options?: TxOptions,
  ): Promise<T> {
    const tx = await this.begin(options);
    let result: T;
    try {
      result = await fn(tx);
    } catch (error) {
      if (!tx.done) {
        try {
          await tx.rollback();
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "dbx: transaction failed and could not be rolled back.",
          );
        }
      }
      throw error;
    }
    if (!tx.done) await tx.commit();
    return result;
  }
}

/**
 * A transaction on one pinned connection. It has every query method of `DB`.
 * The connection returns to the pool on commit or rollback, after which the
 * transaction rejects every query with TxDoneError.
 */
export class Tx extends Builder {
  readonly #client: PoolClient;
  readonly #state: { done: boolean; canceled: boolean };

  /**
   * Wraps a connection on which `BEGIN` has already run. `pool` is the pool it
   * came from; its settings are used to send cancel requests.
   */
  constructor(client: PoolClient, options: DBOptions = {}, pool?: Pool) {
    const state = { done: false, canceled: false };
    const clientConfig = poolConfig(pool);
    super(
      {
        async query(config, signal) {
          if (state.done) throw new TxDoneError();
          if (!signal) return client.query(config);
          signal.throwIfAborted();
          return queryWithSignal(client, config, signal, clientConfig, () => {
            state.canceled = true;
          }).result;
        },
      },
      options,
    );
    this.#client = client;
    this.#state = state;
  }

  /** Whether the transaction was committed or rolled back. */
  get done(): boolean {
    return this.#state.done;
  }

  commit(): Promise<void> {
    return this.#finish("COMMIT");
  }

  rollback(): Promise<void> {
    return this.#finish("ROLLBACK");
  }

  async #finish(command: "COMMIT" | "ROLLBACK"): Promise<void> {
    if (this.#state.done) throw new TxDoneError();
    this.#state.done = true;
    try {
      await this.#client.query({ text: command, values: [] });
    } catch (error) {
      // The connection's transaction state is unknown, so it is discarded
      // instead of returned to the pool.
      this.#client.release(asError(error));
      throw error;
    }
    // A cancel request can arrive after its statement finished, so a
    // connection that had one is not handed to another caller.
    this.#client.release(this.#state.canceled);
  }
}

async function queryPool(
  pool: Pool,
  config: QueryConfig,
  signal: AbortSignal,
): Promise<QueryResult> {
  // The statement needs a known connection so it can be canceled.
  const client = await connect(pool, signal);
  let canceled = false;
  const { result, settled } = queryWithSignal(
    client,
    config,
    signal,
    poolConfig(pool),
    () => {
      canceled = true;
    },
  );
  // A cancel request can arrive after its statement finished, so a connection
  // that had one is discarded instead of reused.
  void settled.then(() => client.release(canceled));
  return result;
}

/**
 * Takes a connection from the pool. When `signal` aborts while waiting, for
 * example on an exhausted pool, it rejects at once and the connection is
 * released when it arrives.
 */
function connect(
  pool: Pool,
  signal: AbortSignal | undefined,
): Promise<PoolClient> {
  if (!signal) return pool.connect();
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    pool.connect().then(
      (client) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) client.release();
        else resolve(client);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// node-postgres pools keep the config every client is created with.
function poolConfig(pool: Pool | undefined): object | undefined {
  const options = (pool as { options?: unknown } | undefined)?.options;
  return typeof options === "object" && options !== null ? options : undefined;
}

// The modes are written into the SQL text, so each one is checked.
function beginSQL({ isolation, readOnly, deferrable }: TxOptions): string {
  const modes: string[] = [];
  if (isolation !== undefined) {
    if (!ISOLATION_LEVELS.has(isolation)) {
      throw new RangeError(`dbx: unknown isolation level "${isolation}".`);
    }
    modes.push(`ISOLATION LEVEL ${isolation.toUpperCase()}`);
  }
  if (readOnly !== undefined) modes.push(readOnly ? "READ ONLY" : "READ WRITE");
  if (deferrable !== undefined) {
    modes.push(deferrable ? "DEFERRABLE" : "NOT DEFERRABLE");
  }
  return modes.length === 0 ? "BEGIN" : `BEGIN ${modes.join(", ")}`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
