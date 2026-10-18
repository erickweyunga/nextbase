import { type Expression, isExpression } from "./expression.ts";
import { type ModelOptions, ModelQuery } from "./model.ts";
import { type Params, Query } from "./query.ts";
import { SelectQuery } from "./select.ts";
import {
  bindParam,
  quoteIdentifier,
  quoteIdentifierPath,
  rewriteSQL,
} from "./sql.ts";

export interface QueryConfig {
  text: string;
  values: unknown[];
  rowMode?: "array";
  types?: TypeParsers;
}

/**
 * Chooses how result columns are parsed, by type OID: node-postgres's
 * per-query `types` option. Applies to this DB's queries only, unlike
 * `pg.types.setTypeParser`, which changes parsing for every pool in the process.
 */
export interface TypeParsers {
  getTypeParser(oid: number, format?: string): unknown;
}

export interface QueryResult {
  rows: unknown[];
  rowCount: number | null;
}

/**
 * The part of a `pg` Pool or PoolClient that dbx calls. Pools that mirror the
 * `pg` interface, such as `@neondatabase/serverless`, work too.
 */
export interface Queryable {
  query(config: QueryConfig): Promise<QueryResult>;
}

/** Runs statements for a Builder: on the pool for `DB`, on one connection for `Tx`. */
export interface Executor {
  query(
    config: QueryConfig,
    signal: AbortSignal | undefined,
  ): Promise<QueryResult>;
}

export interface LogEvent {
  /** The SQL as written, with `{:name}` placeholders. */
  sql: string;
  /** Every bound value, which can include secrets such as password hashes. Redact before writing logs. */
  params: Params;
  durationMs: number;
  /** Rows returned or affected. Absent when the statement failed. */
  rowCount?: number;
  /** The error the statement failed with. */
  error?: unknown;
}

export interface DBOptions {
  /** Called after every statement that returns rows. */
  queryLog?: (event: LogEvent) => void;
  /** Called after every statement run with `execute()`. */
  execLog?: (event: LogEvent) => void;
  /**
   * Aborts queries that are running or not yet started, like a Go context.
   * See `Query.withSignal()`.
   */
  signal?: AbortSignal;
  /** Result column parsers for every query of this DB and its transactions. */
  types?: TypeParsers;
}

/**
 * Builds queries against one executor: the pool for `DB`, a pinned connection
 * for `Tx`.
 *
 * Names given to INSERT, UPDATE, DELETE, upsert, models, conditions (`hash`,
 * `isIn`, `like`, `between`) and schema statements are always quoted as
 * identifiers, so they are safe for any input; a dot separates schema, table
 * and column. The SELECT builder's columns, tables, ORDER BY and GROUP BY, and
 * index columns, accept SQL expressions such as `count(*)`: a name containing
 * `(` is used as written there, so never pass untrusted input to them.
 * Arguments documented as SQL, such as column types and statement options, are
 * always used as written.
 */
export class Builder {
  readonly executor: Executor;
  readonly options: DBOptions;

  constructor(executor: Executor, options: DBOptions) {
    this.executor = executor;
    this.options = options;
  }

  /** Creates a query from SQL with `{:name}` placeholders. */
  newQuery(sql: string): Query {
    return new Query(this, sql);
  }

  /** Starts a SELECT query. With no columns it selects `*`. */
  select(...cols: string[]): SelectQuery {
    return new SelectQuery(this).select(...cols);
  }

  /** Starts a model query that inserts, updates or deletes `record` in `table`. */
  model<T extends object>(
    table: string,
    record: T,
    options?: ModelOptions,
  ): ModelQuery<T> {
    return new ModelQuery(this, table, record, options);
  }

  /**
   * Replaces `{:name}` placeholders with `$n` and quotes `{{table}}` and
   * `[[column]]`. Returns the SQL and the placeholder name for each `$n`.
   */
  processSQL(sql: string): { sql: string; placeholders: string[] } {
    const placeholders: string[] = [];
    const numbers = new Map<string, number>();
    const text = rewriteSQL(sql, (kind, name) => {
      if (kind === "table") return this.quoteTableName(name);
      if (kind === "column") return this.quoteColumnName(name);
      let number = numbers.get(name);
      if (number === undefined) {
        number = placeholders.push(name);
        numbers.set(name, number);
      }
      return `$${number}`;
    });
    return { sql: text, placeholders };
  }

  /**
   * Quotes a string literal, for SQL that cannot take a parameter, such as a
   * column DEFAULT in DDL. Relies on `standard_conforming_strings`, which is on
   * by default. Prefer bound parameters everywhere else.
   */
  quote(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
  }

