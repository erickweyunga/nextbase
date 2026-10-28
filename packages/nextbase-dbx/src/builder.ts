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
  /** `"array"` returns each row as an array of values instead of an object. */
  rowMode?: "array";
  types?: TypeParsers;
}

/** Per-query type parsers; unlike `pg.types.setTypeParser`, not process-global. */
export interface TypeParsers {
  getTypeParser(oid: number, format?: string): unknown;
}

export interface QueryResult {
  rows: unknown[];
  rowCount: number | null;
  /** The command tag Postgres sent back, such as "INSERT" or "ROLLBACK". */
  command?: string;
}

/** The subset of a `pg` Pool or PoolClient that dbx calls. */
export interface Queryable {
  query(config: QueryConfig): Promise<QueryResult>;
}

/** The pool for `DB`, one pinned connection for `Tx`. */
export interface Executor {
  query(config: QueryConfig): Promise<QueryResult>;
}

export interface LogEvent {
  /** The SQL as written, with `{:name}` placeholders. */
  sql: string;
  /** May include secrets such as password hashes; redact before logging. */
  params: Params;
  /** Includes any wait for a pool connection. */
  durationMs: number;
  /** Absent when the statement failed. */
  rowCount?: number;
  error?: unknown;
}

export interface DBOptions {
  /** Called after each `all()`, `one()`, `column()` or `row()`, success or failure. */
  queryLog?: (event: LogEvent) => void;
  /** Called after each `execute()`, success or failure. */
  execLog?: (event: LogEvent) => void;
  /** Applies to this DB and its transactions. */
  types?: TypeParsers;
}

/**
 * Query methods shared by `DB` and `Tx`. Nothing is sent until a query is run.
 *
 * Quoting: names given to writes, models, conditions and schema statements are
 * always quoted, so any input is safe. SELECT columns, tables, ORDER BY, GROUP BY
 * and index columns containing `(` are raw SQL: never pass untrusted input there.
 * Arguments documented as SQL (types, options) are used as written.
 */
export class Builder {
  readonly executor: Executor;
  readonly options: DBOptions;

  constructor(executor: Executor, options: DBOptions) {
    this.executor = executor;
    this.options = options;
  }

  newQuery(sql: string): Query {
    return new Query(this, sql);
  }

  /** With no columns it selects `*`. */
  select(...cols: string[]): SelectQuery {
    return new SelectQuery(this).select(...cols);
  }

  model<T extends object>(
    table: string,
    record: T,
    options?: ModelOptions,
  ): ModelQuery<T> {
    return new ModelQuery(this, table, record, options);
  }

  /**
   * Numbers placeholders and quotes identifiers: `"a={:x} OR b={:x}"` gives
   * `"a=$1 OR b=$1"` with placeholders `["x"]`.
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
   * Quotes a string literal for DDL that cannot take a parameter (e.g. DEFAULT).
   * Assumes `standard_conforming_strings` is on. Prefer bound parameters.
   */
  quote(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
  }

  /** Handles a schema prefix. A name containing `(` or `{{` is raw SQL. */
  quoteTableName(name: string): string {
    if (name.includes("(") || name.includes("{{")) return name;
    return name
      .split(".")
      .map((part) => this.quoteSimpleTableName(part))
      .join(".");
  }

  /** Handles a table prefix. A name containing `(`, `{{` or `[[` is raw SQL. */
  quoteColumnName(name: string): string {
    if (name.includes("(") || name.includes("{{") || name.includes("[[")) {
      return name;
    }
    const dot = name.lastIndexOf(".");
    if (dot === -1) return this.quoteSimpleColumnName(name);
    return `${this.quoteTableName(name.slice(0, dot))}.${this.quoteSimpleColumnName(name.slice(dot + 1))}`;
  }

  quoteSimpleTableName(name: string): string {
    return quoteIdentifier(name);
  }

  /** `*` is left as is. */
  quoteSimpleColumnName(name: string): string {
    return name === "*" ? name : quoteIdentifier(name);
  }

  /** Expression values are used as SQL; `undefined` values are skipped. */
  insert(table: string, cols: Params): Query {
    const { sql, params } = this.#insertSQL(table, cols);
    return this.newQuery(sql).bind(params);
  }

  /**
   * One INSERT of several rows. As in `insert`, Expression values are SQL and
   * `undefined` values are skipped. The columns are those any row sets, and a
   * row that leaves one out gets its default. Postgres takes at most 65535
   * parameters per statement, so very many rows need several calls.
   */
  insertMany(table: string, rows: readonly Params[]): Query {
    if (rows.length === 0)
      throw new TypeError(`dbx: insertMany into "${table}" has no rows.`);
    const names = [
      ...new Set(rows.flatMap((row) => definedEntries(row).map(([n]) => n))),
    ];
    if (names.length === 0) {
      throw new TypeError(`dbx: insertMany into "${table}" has no columns.`);
    }
    const params: Params = {};
    const tuples = rows.map((row) => {
      const values = names.map((name) =>
        row[name] === undefined ? "DEFAULT" : this.#valueSQL(row[name], params),
      );
      return `(${values.join(", ")})`;
    });
    return this.newQuery(
      `INSERT INTO ${quoteIdentifierPath(table)} (${quoteIdentifiers(names)}) VALUES ${tuples.join(", ")}`,
    ).bind(params);
  }

  /**
   * On conflict on `constraints`, sets every column in `cols` (Expressions as
   * SQL). With no columns it becomes `DO NOTHING`.
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
   * Expression values are SQL; `undefined` values are skipped. Without `where`,
   * every row is updated. Throws TypeError when no column is left to set.
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

  /** Without `where`, every row is deleted. */
  delete(table: string, where?: Expression): Query {
    const params: Params = {};
    let sql = `DELETE FROM ${quoteIdentifierPath(table)}`;
    const condition = where?.build(this, params) ?? "";
    if (condition !== "") sql += ` WHERE ${condition}`;
    return this.newQuery(sql).bind(params);
  }

  /**
   * `cols` maps names to SQL definitions, e.g. `{ id: "uuid PRIMARY KEY" }`.
   * `options` are appended SQL.
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

  /** `newName` has no schema prefix; the table stays in its schema. */
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

  /** `type` is a SQL definition, e.g. `"text NOT NULL DEFAULT ''"`. */
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

  /** Changes a column's type. */
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

  /**
   * `cols` of `table` reference `refCols` of `refTable`. `options` are appended
   * SQL such as `"ON DELETE CASCADE"`.
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

  /** Columns may be SQL expressions such as `lower(email)`. */
  createIndex(table: string, name: string, ...cols: string[]): Query {
    return this.#createIndex("INDEX", table, name, cols);
  }

  /** Columns may be SQL expressions such as `lower(email)`. */
  createUniqueIndex(table: string, name: string, ...cols: string[]): Query {
    return this.#createIndex("UNIQUE INDEX", table, name, cols);
  }

  /** The index is looked up in the schema of `table`. */
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
