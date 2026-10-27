import type { Params } from "./query.ts";

export type TokenKind = "param" | "table" | "column";

// `{:name}`, `{{table}}` and `[[column]]`, matched at one position.
const TOKEN = /\{:(\w+)\}|\{\{([\w\-. ]+)\}\}|\[\[([\w\-. ]+)\]\]/y;
// A dollar-quote delimiter such as `$$` or `$body$`.
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/y;
const IDENTIFIER_CHAR = /[\w$\u0080-￿]/;

/**
 * Replaces `{:name}`, `{{table}}` and `[[column]]` tokens via `replace`. Literals,
 * quoted identifiers, dollar-quoted strings and comments are copied untouched.
 * `$1` is rejected since it would collide with the generated numbers.
 */
export function rewriteSQL(
  sql: string,
  replace: (kind: TokenKind, name: string, token: string) => string,
): string {
  let out = "";
  let copied = 0;
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    const inIdentifier = i > 0 && IDENTIFIER_CHAR.test(sql[i - 1] as string);
    if (char === "'") {
      // E'...' strings use backslash escapes.
      const escapes =
        i > 0 &&
        (sql[i - 1] === "E" || sql[i - 1] === "e") &&
        !(i > 1 && IDENTIFIER_CHAR.test(sql[i - 2] as string));
      i = skipQuoted(sql, i, "'", escapes);
    } else if (char === '"') {
      i = skipQuoted(sql, i, '"', false);
    } else if (char === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
    } else if (char === "/" && sql[i + 1] === "*") {
      i = skipBlockComment(sql, i);
    } else if (char === "$" && !inIdentifier) {
      DOLLAR_TAG.lastIndex = i;
      const tag = DOLLAR_TAG.exec(sql)?.[0];
      if (tag !== undefined) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? sql.length : end + tag.length;
      } else if (/\d/.test(sql[i + 1] ?? "")) {
        throw new SyntaxError(
          "dbx: positional parameters such as $1 are not supported; use {:name}.",
        );
      } else {
        i++;
      }
    } else if (char === "{" || char === "[") {
      TOKEN.lastIndex = i;
      const match = TOKEN.exec(sql);
      if (match) {
        const [token, param, table, column] = match;
        const result =
          param !== undefined
            ? replace("param", param, token)
            : table !== undefined
              ? replace("table", table, token)
              : replace("column", column as string, token);
        out += sql.slice(copied, i) + result;
        i += token.length;
        copied = i;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }
  return out + sql.slice(copied);
}

// Returns the index after the closing quote, honoring doubled quotes.
function skipQuoted(
  sql: string,
  start: number,
  quote: string,
  escapes: boolean,
): number {
  let i = start + 1;
  while (i < sql.length) {
    const char = sql[i];
    if (escapes && char === "\\") {
      i += 2;
    } else if (char === quote) {
      if (sql[i + 1] !== quote) return i + 1;
      i += 2;
    } else {
      i++;
    }
  }
  return sql.length;
}

// Postgres block comments nest.
function skipBlockComment(sql: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < sql.length) {
    if (sql[i] === "/" && sql[i + 1] === "*") {
      depth++;
      i += 2;
    } else if (sql[i] === "*" && sql[i + 1] === "/") {
      depth--;
      i += 2;
      if (depth === 0) return i;
    } else {
      i++;
    }
  }
  return sql.length;
}

/** Quotes one identifier, always. Safe for any input. */
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Quotes each part of a dotted path such as `schema.table`, always. */
export function quoteIdentifierPath(name: string): string {
  return name.split(".").map(quoteIdentifier).join(".");
}

// Next free `pN` per params object, so binding many values stays linear.
const nextIndex = new WeakMap<Params, number>();

function freshName(params: Params): string {
  let i = nextIndex.get(params) ?? Object.keys(params).length;
  while (Object.hasOwn(params, `p${i}`)) i++;
  nextIndex.set(params, i + 1);
  return `p${i}`;
}

/** Adds `value` to `params` under a fresh name and returns its placeholder. */
export function bindParam(params: Params, value: unknown): string {
  const name = freshName(params);
  params[name] = value;
  return `{:${name}}`;
}

/**
 * Merges fragment params `own` into `params`, renaming names already bound to a
 * different value (e.g. UNION parts). Returns `sql` with renamed placeholders.
 */
export function mergeParams(sql: string, own: Params, params: Params): string {
  const renames = new Map<string, string>();
  for (const [name, value] of Object.entries(own)) {
    if (!Object.hasOwn(params, name) || Object.is(params[name], value)) {
      params[name] = value;
      continue;
    }
    const fresh = freshName(params);
    params[fresh] = value;
    renames.set(name, fresh);
  }
  if (renames.size === 0) return sql;
  return rewriteSQL(sql, (kind, name, token) => {
    const fresh = kind === "param" ? renames.get(name) : undefined;
    return fresh === undefined ? token : `{:${fresh}}`;
  });
}
