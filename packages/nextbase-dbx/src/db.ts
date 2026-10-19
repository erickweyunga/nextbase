import { Builder, type DBOptions, type Queryable } from "./builder.ts";

/** The part of a `pg` PoolClient that dbx calls. */
export interface PoolClient extends Queryable {
  /** Returns the connection to the pool; `true` or an Error closes it instead. */
  release(destroy?: boolean | Error): void;
}

/** The part of a `pg` Pool that dbx calls. */
export interface Pool extends Queryable {
  connect(): Promise<PoolClient>;
}

/** Transaction modes, written into the `BEGIN` statement. Postgres defaults apply to omitted fields. */
export interface TxOptions {
  isolation?:
    | "serializable"
    | "repeatable read"
    | "read committed"
    | "read uncommitted";
  /** `READ ONLY` or `READ WRITE`. */
  readOnly?: boolean;
  /** `DEFERRABLE` or `NOT DEFERRABLE`. Only has an effect on serializable read-only transactions. */
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
 * The entry point: query methods on a connection pool. Each statement may run
 * on a different connection, so use `transaction()` for work that must share
 * one. The pool belongs to the caller, who also ends it.
 *
 * ```ts
 * const db = new DB(new pg.Pool({ connectionString }));
 * ```
 */
export class DB extends Builder {
  readonly pool: Pool;

  constructor(pool: Pool, options: DBOptions = {}) {
    super({ query: (config) => pool.query(config) }, options);
    this.pool = pool;
  }

  /**
   * Takes a connection from the pool and starts a transaction on it. The
   * connection is held until `commit()` or `rollback()`, so one of them must
   * always be called. Prefer `transaction()`, which does that.
   */
  async begin(options: TxOptions = {}): Promise<Tx> {
    const text = beginSQL(options);
    const client = await this.pool.connect();
    try {
      await client.query({ text, values: [] });
    } catch (error) {
      client.release(asError(error));
      throw error;
    }
    return new Tx(client, this.options);
  }

  /**
   * Runs `fn` in a transaction. It commits when `fn` resolves and rolls back
   * when it rejects, then settles with `fn`'s result or error. `fn` may commit
   * or roll back itself. If the rollback fails too, it rejects with an
   * AggregateError holding both errors.
   *
   * ```ts
   * await db.transaction(async (tx) => {
   *   await tx.insert("posts", { title: "Hello" }).execute();
   *   await tx.update("users", { posts: exp("posts + 1") }, hash({ id })).execute();
   * });
   * ```
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
  readonly #state: { done: boolean };
  #savepoints = 0;

  /** Wraps a connection on which `BEGIN` has already run. */
  constructor(client: PoolClient, options: DBOptions = {}) {
    const state = { done: false };
    super(
      {
        async query(config) {
          if (state.done) throw new TxDoneError();
          return client.query(config);
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

  /**
   * Runs `fn` in a nested transaction, a savepoint. When `fn` rejects, its
   * changes are rolled back to the savepoint and the error is rethrown; the
   * outer transaction stays usable. Lets code written for `DB.transaction()`
   * run as part of a larger transaction.
   */
  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const name = `dbx_savepoint_${++this.#savepoints}`;
    await this.newQuery(`SAVEPOINT ${name}`).execute();
    let result: T;
    try {
      result = await fn(this);
    } catch (error) {
      if (!this.done) {
        try {
          await this.newQuery(`ROLLBACK TO SAVEPOINT ${name}`).execute();
          await this.newQuery(`RELEASE SAVEPOINT ${name}`).execute();
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "dbx: nested transaction failed and could not be rolled back.",
          );
        }
      }
      throw error;
    }
    if (!this.done) await this.newQuery(`RELEASE SAVEPOINT ${name}`).execute();
    return result;
  }

  /** Commits and returns the connection to the pool. Throws TxDoneError if already finished. */
  commit(): Promise<void> {
    return this.#finish("COMMIT");
  }

  /** Rolls back and returns the connection to the pool. Throws TxDoneError if already finished. */
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
    this.#client.release();
  }
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
