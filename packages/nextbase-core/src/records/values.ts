import type { Collection, Field } from "@nextbasejs/client";
import type { Builder, Row } from "@nextbasejs/dbx";
import { hashPassword } from "../auth/password.ts";
import { table } from "../db/system.ts";
import { ApiError } from "../errors.ts";
import { ALPHANUMERIC, LOWER_ALPHANUMERIC, randomString } from "../random.ts";
import type { Schema } from "../schema/cache.ts";
import { isMultiple } from "../schema/fields.ts";
import { Issues } from "../schema/input.ts";
import { hasNul, isStorableTime } from "../storable.ts";

const ID_PATTERN = /^[a-z0-9]{15}$/;
/** A plausible email address: something, @, a domain with a dot. */
export const EMAIL_PATTERN: RegExp = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVALID = Symbol("invalid");

export interface WriteOptions {
  collection: Collection;
  schema: Schema;
  /** The stored row, when updating. */
  existing?: Row | undefined;
  /** Superusers, and callers passing an auth collection's manageRule, may change protected auth fields. */
  privileged: boolean;
}

export interface PreparedWrite {
  /** Column values to write: every column on create, changed columns on update. */
  values: Record<string, unknown>;
  /** The full row after the write, for checking the create rule before inserting. */
  row: Record<string, unknown>;
  /** The submitted values, normalized, for `@request.body.*` in rules. */
  body: Record<string, unknown>;
  /**
   * The `oldPassword` a password change must be checked against. Checked by
   * the caller after the update rule passed, through the login throttle, so
   * someone the rule rejects can neither guess it nor lock the account.
   */
  oldPassword?: string;
}

/**
 * Normalizes and validates submitted values against the collection's fields,
 * applying `field+`, `+field` and `field-` modifiers. Unknown keys are ignored.
 * Throws a 400 listing every problem.
 */
export async function prepareWrite(
  q: Builder,
  input: Record<string, unknown>,
  options: WriteOptions,
): Promise<PreparedWrite> {
  const { collection, existing, privileged } = options;
  const creating = existing === undefined;
  const issues = new Issues();
  const row: Record<string, unknown> = creating
    ? blankRow(collection)
    : { ...existing };
  const values: Record<string, unknown> = {};
  const body: Record<string, unknown> = {};
  let oldPassword: string | undefined;
  const set = (field: Field, value: unknown): void => {
    row[field.name] = value;
    values[field.name] = value;
    body[field.name] = value;
  };

  for (const field of collection.fields) {
    const { name } = field;
    if (field.type === "autodate") {
      if (creating ? field.onCreate : field.onUpdate) {
        row[name] = values[name] = new Date();
      }
      continue;
    }
    if (field.type === "password") {
      oldPassword = preparePassword(
        input,
        field,
        existing,
        privileged,
        issues,
        set,
      );
      continue;
    }
    if (field.type === "text" && field.primaryKey) {
      const id = input.id;
      if (!creating) {
        if (id !== undefined && id !== existing?.id)
          issues.add(
            ["id"],
            "validation_immutable",
            "A record's id cannot change.",
          );
      } else if (id === undefined || id === "") {
        row.id = values.id = randomString(15, LOWER_ALPHANUMERIC);
      } else if (typeof id !== "string" || !ID_PATTERN.test(id)) {
        issues.add(
          ["id"],
          "validation_invalid_value",
          "Must be 15 lowercase letters or digits.",
        );
      } else {
        row.id = values.id = id;
      }
      continue;
    }
    if (field.system && field.name === "tokenKey") {
      if (creating) row[name] = values[name] = randomString(50, ALPHANUMERIC);
      continue;
    }
    if (field.type === "file") {
      if (
        [name, `${name}+`, `+${name}`, `${name}-`].some(
          (k) => input[k] !== undefined,
        )
      ) {
        issues.add(
          [name],
          "validation_unsupported",
          "File uploads are not supported yet.",
        );
      }
      continue;
    }

    let value: unknown = INVALID;
    let changed = false;
    if (Object.hasOwn(input, name) && input[name] !== undefined) {
      value = normalize(field, input[name], issues);
      changed = true;
    }
    for (const [key, apply] of modifierKeys(field)) {
      if (!Object.hasOwn(input, key) || input[key] === undefined) continue;
      const current = changed ? value : row[name];
      if (current === INVALID) break;
      const problem = unstorable(input[key]);
      if (problem) {
        issues.add([name], "validation_invalid_value", problem);
        value = INVALID;
        break;
      }
      value = apply(current, input[key], issues);
      changed = true;
    }
    if (!changed || value === INVALID) continue;
    if (validate(field, value, issues)) {
      // Auth fields that only privileged callers may change directly.
      if (
        collection.type === "auth" &&
        field.system &&
        (name === "email" || name === "verified")
      ) {
        const unchanged = creating
          ? name === "email" || value === false
          : value === row[name];
        if (!privileged && !unchanged) {
          issues.add(
            [name],
            "validation_forbidden",
            name === "email"
              ? "Only superusers can change emails directly."
              : "Only superusers can verify records.",
          );
          continue;
        }
        if (name === "email" && !creating && value !== row[name]) {
          row.tokenKey = values.tokenKey = randomString(50, ALPHANUMERIC);
        }
      }
      set(field, value);
    }
  }

  for (const field of collection.fields) {
    if (
      !field.required ||
      field.type === "autodate" ||
      (field.type === "text" && field.primaryKey)
    )
      continue;
    if (
      field.type === "password"
        ? creating && isBlank(row[field.name])
        : isBlank(row[field.name])
    ) {
      issues.add([field.name], "validation_required", "Cannot be blank.");
    }
  }
  // Rules see what was submitted, never secrets derived from it.
  delete body.password;
  delete body.tokenKey;
  await checkRelations(q, options.schema, collection, values, issues);
  if (!issues.empty) {
    throw new ApiError(
      400,
      creating
        ? "Failed to create the record."
        : "Failed to update the record.",
      issues.data,
    );
  }
  // Hashed once the write is known to be valid.
  const password = collection.fields.find((f) => f.type === "password");
  if (password && typeof values[password.name] === "string") {
    row[password.name] = values[password.name] = await hashPassword(
      values[password.name] as string,
    );
  }
  return {
    values,
    row,
    body,
    ...(oldPassword !== undefined && { oldPassword }),
  };
}