  /**
   * Quotes a table name, including a schema prefix such as `nextbase.posts`.
   * A name containing `(` or `{{` is SQL and returned as is.
   */
  quoteTableName(name: string): string {
    if (name.includes("(") || name.includes("{{")) return name;
    return name
      .split(".")
      .map((part) => this.quoteSimpleTableName(part))
      .join(".");
  }

  /**
   * Quotes a column name, including a table prefix such as `posts.title`. A
   * name containing `(`, `{{` or `[[` is SQL and returned as is.
   */
  quoteColumnName(name: string): string {
    if (name.includes("(") || name.includes("{{") || name.includes("[[")) {
      return name;
    }
    const dot = name.lastIndexOf(".");
    if (dot === -1) return this.quoteSimpleColumnName(name);
    return `${this.quoteTableName(name.slice(0, dot))}.${this.quoteSimpleColumnName(name.slice(dot + 1))}`;
  }

  /** Quotes a table name that has no schema prefix. */
  quoteSimpleTableName(name: string): string {
    return quoteIdentifier(name);
  }

  /** Quotes a column name that has no table prefix. `*` is left as is. */
  quoteSimpleColumnName(name: string): string {
    return name === "*" ? name : quoteIdentifier(name);
  }

  /**
   * `INSERT INTO table (...) VALUES (...)`. Values that are Expressions are
   * used as SQL; `undefined` values are skipped.
   */
  insert(table: string, cols: Params): Query {
    const { sql, params } = this.#insertSQL(table, cols);
    return this.newQuery(sql).bind(params);
  }

  /**
   * `INSERT ... ON CONFLICT (constraint columns) DO UPDATE`, setting every
   * inserted column to its new value.
   */
  upsert(
    table: string,
    cols: Params,
    ...constraints: [string, ...string[]]
  ): Query {
    const { sql, params } = this.#insertSQL(table, cols);
    const lines = definedEntries(cols).map(([name, value]) => {
      const col = quoteIdentifier(name);
      return isExpression(value)
        ? `${col}=${value.build(this, params)}`
        : `${col}=EXCLUDED.${col}`;
    });
    const action =
      lines.length === 0 ? "DO NOTHING" : `DO UPDATE SET ${lines.join(", ")}`;
    return this.newQuery(
      `${sql} ON CONFLICT (${quoteIdentifiers(constraints)}) ${action}`,
    ).bind(params);
  }

  /**
   * `UPDATE table SET ... WHERE where`. Values that are Expressions are used as
   * SQL; `undefined` values are skipped. Without `where`, every row is updated.
   */
  update(table: string, cols: Params, where?: Expression): Query {
    const params: Params = {};
    const lines = definedEntries(cols).map(
      ([name, value]) =>
        `${quoteIdentifier(name)}=${this.#valueSQL(value, params)}`,
    );
    if (lines.length === 0) {
      throw new TypeError(`dbx: update of "${table}" has no columns to set.`);
    }
    let sql = `UPDATE ${quoteIdentifierPath(table)} SET ${lines.join(", ")}`;
    const condition = where?.build(this, params) ?? "";
    if (condition !== "") sql += ` WHERE ${condition}`;
    return this.newQuery(sql).bind(params);
  }

  /** `DELETE FROM table WHERE where`. Without `where`, every row is deleted. */
  delete(table: string, where?: Expression): Query {
    const params: Params = {};
    let sql = `DELETE FROM ${quoteIdentifierPath(table)}`;
    const condition = where?.build(this, params) ?? "";
    if (condition !== "") sql += ` WHERE ${condition}`;
    return this.newQuery(sql).bind(params);
  }

  /**
   * `CREATE TABLE`. `cols` maps column names to their definitions, in order;
   * `options` are appended to the statement.
   */
  createTable(
    table: string,
    cols: Record<string, string>,
    ...options: string[]
  ): Query {
    const columns = Object.entries(cols).map(
      ([name, type]) => `${quoteIdentifier(name)} ${type}`,
    );
    const sql = [
      `CREATE TABLE ${quoteIdentifierPath(table)} (${columns.join(", ")})`,
      ...options,
    ].join(" ");
    return this.newQuery(sql);
  }

  renameTable(oldName: string, newName: string): Query {
    return this.newQuery(
      `ALTER TABLE ${quoteIdentifierPath(oldName)} RENAME TO ${quoteIdentifier(newName)}`,
    );
  }

  dropTable(table: string): Query {
    return this.newQuery(`DROP TABLE ${quoteIdentifierPath(table)}`);
  }

  truncateTable(table: string): Query {
    return this.newQuery(`TRUNCATE TABLE ${quoteIdentifierPath(table)}`);
  }

