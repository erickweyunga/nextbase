import {
  type Builder,
  lastResult,
  type QueryConfig,
  type QueryResult,
} from "./builder.ts";

/** Values for `{:name}` placeholders, keyed by name. */
export type Params = Record<string, unknown>;

export type Row = Record<string, unknown>;

export interface ExecResult {
  /** 0 for statements that report no count. */
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
 * A reusable SQL statement. `{:name}` becomes `$n` (a repeated name reuses its
 * number); `{{table}}` and `[[column]]` become quoted identifiers. Running with
 * an unbound placeholder throws.
 */
export class Query {
  /** The SQL as written, with `{:name}` placeholders. */
  readonly sql: string;
  /** The SQL sent to Postgres. */
  readonly rawSQL: string;
  readonly #builder: Builder;
  readonly #placeholders: readonly string[];
  #params: Params = {};

  constructor(builder: Builder, sql: string) {
    this.#builder = builder;
    this.sql = sql;
    const processed = builder.processSQL(sql);
    this.rawSQL = processed.sql;
    this.#placeholders = processed.placeholders;
  }

  get params(): Params {
    return { ...this.#params };
  }

  /** Merges over earlier bindings. */
  bind(params: Params): this {
    this.#params = { ...this.#params, ...params };
    return this;
  }

  /** Runs for effect; returned rows are ignored. */
  async execute(): Promise<ExecResult> {
    const result = await this.#run("exec");
    return { rowsAffected: result.rowCount ?? 0 };
  }

  /** Returns every row. `T` is not checked at runtime. */
  async all<T = Row>(): Promise<T[]> {
    const result = await this.#run("query");
    return result.rows as T[];
  }

  /** Throws NoRowsError if empty. Fetches every row, so the SQL should LIMIT 1. */
  async one<T = Row>(): Promise<T> {
    const { rows } = await this.#run("query");
    if (rows.length === 0) throw new NoRowsError();
    return rows[0] as T;
  }

  async column<T = unknown>(): Promise<T[]> {
    const result = await this.#run("query", "array");
    return result.rows.map((row) => (row as unknown[])[0] as T);
  }

  /** First row as an array of values. Throws NoRowsError if empty. */
  async row<T extends unknown[] = unknown[]>(): Promise<T> {
    const { rows } = await this.#run("query", "array");
    if (rows.length === 0) throw new NoRowsError();
    return rows[0] as T;
  }

  // SQL with several statements and no parameters is sent as one simple
  // query, which returns a result for each statement. Only the last one counts.
  async #run(kind: "query" | "exec", rowMode?: "array"): Promise<QueryResult> {
    const { executor, options } = this.#builder;
    const log = kind === "exec" ? options.execLog : options.queryLog;
    const start = performance.now();
    try {
      const values = this.#placeholders.map((name) => {
        if (!Object.hasOwn(this.#params, name)) {
          throw new Error(`dbx: named parameter not found: ${name}`);
        }
        return this.#params[name];
      });
      const config: QueryConfig = { text: this.rawSQL, values };
      if (rowMode) config.rowMode = rowMode;
      if (options.types) config.types = options.types;
      const result = lastResult(await executor.query(config));
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