/** The value a column holds when nothing was written to it. */
function blankValue(field: Field): unknown {
  if (isMultiple(field)) return [];
  switch (field.type) {
    case "number":
      return 0;
    case "bool":
      return false;
    case "date":
    case "json":
    case "relation":
      return null;
    default:
      return "";
  }
}

function blankRow(collection: Collection): Record<string, unknown> {
  return Object.fromEntries(
    collection.fields.map((f) => [f.name, blankValue(f)]),
  );
}

function isBlank(value: unknown): boolean {
  return (
    value === null ||
    value === "" ||
    value === 0 ||
    value === false ||
    (Array.isArray(value) && value.length === 0)
  );
}

type Modifier = (current: unknown, operand: unknown, issues: Issues) => unknown;

function modifierKeys(field: Field): [string, Modifier][] {
  const { name } = field;
  const fail = (issues: Issues, message: string): typeof INVALID => {
    issues.add([name], "validation_invalid_value", message);
    return INVALID;
  };
  if (field.type === "number") {
    const step =
      (sign: number): Modifier =>
      (current, operand, issues) =>
        typeof operand === "number" && Number.isFinite(operand)
          ? (current as number) + sign * operand
          : fail(issues, "Must be a number.");
    return [
      [`${name}+`, step(1)],
      [`${name}-`, step(-1)],
    ];
  }
  if (!isMultiple(field)) return [];
  const list = (
    operand: unknown,
    issues: Issues,
  ): string[] | typeof INVALID => {
    const items = Array.isArray(operand) ? operand : [operand];
    return items.every((v) => typeof v === "string")
      ? (items as string[])
      : fail(issues, "Must be a string or an array of strings.");
  };
  return [
    [
      `+${name}`,
      (current, operand, issues) => {
        const items = list(operand, issues);
        return items === INVALID ? items : [...items, ...(current as string[])];
      },
    ],
    [
      `${name}+`,
      (current, operand, issues) => {
        const items = list(operand, issues);
        return items === INVALID ? items : [...(current as string[]), ...items];
      },
    ],
    [
      `${name}-`,
      (current, operand, issues) => {
        const items = list(operand, issues);
        return items === INVALID
          ? items
          : (current as string[]).filter((v) => !items.includes(v));
      },
    ],
  ];
}

