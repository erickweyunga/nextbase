import type { Builder, QueryConfig, QueryResult } from "./builder.ts";

/** Values for `{:name}` placeholders, keyed by name. */
export type Params = Record<string, unknown>;

/** A result row, keyed by column name. */
export type Row = Record<string, unknown>;

export interface ExecResult {
  /** Rows inserted, updated or deleted. 0 for statements that report no count. */
  rowsAffected: number;
}

/** Thrown by `one()` and `row()` when the query returns no rows. */
export class NoRowsError extends Error {
  constructor() {
    super("dbx: no rows in result set.");
    this.name = "NoRowsError";
  }
}

/**
 * A SQL statement with named parameters.
 *
 * Placeholders are written `{:name}` and become `$1`, `$2`, ... in the SQL sent
 * to Postgres; a name used twice reuses its number. `{{table}}` and
 * `[[column]]` are replaced with quoted identifiers.
 */
export class Query {
  /** The SQL as written, with `{:name}` placeholders. */
  readonly sql: string;
  /** The SQL sent to Postgres. */
  readonly rawSQL: string;
  readonly #builder: Builder;
  readonly #placeholders: readonly string[];
  #params: Params = {};
  #signal: AbortSignal | undefined;

  constructor(builder: Builder, sql: string) {
    this.#builder = builder;
    this.#signal = builder.options.signal;
    this.sql = sql;
    const processed = builder.processSQL(sql);
    this.rawSQL = processed.sql;
    this.#placeholders = processed.placeholders;
  }

  /** The bound parameters. */
  get params(): Params {
    return { ...this.#params };
  }

  /** Binds parameter values, adding to and overriding earlier bindings. */
  bind(params: Params): this {
    this.#params = { ...this.#params, ...params };
    return this;
  }

  /**
   * Makes the query abortable, overriding the DB's signal. If `signal` aborts
   * before the query runs, it never starts; while it runs, the query rejects
   * with the signal's reason and Postgres is asked to cancel the statement.
   *
   * Server-side cancellation needs a node-postgres pool or client; with other
   * drivers the query only stops being awaited. In a transaction, a canceled
   * statement aborts the transaction, so it can only be rolled back.
   */
  withSignal(signal: AbortSignal | undefined): this {
    this.#signal = signal;
    return this;
  }

  /** Runs a statement that returns no rows. */
  async execute(): Promise<ExecResult> {
    const result = await this.#run("exec");
    return { rowsAffected: result.rowCount ?? 0 };
  }

  /** Returns every row. `T` is not checked at runtime. */
  async all<T = Row>(): Promise<T[]> {
    const result = await this.#run("query");
    return result.rows as T[];
  }

  /** Returns the first row, or throws NoRowsError. `T` is not checked at runtime. */
  async one<T = Row>(): Promise<T> {
    const { rows } = await this.#run("query");
    if (rows.length === 0) throw new NoRowsError();
    return rows[0] as T;
  }

  /** Returns the first column of every row. */
  async column<T = unknown>(): Promise<T[]> {
    const result = await this.#run("query", "array");
    return result.rows.map((row) => (row as unknown[])[0] as T);
  }

  /** Returns the first row as an array of column values, or throws NoRowsError. */
  async row<T extends unknown[] = unknown[]>(): Promise<T> {
    const { rows } = await this.#run("query", "array");
    if (rows.length === 0) throw new NoRowsError();
    return rows[0] as T;
  }

  async #run(kind: "query" | "exec", rowMode?: "array"): Promise<QueryResult> {
    const values = this.#placeholders.map((name) => {
      if (!Object.hasOwn(this.#params, name)) {
        throw new Error(`dbx: named parameter not found: ${name}`);
      }
      return this.#params[name];
    });
    const { executor, options } = this.#builder;
    const log = kind === "exec" ? options.execLog : options.queryLog;
    const start = performance.now();
    try {
      const config: QueryConfig = { text: this.rawSQL, values };
      if (rowMode) config.rowMode = rowMode;
      if (options.types) config.types = options.types;
      const result = await executor.query(config, this.#signal);
      log?.({
        sql: this.sql,
        params: this.params,
        durationMs: performance.now() - start,
        rowCount: result.rowCount ?? 0,
      });
      return result;
    } catch (error) {
      log?.({
        sql: this.sql,
        params: this.params,
        durationMs: performance.now() - start,
        error,
      });
      throw error;
    }
  }
}
