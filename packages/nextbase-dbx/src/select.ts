import type { Builder } from "./builder.ts";
import { and, type Expression, hash, or } from "./expression.ts";
import {
  CompositePKError,
  MissingPKError,
  type ModelOptions,
} from "./model.ts";
import type { Params, Query, Row } from "./query.ts";
import { mergeParams } from "./sql.ts";

interface Join {
  type: string;
  table: string;
  on: Expression | undefined;
}

interface Union {
  all: boolean;
  query: Query;
}

// Trailing alias: `name AS alias` or `name alias`.
const ALIAS = /(?:\s+as\s+|\s+)([\w\-.]+)$/i;
// Trailing ORDER BY direction and NULLS ordering.
const DIRECTION =
  /\s+((?:ASC|DESC)(?:\s+NULLS\s+(?:FIRST|LAST))?|NULLS\s+(?:FIRST|LAST))$/i;

/**
 * A SELECT built clause by clause. Setters replace a clause; the `and...` and
 * `or...` methods extend it.
 */
export class SelectQuery {
  readonly #builder: Builder;
  #selects: string[] = [];
  #distinct = false;
  #selectOption = "";
  #from: string[] = [];
  #where: Expression | undefined;
  #joins: Join[] = [];
  #orderBy: string[] = [];
  #groupBy: string[] = [];
  #having: Expression | undefined;
  #unions: Union[] = [];
  #limit = -1;
  #offset = 0;
  #params: Params = {};

  constructor(builder: Builder) {
    this.#builder = builder;
  }

  /** Sets the selected columns. Each may have an alias: `"name AS n"` or `"name n"`. */
  select(...cols: string[]): this {
    this.#selects = cols;
    return this;
  }

  andSelect(...cols: string[]): this {
    this.#selects.push(...cols);
    return this;
  }

  distinct(value: boolean): this {
    this.#distinct = value;
    return this;
  }

  /** SQL placed right after `SELECT`, for example `"DISTINCT ON (author)"`. */
  selectOption(option: string): this {
    this.#selectOption = option;
    return this;
  }

  /** Sets the FROM tables. Each may have an alias: `"posts p"`. */
  from(...tables: string[]): this {
    this.#from = tables;
    return this;
  }

  where(exp: Expression): this {
    this.#where = exp;
    return this;
  }

  andWhere(exp: Expression): this {
    this.#where = and(this.#where, exp);
    return this;
  }

  orWhere(exp: Expression): this {
    this.#where = or(this.#where, exp);
    return this;
  }

  /** `type` is SQL such as `"CROSS JOIN"`. Without `on`, there is no ON clause. */
  join(type: string, table: string, on?: Expression): this {
    this.#joins.push({ type, table, on });
    return this;
  }

  innerJoin(table: string, on?: Expression): this {
    return this.join("INNER JOIN", table, on);
  }

  leftJoin(table: string, on?: Expression): this {
    return this.join("LEFT JOIN", table, on);
  }

  rightJoin(table: string, on?: Expression): this {
    return this.join("RIGHT JOIN", table, on);
  }

  /** Sets the ORDER BY columns. Each may end in `ASC` or `DESC`, and `NULLS FIRST` or `NULLS LAST`. */
  orderBy(...cols: string[]): this {
    this.#orderBy = cols;
    return this;
  }

  andOrderBy(...cols: string[]): this {
    this.#orderBy.push(...cols);
    return this;
  }

  groupBy(...cols: string[]): this {
    this.#groupBy = cols;
    return this;
  }

  andGroupBy(...cols: string[]): this {
    this.#groupBy.push(...cols);
    return this;
  }

  having(exp: Expression): this {
    this.#having = exp;
    return this;
  }

  andHaving(exp: Expression): this {
    this.#having = and(this.#having, exp);
    return this;
  }

  orHaving(exp: Expression): this {
    this.#having = or(this.#having, exp);
    return this;
  }

  /** Params are merged; a name bound to different values is renamed in the union. */
  union(query: Query): this {
    this.#unions.push({ all: false, query });
    return this;
  }

  /** Like `union()`, but keeps duplicate rows. */
  unionAll(query: Query): this {
    this.#unions.push({ all: true, query });
    return this;
  }

  /** Negative means no limit. Throws RangeError for a non-integer. */
  limit(limit: number): this {
    this.#limit = checkInteger("limit", limit);
    return this;
  }

  /** Throws RangeError for a non-integer. */
  offset(offset: number): this {
    this.#offset = checkInteger("offset", offset);
    return this;
  }

  /** Replaces earlier placeholder values. */
  bind(params: Params): this {
    this.#params = { ...params };
    return this;
  }

