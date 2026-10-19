import type { Builder } from "./builder.ts";
import type { Params } from "./query.ts";
import { bindParam, mergeParams, quoteIdentifierPath } from "./sql.ts";

/**
 * A SQL fragment used as a WHERE, HAVING or JOIN ON condition, or as a value
 * in insert, update and upsert. Built with the functions in this module, such
 * as `hash({ status: "active" })` or `exp("age > {:min}", { min: 18 })`.
 *
 * `build` returns the SQL text and adds the values it needs to `params`. It
 * returns an empty string when the expression has no effect, so callers skip it.
 */
export interface Expression {
  build(builder: Builder, params: Params): string;
}

/** Whether `value` is an object with a `build` method, which is used as SQL instead of bound as a value. */
export function isExpression(value: unknown): value is Expression {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Expression).build === "function"
  );
}

class Exp implements Expression {
  readonly #sql: string;
  readonly #params: Params | undefined;

  constructor(sql: string, params: Params | undefined) {
    this.#sql = sql;
    this.#params = params;
  }

  build(_builder: Builder, params: Params): string {
    return this.#params
      ? mergeParams(this.#sql, this.#params, params)
      : this.#sql;
  }
}

class HashExp implements Expression {
  readonly #values: Record<string, unknown>;

  constructor(values: Record<string, unknown>) {
    this.#values = values;
  }

  build(builder: Builder, params: Params): string {
    const parts: string[] = [];
    for (const [name, value] of Object.entries(this.#values)) {
      if (value === undefined) {
        // Skipping it would silently widen the condition, for example turning
        // a delete of one row into a delete of every row.
        throw new TypeError(`dbx: hash value for "${name}" is undefined.`);
      }
      if (value === null) {
        parts.push(`${quoteIdentifierPath(name)} IS NULL`);
      } else if (isExpression(value)) {
        const sql = value.build(builder, params);
        if (sql !== "") parts.push(`(${sql})`);
      } else if (Array.isArray(value)) {
        const sql = isIn(name, ...value).build(builder, params);
        if (sql !== "") parts.push(sql);
      } else {
        parts.push(`${quoteIdentifierPath(name)}=${bindParam(params, value)}`);
      }
    }
    return parts.join(" AND ");
  }
}

class NotExp implements Expression {
  readonly #exp: Expression;

  constructor(exp: Expression) {
    this.#exp = exp;
  }

  build(builder: Builder, params: Params): string {
    const sql = this.#exp.build(builder, params);
    return sql === "" ? "" : `NOT (${sql})`;
  }
}

class AndOrExp implements Expression {
  readonly #exps: readonly (Expression | null | undefined)[];
  readonly #op: "AND" | "OR";

  constructor(
    exps: readonly (Expression | null | undefined)[],
    op: "AND" | "OR",
  ) {
    this.#exps = exps;
    this.#op = op;
  }

  build(builder: Builder, params: Params): string {
    const parts: string[] = [];
    for (const exp of this.#exps) {
      if (!exp) continue;
      const sql = exp.build(builder, params);
      if (sql !== "") parts.push(sql);
    }
    if (parts.length <= 1) return parts[0] ?? "";
    return `(${parts.join(`) ${this.#op} (`)})`;
  }
}

class InExp implements Expression {
  readonly #col: string;
  readonly #values: readonly unknown[];
  readonly #not: boolean;

  constructor(col: string, values: readonly unknown[], not: boolean) {
    this.#col = col;
    this.#values = values;
    this.#not = not;
  }

