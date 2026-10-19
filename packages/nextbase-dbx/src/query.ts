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
 * A SQL statement with named parameters, ready to run. Created by
 * `newQuery()` and the other builder methods; run with `execute()`, `all()`,
 * `one()`, `column()` or `row()`. A query can be run more than once.
 *
 * Placeholders are written `{:name}` and become `$1`, `$2`, ... in the SQL sent
 * to Postgres; a name used twice reuses its number. `{{table}}` and
 * `[[column]]` are replaced with quoted identifiers. Running a query that has
 * a placeholder with no bound value throws.
 *
 * ```ts
 * await db.newQuery("SELECT * FROM {{posts}} WHERE [[author]]={:author}")
 *   .bind({ author: id })
 *   .all();
 * ```
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

  /** A copy of the bound parameters. */
  get params(): Params {
    return { ...this.#params };
  }

  /** Binds parameter values, adding to and overriding earlier bindings. */
  bind(params: Params): this {
    this.#params = { ...this.#params, ...params };
    return this;
  }

  /** Runs the statement for its effect and returns the number of rows it changed. Returned rows are ignored. */
  async execute(): Promise<ExecResult> {
    const result = await this.#run("exec");
    return { rowsAffected: result.rowCount ?? 0 };
  }

  /** Returns every row. `T` is not checked at runtime. */
  async all<T = Row>(): Promise<T[]> {
    const result = await this.#run("query");
    return result.rows as T[];
  }

  /**
   * Returns the first row, or throws NoRowsError. `T` is not checked at
   * runtime. Every row is fetched, so the SQL should limit itself to one.
   */
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
      const result = await executor.query(config);
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
