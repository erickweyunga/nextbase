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

/** A statement in the form node-postgres's `query()` takes: SQL with `$n` placeholders and their values. */
export interface QueryConfig {
  text: string;
  values: unknown[];
  /** `"array"` returns each row as an array of values instead of an object. */
  rowMode?: "array";
  types?: TypeParsers;
}

/**
 * Parses result columns by type OID, as node-postgres's per-query `types`
 * option. Unlike `pg.types.setTypeParser`, it affects only the queries it is
 * passed to, not every pool in the process.
 */
export interface TypeParsers {
  getTypeParser(oid: number, format?: string): unknown;
}

/** The parts of a node-postgres result that dbx reads. */
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
  query(config: QueryConfig): Promise<QueryResult>;
}

/** Describes one finished statement. Passed to `queryLog` or `execLog`. */
export interface LogEvent {
  /** The SQL as written, with `{:name}` placeholders. */
  sql: string;
  /** Every bound value, which can include secrets such as password hashes. Redact before writing logs. */
  params: Params;
  /** Time from the call to the result, including any wait for a pool connection. */
  durationMs: number;
  /** Rows returned or affected. Absent when the statement failed. */
  rowCount?: number;
  /** The error the statement failed with. */
  error?: unknown;
}

export interface DBOptions {
  /** Called after every statement run with `all()`, `one()`, `column()` or `row()`, whether it succeeded or failed. */
  queryLog?: (event: LogEvent) => void;
  /** Called after every statement run with `execute()`, whether it succeeded or failed. */
  execLog?: (event: LogEvent) => void;
  /** Result column parsers for every query of this DB and its transactions. */
  types?: TypeParsers;
}

/**
 * The query methods shared by `DB` and `Tx`. Each method returns a query that
 * runs on the builder's executor: the pool for `DB`, the transaction's
 * connection for `Tx`. Nothing is sent to Postgres until the query is run.
 *
 * Quoting: names given to INSERT, UPDATE, DELETE, upsert, models, conditions
 * (`hash`, `isIn`, `like`, `between`) and schema statements are always quoted
 * as identifiers, so they are safe for any input; a dot separates schema, table
 * and column. The SELECT builder's columns, tables, ORDER BY and GROUP BY, and
 * index columns, also accept SQL expressions such as `count(*)`: a name there
 * containing `(` is used as written, so never pass untrusted input to them.
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
   * `[[column]]`. Returns the SQL and the placeholder name for each `$n`:
   * `"a={:x} OR b={:x}"` gives `"a=$1 OR b=$1"` and `["x"]`.
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
   * `INSERT ... ON CONFLICT (constraints) DO UPDATE`: inserts the row, or, when
   * it conflicts on the `constraints` columns, sets every column in `cols` to
   * its new value. An Expression value is used as SQL in both cases. With no
   * columns it becomes `DO NOTHING`.
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
   * Throws TypeError when no column is left to set.
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
   * `CREATE TABLE`. `cols` maps column names to their SQL definitions, in
   * order, such as `{ id: "uuid PRIMARY KEY", title: "text NOT NULL" }`.
   * `options` are SQL appended to the statement.
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

  /** `ALTER TABLE ... RENAME TO`. `newName` has no schema prefix: the table stays in its schema. */
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

  /** `ALTER TABLE ... ADD col type`. `type` is the SQL definition, such as `"text NOT NULL DEFAULT ''"`. */
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

  /** Adds a primary key constraint named `name` on `cols`. */
  addPrimaryKey(table: string, name: string, ...cols: string[]): Query {
    return this.newQuery(
      `ALTER TABLE ${quoteIdentifierPath(table)} ADD CONSTRAINT ${quoteIdentifier(name)} PRIMARY KEY (${quoteIdentifiers(cols)})`,
    );
  }

  dropPrimaryKey(table: string, name: string): Query {
    return this.#dropConstraint(table, name);
  }

  /**
   * Adds a foreign key constraint named `name`: `cols` of `table` reference
   * `refCols` of `refTable`. `options` are SQL appended to the statement, such
   * as `"ON DELETE CASCADE"`.
   */
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

  /** `CREATE INDEX name ON table (cols)`. Columns may be SQL expressions such as `lower(email)`. */
  createIndex(table: string, name: string, ...cols: string[]): Query {
    return this.#createIndex("INDEX", table, name, cols);
  }

  /** `CREATE UNIQUE INDEX name ON table (cols)`. Columns may be SQL expressions such as `lower(email)`. */
  createUniqueIndex(table: string, name: string, ...cols: string[]): Query {
    return this.#createIndex("UNIQUE INDEX", table, name, cols);
  }

  /** `DROP INDEX`. The index is looked up in the schema of `table`. */
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