  // `col = NULL` and `col IN (..., NULL)` never match, so a null value becomes
  // an explicit IS NULL / IS NOT NULL test, as in hash().
  build(builder: Builder, params: Params): string {
    if (this.#values.length === 0) return this.#not ? "" : "0=1";

    const col = quoteIdentifierPath(this.#col);
    let hasNull = false;
    const values: string[] = [];
    for (const value of this.#values) {
      if (value === undefined) {
        throw new TypeError(`dbx: IN value for "${this.#col}" is undefined.`);
      }
      if (value === null) hasNull = true;
      else if (isExpression(value)) values.push(value.build(builder, params));
      else values.push(bindParam(params, value));
    }

    const parts: string[] = [];
    if (values.length === 1) {
      parts.push(`${col}${this.#not ? "<>" : "="}${values[0]}`);
    } else if (values.length > 1) {
      parts.push(
        `${col} ${this.#not ? "NOT IN" : "IN"} (${values.join(", ")})`,
      );
    }
    if (hasNull) parts.push(`${col} ${this.#not ? "IS NOT NULL" : "IS NULL"}`);
    if (parts.length === 1) return parts[0] as string;
    return this.#not ? parts.join(" AND ") : `(${parts.join(" OR ")})`;
  }
}

/** Escapes `\`, `%` and `_` so LIKE values match literally. */
export const DEFAULT_LIKE_ESCAPE: readonly string[] = [
  "\\",
  "\\\\",
  "%",
  "\\%",
  "_",
  "\\_",
];

/**
 * A LIKE condition, from `like()`, `notLike()`, `orLike()` or `orNotLike()`.
 * By default each value is escaped and wrapped in `%`, so it matches as a
 * literal substring; `escape()` and `match()` change that.
 */
export class LikeExp implements Expression {
  readonly #col: string;
  readonly #values: readonly string[];
  readonly #operator: "LIKE" | "NOT LIKE";
  readonly #or: boolean;
  #caseInsensitive = false;
  #escape: readonly string[] = DEFAULT_LIKE_ESCAPE;
  #left = true;
  #right = true;

  constructor(
    col: string,
    values: readonly string[],
    operator: "LIKE" | "NOT LIKE",
    or: boolean,
  ) {
    this.#col = col;
    this.#values = values;
    this.#operator = operator;
    this.#or = or;
  }

  /**
   * Sets the replacement pairs applied to each value: `escape(from1, to1,
   * from2, to2, ...)`. Call with no arguments to match values as patterns.
   */
  escape(...chars: string[]): this {
    if (chars.length % 2 !== 0) {
      throw new TypeError(
        "dbx: LikeExp.escape needs an even number of strings.",
      );
    }
    this.#escape = chars;
    return this;
  }

  /** Matches regardless of case, using Postgres `ILIKE`. */
  caseInsensitive(value = true): this {
    this.#caseInsensitive = value;
    return this;
  }

  /** Sets whether `%` is added on the left and right of each value. */
  match(left: boolean, right: boolean): this {
    this.#left = left;
    this.#right = right;
    return this;
  }

  build(_builder: Builder, params: Params): string {
    const col = quoteIdentifierPath(this.#col);
    const operator = this.#caseInsensitive
      ? this.#operator.replace("LIKE", "ILIKE")
      : this.#operator;
    const parts = this.#values.map((raw) => {
      let value = raw;
      for (let i = 0; i < this.#escape.length; i += 2) {
        value = value.replaceAll(
          this.#escape[i] as string,
          this.#escape[i + 1] as string,
        );
      }
      if (this.#left) value = `%${value}`;
      if (this.#right) value = `${value}%`;
      return `${col} ${operator} ${bindParam(params, value)}`;
    });
    return parts.join(this.#or ? " OR " : " AND ");
  }
}

class ExistsExp implements Expression {
  readonly #exp: Expression;
  readonly #not: boolean;

  constructor(exp: Expression, not: boolean) {
    this.#exp = exp;
    this.#not = not;
  }

  build(builder: Builder, params: Params): string {
    const sql = this.#exp.build(builder, params);
    if (sql === "") return this.#not ? "" : "0=1";
    return `${this.#not ? "NOT EXISTS" : "EXISTS"} (${sql})`;
  }
}

class BetweenExp implements Expression {
  readonly #col: string;
  readonly #from: unknown;
  readonly #to: unknown;
  readonly #not: boolean;

  constructor(col: string, from: unknown, to: unknown, not: boolean) {
    this.#col = col;
    this.#from = from;
    this.#to = to;
    this.#not = not;
  }

  build(_builder: Builder, params: Params): string {
    const from = bindParam(params, this.#from);
    const to = bindParam(params, this.#to);
    const between = this.#not ? "NOT BETWEEN" : "BETWEEN";
    return `${quoteIdentifierPath(this.#col)} ${between} ${from} AND ${to}`;
  }
}

/**
 * A raw SQL expression. It may contain `{:name}` placeholders, `{{table}}` and
 * `[[column]]`; `params` supplies the placeholder values.
 */
export function exp(sql: string, params?: Params): Expression {
  return new Exp(sql, params);
}

/**
 * Equality conditions joined by AND. A `null` value means `IS NULL`, an array
 * means `IN`, and an Expression is used as is. An `undefined` value throws.
 */
export function hash(values: Record<string, unknown>): Expression {
  return new HashExp(values);
}

/** `NOT (exp)`. Has no effect when `exp` is empty. */
export function not(exp: Expression): Expression {
  return new NotExp(exp);
}

/** Joins expressions with AND. Empty and missing expressions are skipped. */
export function and(...exps: (Expression | null | undefined)[]): Expression {
  return new AndOrExp(exps, "AND");
}

/** Joins expressions with OR. Empty and missing expressions are skipped. */
export function or(...exps: (Expression | null | undefined)[]): Expression {
  return new AndOrExp(exps, "OR");
}

/**
 * `col IN (...)`. With no values it matches nothing. A `null` value matches
 * NULL; an `undefined` value throws.
 */
export function isIn(col: string, ...values: unknown[]): Expression {
  return new InExp(col, values, false);
}

/**
 * `col NOT IN (...)`. With no values it has no effect. A `null` value also
 * excludes NULL; an `undefined` value throws.
 */
export function notIn(col: string, ...values: unknown[]): Expression {
  return new InExp(col, values, true);
}

/** `col LIKE '%value%'` for each value, joined by AND. */
export function like(col: string, ...values: string[]): LikeExp {
  return new LikeExp(col, values, "LIKE", false);
}

/** `col NOT LIKE '%value%'` for each value, joined by AND. */
export function notLike(col: string, ...values: string[]): LikeExp {
  return new LikeExp(col, values, "NOT LIKE", false);
}

/** `col LIKE '%value%'` for each value, joined by OR. */
export function orLike(col: string, ...values: string[]): LikeExp {
  return new LikeExp(col, values, "LIKE", true);
}

/** `col NOT LIKE '%value%'` for each value, joined by OR. */
export function orNotLike(col: string, ...values: string[]): LikeExp {
  return new LikeExp(col, values, "NOT LIKE", true);
}

/** `EXISTS (sub-query)`, such as `exists(exp("SELECT 1 FROM ..."))`. An empty sub-query matches nothing. */
export function exists(exp: Expression): Expression {
  return new ExistsExp(exp, false);
}

/** `NOT EXISTS (sub-query)`. An empty sub-query has no effect. */
export function notExists(exp: Expression): Expression {
  return new ExistsExp(exp, true);
}

/** `col BETWEEN from AND to`. Both ends are included. */
export function between(col: string, from: unknown, to: unknown): Expression {
  return new BetweenExp(col, from, to, false);
}

/** `col NOT BETWEEN from AND to`. */
export function notBetween(
  col: string,
  from: unknown,
  to: unknown,
): Expression {
  return new BetweenExp(col, from, to, true);
}
