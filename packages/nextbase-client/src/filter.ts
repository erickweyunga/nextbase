/** A value `filter()` can place into an expression. */
export type FilterValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | Date
  | readonly unknown[]
  | Record<string, unknown>;

const PLACEHOLDER = /\{:(\w+)\}/g;

/**
 * Builds a filter expression, replacing each `{:name}` with `params.name` as
 * a safely quoted literal: `filter("title ~ {:q}", { q })`. Strings and dates
 * become quoted strings, numbers decimals, booleans and nullish values the
 * literals `true`, `false` and `null`, and other objects quoted JSON.
 */
export function filter(
  expression: string,
  params: Readonly<Record<string, FilterValue>> = {},
): string {
  return expression.replace(PLACEHOLDER, (_, name: string) => {
    if (!Object.hasOwn(params, name)) {
      throw new Error(`filter(): no value for {:${name}}.`);
    }
    return literal(params[name], name);
  });
}

function literal(value: FilterValue, name: string): string {
  if (value === null || value === undefined) return "null";
  switch (typeof value) {
    case "string":
      return quote(value);
    case "boolean":
      return String(value);
    case "bigint":
      return value.toString();
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`filter(): {:${name}} is not a finite number.`);
      }
      return decimal(value);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`filter(): {:${name}} is an invalid date.`);
    }
    return quote(value.toISOString());
  }
  return quote(JSON.stringify(value));
}

/** A string literal: a backslash escapes the next character. */
function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** A number in plain decimal notation, since filters have no exponent syntax. */
function decimal(value: number): string {
  if (Object.is(value, -0)) return "0";
  const text = String(value);
  const match = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!match) return text;
  const [, sign, lead, rest = "", exponent] = match as unknown as string[];
  const digits = lead + rest;
  // Position of the decimal point within `digits`.
  const point = 1 + Number(exponent);
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  return `${sign}${digits.padEnd(point, "0")}`;
}