  /** Merges over earlier placeholder values. */
  andBind(params: Params): this {
    Object.assign(this.#params, params);
    return this;
  }

  build(): Query {
    return this.#build(this.#where, this.#limit);
  }

  all<T = Row>(): Promise<T[]> {
    return this.build().all<T>();
  }

  /** Fetches one row only. Throws NoRowsError if empty. */
  one<T = Row>(): Promise<T> {
    return this.#build(this.#where, this.#firstRowLimit()).one<T>();
  }

  column<T = unknown>(): Promise<T[]> {
    return this.build().column<T>();
  }

  /** Fetches one row only. Throws NoRowsError if empty. */
  row<T extends unknown[] = unknown[]>(): Promise<T> {
    return this.#build(this.#where, this.#firstRowLimit()).row<T>();
  }

  /**
   * Row whose key is `pk`, ANDed with WHERE without changing this query. Needs
   * `from()`; for composite keys use `where(hash(...)).one()`.
   */
  async model<T = Row>(pk: unknown, options: ModelOptions = {}): Promise<T> {
    const key = options.pk ?? "id";
    const cols = typeof key === "string" ? [key] : key;
    const [col] = cols;
    if (col === undefined) throw new MissingPKError();
    if (cols.length > 1) throw new CompositePKError();
    if (this.#from.length === 0) {
      throw new TypeError("dbx: model() needs from() to name the table.");
    }
    const where = and(this.#where, hash({ [col]: pk }));
    return this.#build(where, this.#firstRowLimit()).one<T>();
  }

  #build(where: Expression | undefined, limit: number): Query {
    const params: Params = { ...this.#params };
    let sql = [
      this.#buildSelect(),
      this.#buildFrom(),
      this.#buildJoins(params),
      this.#buildCondition("WHERE", where, params),
      this.#buildGroupBy(),
      this.#buildCondition("HAVING", this.#having, params),
      this.#buildOrderBy(),
      buildLimit(limit, this.#offset),
    ]
      .filter((clause) => clause !== "")
      .join(" ");

    if (this.#unions.length > 0) {
      const unions = this.#unions.map(
        ({ all, query }) =>
          `${all ? "UNION ALL" : "UNION"} (${mergeParams(query.sql, query.params, params)})`,
      );
      sql = `(${sql}) ${unions.join(" ")}`;
    }

    return this.#builder.newQuery(sql).bind(params);
  }

  // Skipped with a union, where LIMIT would bind to the first part only.
  #firstRowLimit(): number {
    return this.#limit < 0 && this.#unions.length === 0 ? 1 : this.#limit;
  }

  #buildSelect(): string {
    let sql = "SELECT ";
    if (this.#distinct) sql += "DISTINCT ";
    if (this.#selectOption !== "") sql += `${this.#selectOption} `;
    if (this.#selects.length === 0) return `${sql}*`;
    const cols = this.#selects.map((col) => {
      const match = ALIAS.exec(col);
      if (!match) return this.#builder.quoteColumnName(col);
      const name = col.slice(0, -match[0].length);
      return `${this.#builder.quoteColumnName(name)} AS ${this.#builder.quoteSimpleColumnName(match[1] as string)}`;
    });
    return sql + cols.join(", ");
  }

  #buildFrom(): string {
    if (this.#from.length === 0) return "";
    return `FROM ${this.#from.map((table) => this.#quoteTableAndAlias(table)).join(", ")}`;
  }

  #buildJoins(params: Params): string {
    return this.#joins
      .map(({ type, table, on }) => {
        const sql = `${type} ${this.#quoteTableAndAlias(table)}`;
        const condition = on?.build(this.#builder, params) ?? "";
        return condition === "" ? sql : `${sql} ON ${condition}`;
      })
      .join(" ");
  }

  #buildCondition(
    keyword: "WHERE" | "HAVING",
    exp: Expression | undefined,
    params: Params,
  ): string {
    const condition = exp?.build(this.#builder, params) ?? "";
    return condition === "" ? "" : `${keyword} ${condition}`;
  }

  #buildGroupBy(): string {
    if (this.#groupBy.length === 0) return "";
    return `GROUP BY ${this.#groupBy.map((col) => this.#builder.quoteColumnName(col)).join(", ")}`;
  }

  #buildOrderBy(): string {
    if (this.#orderBy.length === 0) return "";
    const cols = this.#orderBy.map((col) => {
      const match = DIRECTION.exec(col);
      if (!match) return this.#builder.quoteColumnName(col);
      return `${this.#builder.quoteColumnName(col.slice(0, -match[0].length))} ${match[1]}`;
    });
    return `ORDER BY ${cols.join(", ")}`;
  }

  #quoteTableAndAlias(table: string): string {
    const match = ALIAS.exec(table);
    if (!match) return this.#builder.quoteTableName(table);
    return `${this.#builder.quoteTableName(table.slice(0, -match[0].length))} ${this.#builder.quoteSimpleTableName(match[1] as string)}`;
  }
}

function buildLimit(limit: number, offset: number): string {
  const parts: string[] = [];
  if (limit >= 0) parts.push(`LIMIT ${limit}`);
  if (offset > 0) parts.push(`OFFSET ${offset}`);
  return parts.join(" ");
}

// LIMIT and OFFSET are written into the SQL text, so they must be real integers.
function checkInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`dbx: ${name} must be an integer, got ${value}.`);
  }
  return value;
}