  addColumn(table: string, col: string, type: string): Query {
    return this.newQuery(
      `ALTER TABLE ${quoteIdentifierPath(table)} ADD ${quoteIdentifier(col)} ${type}`,
    );
  }

  dropColumn(table: string, col: string): Query {
    return this.newQuery(
      `ALTER TABLE ${quoteIdentifierPath(table)} DROP COLUMN ${quoteIdentifier(col)}`,
    );
  }

  renameColumn(table: string, oldName: string, newName: string): Query {
    return this.newQuery(
      `ALTER TABLE ${quoteIdentifierPath(table)} RENAME COLUMN ${quoteIdentifier(oldName)} TO ${quoteIdentifier(newName)}`,
    );
  }

  /** Changes a column's type: `ALTER TABLE ... ALTER COLUMN ... TYPE type`. */
  alterColumn(table: string, col: string, type: string): Query {
    return this.newQuery(
      `ALTER TABLE ${quoteIdentifierPath(table)} ALTER COLUMN ${quoteIdentifier(col)} TYPE ${type}`,
    );
  }

  addPrimaryKey(table: string, name: string, ...cols: string[]): Query {
    return this.newQuery(
      `ALTER TABLE ${quoteIdentifierPath(table)} ADD CONSTRAINT ${quoteIdentifier(name)} PRIMARY KEY (${quoteIdentifiers(cols)})`,
    );
  }

  dropPrimaryKey(table: string, name: string): Query {
    return this.#dropConstraint(table, name);
  }

  /** `options` are appended, for example `"ON DELETE CASCADE"`. */
  addForeignKey(
    table: string,
    name: string,
    cols: readonly string[],
    refCols: readonly string[],
    refTable: string,
    ...options: string[]
  ): Query {
    const sql = [
      `ALTER TABLE ${quoteIdentifierPath(table)} ADD CONSTRAINT ${quoteIdentifier(name)} FOREIGN KEY (${quoteIdentifiers(cols)}) REFERENCES ${quoteIdentifierPath(refTable)} (${quoteIdentifiers(refCols)})`,
      ...options,
    ].join(" ");
    return this.newQuery(sql);
  }

  dropForeignKey(table: string, name: string): Query {
    return this.#dropConstraint(table, name);
  }

  /** Columns may be SQL expressions such as `lower(email)`. */
  createIndex(table: string, name: string, ...cols: string[]): Query {
    return this.#createIndex("INDEX", table, name, cols);
  }

  /** Columns may be SQL expressions such as `lower(email)`. */
  createUniqueIndex(table: string, name: string, ...cols: string[]): Query {
    return this.#createIndex("UNIQUE INDEX", table, name, cols);
  }

  /** Indexes live in their table's schema, so the index name takes its prefix. */
  dropIndex(table: string, name: string): Query {
    const dot = table.lastIndexOf(".");
    const schema =
      dot === -1 ? "" : `${quoteIdentifierPath(table.slice(0, dot))}.`;
    return this.newQuery(`DROP INDEX ${schema}${quoteIdentifier(name)}`);
  }

  #insertSQL(table: string, cols: Params): { sql: string; params: Params } {
    const params: Params = {};
    const entries = definedEntries(cols);
    const quoted = quoteIdentifierPath(table);
    if (entries.length === 0) {
      return { sql: `INSERT INTO ${quoted} DEFAULT VALUES`, params };
    }
    const names = entries.map(([name]) => quoteIdentifier(name));
    const values = entries.map(([, value]) => this.#valueSQL(value, params));
    return {
      sql: `INSERT INTO ${quoted} (${names.join(", ")}) VALUES (${values.join(", ")})`,
      params,
    };
  }

  #valueSQL(value: unknown, params: Params): string {
    return isExpression(value)
      ? value.build(this, params)
      : bindParam(params, value);
  }

  #dropConstraint(table: string, name: string): Query {
    return this.newQuery(
      `ALTER TABLE ${quoteIdentifierPath(table)} DROP CONSTRAINT ${quoteIdentifier(name)}`,
    );
  }

  #createIndex(
    kind: "INDEX" | "UNIQUE INDEX",
    table: string,
    name: string,
    cols: readonly string[],
  ): Query {
    const columns = cols.map((col) => this.quoteColumnName(col)).join(", ");
    return this.newQuery(
      `CREATE ${kind} ${quoteIdentifier(name)} ON ${quoteIdentifierPath(table)} (${columns})`,
    );
  }
}

function definedEntries(cols: Params): [string, unknown][] {
  return Object.entries(cols).filter(([, value]) => value !== undefined);
}

function quoteIdentifiers(names: readonly string[]): string {
  return names.map(quoteIdentifier).join(", ");
}