/** Converts submitted JSON to the column's value, or records an issue. */
function normalize(field: Field, raw: unknown, issues: Issues): unknown {
  const fail = (message: string): typeof INVALID => {
    issues.add([field.name], "validation_invalid_type", message);
    return INVALID;
  };
  const problem = unstorable(raw);
  if (problem) {
    issues.add([field.name], "validation_invalid_value", problem);
    return INVALID;
  }
  if (isMultiple(field)) {
    if (raw === null || raw === "") return [];
    const items = Array.isArray(raw) ? raw : [raw];
    return items.every((v) => typeof v === "string")
      ? items
      : fail("Must be an array of strings.");
  }
  switch (field.type) {
    case "text":
    case "email":
    case "url":
    case "select":
      if (raw === null) return "";
      if (typeof raw === "string")
        return field.type === "email" ? raw.trim() : raw;
      if (
        field.type === "text" &&
        (typeof raw === "number" || typeof raw === "boolean")
      )
        return String(raw);
      return fail("Must be a string.");
    case "relation":
      if (raw === null || raw === "") return null;
      return typeof raw === "string" ? raw : fail("Must be a record id.");
    case "number":
      if (raw === null || raw === "") return 0;
      if (typeof raw === "number" && Number.isFinite(raw)) return raw;
      if (
        typeof raw === "string" &&
        raw.trim() !== "" &&
        Number.isFinite(Number(raw))
      )
        return Number(raw);
      return fail("Must be a number.");
    case "bool":
      if (raw === null) return false;
      if (typeof raw === "boolean") return raw;
      if (raw === "true" || raw === "1") return true;
      if (raw === "false" || raw === "0" || raw === "") return false;
      return fail("Must be a boolean.");
    case "date": {
      if (raw === null || raw === "") return null;
      const time = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
      return isStorableTime(time)
        ? new Date(time)
        : fail("Must be an ISO 8601 date from 4713 BC to 275760 AD.");
    }
    case "json":
      return raw;
    default:
      return fail("Cannot be set.");
  }
}

const MAX_JSON_DEPTH = 64;

/**
 * What would make Postgres reject a submitted value: a NUL character in any
 * string or key, or JSON nested deeper than it can process. Walked with an
 * explicit stack, so hostile nesting cannot overflow the call stack.
 */
function unstorable(value: unknown): string | undefined {
  const stack: [unknown, number][] = [[value, 0]];
  for (let next = stack.pop(); next; next = stack.pop()) {
    const [item, depth] = next;
    if (typeof item === "string") {
      if (hasNul(item)) return "Cannot contain NUL characters.";
    } else if (typeof item === "object" && item !== null) {
      if (depth >= MAX_JSON_DEPTH)
        return `Cannot be nested more than ${MAX_JSON_DEPTH} levels deep.`;
      for (const [key, child] of Object.entries(item)) {
        if (hasNul(key)) return "Cannot contain NUL characters.";
        stack.push([child, depth + 1]);
      }
    }
  }
  return undefined;
}

/** Checks a normalized value against the field's options. */
function validate(field: Field, value: unknown, issues: Issues): boolean {
  const fail = (code: string, message: string): false => {
    issues.add([field.name], code, message);
    return false;
  };
  switch (field.type) {
    case "text": {
      const text = value as string;
      if (text === "") return true;
      const length = [...text].length;
      if (length < field.min || length > field.max) {
        return fail(
          "validation_length_out_of_range",
          `Must be ${field.min} to ${field.max} characters.`,
        );
      }
      if (field.pattern !== "" && !new RegExp(field.pattern, "u").test(text)) {
        return fail(
          "validation_invalid_format",
          "Does not match the required format.",
        );
      }
      return true;
    }
    case "email":
    case "url": {
      const text = value as string;
      if (text === "") return true;
      let domain: string;
      if (field.type === "email") {
        if (text.length > 254 || !EMAIL_PATTERN.test(text))
          return fail(
            "validation_invalid_email",
            "Must be a valid email address.",
          );
        domain = text.slice(text.lastIndexOf("@") + 1).toLowerCase();
      } else {
        let url: URL;
        try {
          url = new URL(text);
        } catch {
          return fail("validation_invalid_url", "Must be a valid URL.");
        }
        if (url.protocol !== "http:" && url.protocol !== "https:")
          return fail(
            "validation_invalid_url",
            "Must be an http or https URL.",
          );
        domain = url.hostname.toLowerCase();
      }
      if (field.onlyDomains.length > 0 && !field.onlyDomains.includes(domain)) {
        return fail(
          "validation_domain_not_allowed",
          `Must use one of: ${field.onlyDomains.join(", ")}.`,
        );
      }
      if (field.exceptDomains.includes(domain))
        return fail(
          "validation_domain_not_allowed",
          "This domain is not allowed.",
        );
      return true;
    }
    case "number": {
      const n = value as number;
      if (field.onlyInt && !Number.isInteger(n))
        return fail("validation_not_integer", "Must be an integer.");
      if (
        (field.min !== null && n < field.min) ||
        (field.max !== null && n > field.max)
      ) {
        return fail(
          "validation_out_of_range",
          `Must be between ${field.min ?? "-∞"} and ${field.max ?? "∞"}.`,
        );
      }
      return true;
    }
    case "date": {
      const date = value as Date | null;
      if (date === null) return true;
      const iso = date.toISOString();
      if (
        (field.min !== "" && iso < field.min) ||
        (field.max !== "" && iso > field.max)
      ) {
        return fail(
          "validation_out_of_range",
          "The date is out of the allowed range.",
        );
      }
      return true;
    }
    case "select": {
      const items = isMultiple(field)
        ? (value as string[])
        : value === ""
          ? []
          : [value as string];
      if (items.some((v) => !field.values.includes(v)))
        return fail(
          "validation_invalid_value",
          `Must be one of: ${field.values.join(", ")}.`,
        );
      return checkList(field.maxSelect, items, fail);
    }
    case "relation": {
      const items = isMultiple(field)
        ? (value as string[])
        : value === null
          ? []
          : [value as string];
      if (items.some((v) => !ID_PATTERN.test(v)))
        return fail("validation_invalid_value", "Must be record ids.");
      return checkList(field.maxSelect, items, fail);
    }
    case "json": {
      const size = new TextEncoder().encode(JSON.stringify(value)).length;
      if (size > field.maxSize)
        return fail(
          "validation_too_large",
          `Must be at most ${field.maxSize} bytes of JSON.`,
        );
      return true;
    }
    default:
      return true;
  }
}

