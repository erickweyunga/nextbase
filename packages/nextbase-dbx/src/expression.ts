import type { Builder } from "./builder.ts";
import type { Params } from "./query.ts";
import { bindParam, mergeParams, quoteIdentifierPath } from "./sql.ts";

/**
 * A SQL fragment for a condition or a written value. `build` adds its values to
 * `params` and returns "" when it has no effect, so callers skip it. As a
 * condition, "" restricts nothing: it is true for every row.
 */
export interface Expression {
  build(builder: Builder, params: Params): string;
}

/** Values with a `build` method are used as SQL instead of bound. */
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
        // Skipping it would widen the condition, e.g. delete every row.
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

  // An empty condition is true, so its negation matches nothing.
  build(builder: Builder, params: Params): string {
    const sql = this.#exp.build(builder, params);
    return sql === "" ? "0=1" : `NOT (${sql})`;
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

  // Missing expressions are left out. An empty one is true, so it adds nothing
  // to AND and makes OR true as a whole.
  build(builder: Builder, params: Params): string {
    const parts: string[] = [];
    let alwaysTrue = false;
    for (const exp of this.#exps) {
      if (!exp) continue;
      const sql = exp.build(builder, params);
      if (sql !== "") parts.push(sql);
      else alwaysTrue = true;
    }
    if (alwaysTrue && this.#op === "OR") return "";
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

  // `= NULL` never matches, so null becomes an explicit IS [NOT] NULL test. An
  // Expression value gets its own IN (...), so it may be a sub-query, and one
  // that is empty is left out.
  build(builder: Builder, params: Params): string {
    const col = quoteIdentifierPath(this.#col);
    let hasNull = false;
    const values: string[] = [];
    const expressions: string[] = [];
    for (const value of this.#values) {
      if (value === undefined) {
        throw new TypeError(`dbx: IN value for "${this.#col}" is undefined.`);
      }
      if (value === null) {
        hasNull = true;
      } else if (isExpression(value)) {
        const sql = value.build(builder, params);
        if (sql !== "") expressions.push(sql);
      } else {
        values.push(bindParam(params, value));
      }
    }
    if (!hasNull && values.length === 0 && expressions.length === 0) {
      return this.#not ? "" : "0=1";
    }

    const parts: string[] = [];
    if (values.length === 1) {
      parts.push(`${col}${this.#not ? "<>" : "="}${values[0]}`);
    } else if (values.length > 1) {
      parts.push(
        `${col} ${this.#not ? "NOT IN" : "IN"} (${values.join(", ")})`,
      );
    }
    for (const sql of expressions) {
      parts.push(`${col} ${this.#not ? "NOT IN" : "IN"} (${sql})`);
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
 * By default each value is escaped and wrapped in `%`, matching a literal
 * substring; `escape()` and `match()` change that.
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

  /** Replacement pairs `(from, to, ...)`; none matches values as raw patterns. */
  escape(...chars: string[]): this {
    if (chars.length % 2 !== 0) {
      throw new TypeError(
        "dbx: LikeExp.escape needs an even number of strings.",
      );
    }
    this.#escape = chars;
    return this;
  }

  /** Uses `ILIKE`. */
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

/** Raw SQL with `{:name}`, `{{table}}` and `[[column]]`; `params` binds the values. */
export function exp(sql: string, params?: Params): Expression {
  return new Exp(sql, params);
}

/**
 * Equality conditions joined by AND: `null` is IS NULL, an array is IN, an
 * Expression is used as is. `undefined` throws.
 */
export function hash(values: Record<string, unknown>): Expression {
  return new HashExp(values);
}

/** `NOT (exp)`. Matches nothing when `exp` is empty, since that matches everything. */
export function not(exp: Expression): Expression {
  return new NotExp(exp);
}

/** Joins expressions with AND. Empty and missing expressions are skipped. */
export function and(...exps: (Expression | null | undefined)[]): Expression {
  return new AndOrExp(exps, "AND");
}

/**
 * Joins expressions with OR. Missing expressions are skipped; an empty one
 * matches everything, so the whole OR is empty.
 */
export function or(...exps: (Expression | null | undefined)[]): Expression {
  return new AndOrExp(exps, "OR");
}

/**
 * With no values it matches nothing. `null` matches NULL; an Expression is
 * written as `col IN (sql)`, so it may be a sub-query; `undefined` throws.
 */
export function isIn(col: string, ...values: unknown[]): Expression {
  return new InExp(col, values, false);
}

/**
 * With no values it has no effect. `null` excludes NULL; an Expression is
 * written as `col NOT IN (sql)`; `undefined` throws.
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

/** An empty sub-query matches nothing. */
export function exists(exp: Expression): Expression {
  return new ExistsExp(exp, false);
}

/** An empty sub-query has no effect. */
export function notExists(exp: Expression): Expression {
  return new ExistsExp(exp, true);
}

/** Both ends are included. */
export function between(col: string, from: unknown, to: unknown): Expression {
  return new BetweenExp(col, from, to, false);
}

export function notBetween(
  col: string,
  from: unknown,
  to: unknown,
): Expression {
  return new BetweenExp(col, from, to, true);
}
