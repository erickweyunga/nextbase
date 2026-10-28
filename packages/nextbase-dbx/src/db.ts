import {
  Builder,
  type DBOptions,
  type Queryable,
  type QueryResult,
} from "./builder.ts";
import type { Row } from "./query.ts";

/** The part of a `pg` PoolClient that dbx calls. */
export interface PoolClient extends Queryable {
  /** Returns the connection to the pool; `true` or an Error closes it instead. */
  release(destroy?: boolean | Error): void;
}

/** The part of a `pg` Pool that dbx calls. */
export interface Pool extends Queryable {
  connect(): Promise<PoolClient>;
}

/** Modes for `BEGIN`; omitted fields use the Postgres defaults. */
export interface TxOptions {
  isolation?:
    | "serializable"
    | "repeatable read"
    | "read committed"
    | "read uncommitted";
  readOnly?: boolean;
  /** Only affects serializable read-only transactions. */
  deferrable?: boolean;
  /**
   * How long each statement in the transaction may run, in milliseconds.
   * It is set with `SET LOCAL`, so it ends with the transaction. 0 means no
   * limit.
   */
  statementTimeout?: number;
  /**
   * SQL without parameters to run right after `BEGIN`, in the same round
   * trip. Its rows are in `tx.startRows`.
   */
  startQuery?: string;
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
 * Thrown by `commit()` when Postgres rolled the transaction back instead,
 * because a statement in it failed and the error was caught.
 */
export class TxAbortedError extends Error {
  constructor() {
    super(
      "dbx: the transaction was rolled back because a statement in it failed.",
    );
    this.name = "TxAbortedError";
  }
}

/**
 * Query methods on a pool. Statements may run on different connections; use
 * `transaction()` to share one. The caller owns and ends the pool.
 */
export class DB extends Builder {
  readonly pool: Pool;

  constructor(pool: Pool, options: DBOptions = {}) {
    super({ query: (config) => pool.query(config) }, options);
    this.pool = pool;
  }

  /**
   * The connection is held until `commit()` or `rollback()`, so one must always
   * be called. Prefer `transaction()`.
   */
  async begin(options: TxOptions = {}): Promise<Tx> {
    const statements = [beginSQL(options)];
    const { statementTimeout, startQuery } = options;
    if (statementTimeout !== undefined) {
      if (!Number.isSafeInteger(statementTimeout) || statementTimeout < 0) {
        throw new RangeError(
          "dbx: statementTimeout must be a whole number of milliseconds.",
        );
      }
      statements.push(`SET LOCAL statement_timeout = ${statementTimeout}`);
    }
    if (startQuery !== undefined) statements.push(startQuery);
    const client = await this.pool.connect();
    let result: QueryResult | QueryResult[];
    try {
      // Statements without parameters are sent to Postgres together, in one
      // round trip. Postgres returns one result for each.
      result = (await client.query({
        text: statements.join("; "),
        values: [],
        ...(this.options.types && { types: this.options.types }),
      })) as QueryResult | QueryResult[];
    } catch (error) {
      client.release(asError(error));
      throw error;
    }
    const startRows =
      startQuery === undefined
        ? []
        : ((asArray(result).at(-1)?.rows ?? []) as Row[]);
    return new Tx(client, this.options, startRows);
  }

  /**
   * Commits when `fn` resolves, rolls back when it rejects; `fn` may finish it
   * itself. A failed rollback rejects with an AggregateError of both errors.
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

/** A transaction on one pinned connection. Queries after it finishes throw TxDoneError. */
export class Tx extends Builder {
  readonly #client: PoolClient;
  readonly #state: { done: boolean };
  #savepoints = 0;
  /** The rows of `startQuery`, or none if there was no `startQuery`. */
  readonly startRows: readonly Row[];

  /** Wraps a connection on which `BEGIN` has already run. */
  constructor(
    client: PoolClient,
    options: DBOptions = {},
    startRows: readonly Row[] = [],
  ) {
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
    this.startRows = startRows;
  }

  get done(): boolean {
    return this.#state.done;
  }

  /**
   * Runs `fn` in a savepoint. On reject only its changes are rolled back and the
   * outer transaction stays usable.
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

  /** Throws TxDoneError if already finished. */
  commit(): Promise<void> {
    return this.#finish("COMMIT");
  }

  /** Throws TxDoneError if already finished. */
  rollback(): Promise<void> {
    return this.#finish("ROLLBACK");
  }

  async #finish(command: "COMMIT" | "ROLLBACK"): Promise<void> {
    if (this.#state.done) throw new TxDoneError();
    this.#state.done = true;
    let result: QueryResult;
    try {
      result = await this.#client.query({ text: command, values: [] });
    } catch (error) {
      // Transaction state is unknown, so discard the connection.
      this.#client.release(asError(error));
      throw error;
    }
    this.#client.release();
    // COMMIT of a failed transaction rolls it back without an error, and
    // says so only in its command tag.
    if (command === "COMMIT" && result.command === "ROLLBACK") {
      throw new TxAbortedError();
    }
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

function asArray(result: QueryResult | QueryResult[]): QueryResult[] {
  return Array.isArray(result) ? result : [result];
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