function checkList(
  maxSelect: number,
  items: string[],
  fail: (code: string, message: string) => false,
): boolean {
  if (new Set(items).size !== items.length)
    return fail("validation_not_unique", "Values must be unique.");
  if (items.length > maxSelect)
    return fail("validation_too_many", `Select at most ${maxSelect}.`);
  return true;
}

/**
 * Validates a new password and stages its hash. Returns the oldPassword the
 * change must still be checked against, when the caller needs one.
 */
function preparePassword(
  input: Record<string, unknown>,
  field: Field & { type: "password" },
  existing: Row | undefined,
  privileged: boolean,
  issues: Issues,
  set: (field: Field, value: unknown) => void,
): string | undefined {
  const { password, passwordConfirm, oldPassword } = input;
  if (password === undefined) return undefined;
  // NIST SP 800-63B: each Unicode code point counts as one character.
  const length = typeof password === "string" ? [...password].length : 0;
  if (
    typeof password !== "string" ||
    length < field.min ||
    length > field.max
  ) {
    issues.add(
      ["password"],
      "validation_length_out_of_range",
      `Must be ${field.min} to ${field.max} characters.`,
    );
    return undefined;
  }
  if (passwordConfirm !== password) {
    issues.add(
      ["passwordConfirm"],
      "validation_values_mismatch",
      "Does not match the password.",
    );
    return undefined;
  }
  let check: string | undefined;
  if (existing && !privileged) {
    if (typeof oldPassword !== "string") {
      issues.add(
        ["oldPassword"],
        "validation_invalid_old_password",
        "Does not match the current password.",
      );
      return undefined;
    }
    check = oldPassword;
  }
  set(field, password);
  // A new password signs everyone out: all earlier tokens stop verifying.
  if (existing)
    set({ ...field, name: "tokenKey" }, randomString(50, ALPHANUMERIC));
  return check;
}

/**
 * Checks that referenced records exist, and locks them against deletion until
 * the transaction ends, so a concurrent delete cannot leave this write
 * pointing at nothing.
 */
async function checkRelations(
  q: Builder,
  schema: Schema,
  collection: Collection,
  values: Record<string, unknown>,
  issues: Issues,
): Promise<void> {
  for (const field of collection.fields) {
    if (field.type !== "relation" || !Object.hasOwn(values, field.name))
      continue;
    const value = values[field.name];
    const ids = Array.isArray(value)
      ? (value as string[])
      : value === null
        ? []
        : [value as string];
    if (ids.length === 0) continue;
    const target = schema.find(field.collectionId);
    if (!target) continue;
    const found = await q
      .newQuery(
        `SELECT id FROM {{${table(target.name)}}} WHERE id = ANY({:ids}) FOR KEY SHARE`,
      )
      .bind({ ids })
      .column<string>();
    const missing = ids.filter((id) => !found.includes(id));
    if (missing.length > 0) {
      issues.add(
        [field.name],
        "validation_missing_relation",
        `No ${target.name} record with id ${missing.join(", ")}.`,
      );
    }
  }
}
