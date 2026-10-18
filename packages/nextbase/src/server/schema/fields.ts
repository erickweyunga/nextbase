import type {
  EmailField,
  Field,
  FieldType,
  PasswordField,
} from "../../shared/schema.ts";
import { LOWER_ALPHANUMERIC, randomString } from "../random.ts";
import { type Issues, isRecord, type Path, Reader } from "./input.ts";

/** Collection, field and index names: safe to quote and within Postgres's 63-byte limit. */
export const NAME_PATTERN: RegExp = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;

const FIELD_ID_PATTERN = /^[a-z0-9]{10}$/;

// Names used by the record JSON, and Postgres system columns, which a table
// cannot have as column names. Compared lowercased.
const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set([
  "expand",
  "collectionid",
  "collectionname",
  "tableoid",
  "xmin",
  "cmin",
  "xmax",
  "cmax",
  "ctid",
  "oid",
]);

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const DEFAULT_TEXT_MAX = 5000;
const DEFAULT_FILE_MAX_SIZE = 5 * 1024 * 1024;
const DEFAULT_JSON_MAX_SIZE = 1024 * 1024;
export const DEFAULT_PASSWORD_MIN = 8;
export const DEFAULT_PASSWORD_MAX = 256;
const MAX_PASSWORD_LENGTH = 1024;
const MAX_SELECT_VALUE_LENGTH = 255;
const MAX_FILES_PER_FIELD = 100;

const FIELD_TYPES = [
  "text",
  "number",
  "bool",
  "email",
  "url",
  "date",
  "autodate",
  "select",
  "relation",
  "file",
  "json",
  "password",
] as const satisfies readonly FieldType[];

export interface FieldContext {
  /** Ids of the collections a relation may target, including its own. */
  collectionIds: ReadonlySet<string>;
  /** The field this one replaces, matched by id, when updating a collection. */
  existing?: Field | undefined;
}

/** Field types a user may add. `password` exists only as an auth system field. */
const USER_FIELD_TYPES: ReadonlySet<string> = new Set(
  FIELD_TYPES.filter((type) => type !== "password"),
);

/** Whether a field stores several values, as a Postgres array column. */
export function isMultiple(field: Field): boolean {
  return (
    (field.type === "select" ||
      field.type === "relation" ||
      field.type === "file") &&
    field.maxSelect > 1
  );
}

/** Records an issue if `name` is not a valid, unreserved field name. */
function checkFieldName(name: string, path: Path, issues: Issues): void {
  if (!NAME_PATTERN.test(name)) {
    issues.add(
      path,
      "validation_invalid_name",
      "Must start with a letter and contain only letters, digits and underscores, up to 63 characters.",
    );
  } else if (RESERVED_FIELD_NAMES.has(name.toLowerCase())) {
    issues.add(path, "validation_reserved_name", `"${name}" is reserved.`);
  }
}

/**
 * Validates an untrusted, non-system field definition and fills in defaults.
 * Returns undefined when the input is not a field at all; otherwise returns the
 * field, with any problems recorded in `issues`.
 */
export function parseField(
  input: unknown,
  path: Path,
  issues: Issues,
  context: FieldContext,
): Field | undefined {
  if (!isRecord(input)) {
    issues.add(path, "validation_invalid_type", "Must be an object.");
    return undefined;
  }
  const r = new Reader(input, path, issues);
  const { existing } = context;

  const type = r.string("type", "");
  if (!USER_FIELD_TYPES.has(type)) {
    r.fail(
      "type",
      "validation_invalid_value",
      `Must be one of: ${[...USER_FIELD_TYPES].join(", ")}.`,
    );
    return undefined;
  }
  if (existing && existing.type !== type) {
    r.fail(
      "type",
      "validation_type_change",
      "A field's type cannot change. Remove the field and add a new one instead.",
    );
    return undefined;
  }

  let id = r.string("id", "");
  if (id === "") {
    id = randomString(10, LOWER_ALPHANUMERIC);
  } else if (!existing && !FIELD_ID_PATTERN.test(id)) {
    r.fail(
      "id",
      "validation_invalid_value",
      "Must be 10 lowercase letters or digits.",
    );
  }

  const name = r.string("name", "");
  checkFieldName(name, [...path, "name"], issues);

  const base = {
    id,
    name,
    system: false,
    required: r.boolean("required", false),
    hidden: r.boolean("hidden", false),
  };

  switch (type as Exclude<FieldType, "password">) {
    case "text": {
      const min = r.integer("min", 0, 0, MAX_SAFE);
      const max = r.integer("max", DEFAULT_TEXT_MAX, 1, MAX_SAFE);
      if (min > max)
        r.fail("min", "validation_out_of_range", "Must not exceed max.");
      const pattern = r.string("pattern", "");
      if (pattern !== "") checkPattern(pattern, r);
      return { ...base, type: "text", min, max, pattern, primaryKey: false };
    }
    case "number": {
      const min = r.numberOrNull("min", null);
      const max = r.numberOrNull("max", null);
      if (min !== null && max !== null && min > max) {
        r.fail("min", "validation_out_of_range", "Must not exceed max.");
      }
      return {
        ...base,
        type: "number",
        min,
        max,
        onlyInt: r.boolean("onlyInt", false),
      };
    }
    case "bool":
      return { ...base, type: "bool" };
    case "email":
      return { ...base, type: "email", ...parseDomains(r) };
    case "url":
      return { ...base, type: "url", ...parseDomains(r) };
    case "date": {
      const min = parseTimestamp(r, "min");
      const max = parseTimestamp(r, "max");
      if (min !== "" && max !== "" && min > max) {
        r.fail("min", "validation_out_of_range", "Must not be after max.");
      }
      return { ...base, type: "date", min, max };
    }
    case "autodate": {
      const onCreate = r.boolean("onCreate", true);
      const onUpdate = r.boolean("onUpdate", false);
      if (!onCreate && !onUpdate) {
        r.fail(
          "onCreate",
          "validation_required",
          "Set onCreate, onUpdate or both.",
        );
      }
      // The server sets the value, so a client can never leave it blank.
      return { ...base, required: false, type: "autodate", onCreate, onUpdate };
    }
    case "select": {
      const values = parseSelectValues(r);
      const maxSelect = r.integer(
        "maxSelect",
        1,
        1,
        Math.max(values.length, 1),
      );
      return { ...base, type: "select", values, maxSelect };
    }
    case "relation": {
      const collectionId = r.string("collectionId", "");
      if (!context.collectionIds.has(collectionId)) {
        r.fail(
          "collectionId",
          "validation_invalid_value",
          "Must be the id of an existing collection.",
        );
      } else if (
        existing?.type === "relation" &&
        existing.collectionId !== collectionId
      ) {
        r.fail(
          "collectionId",
          "validation_type_change",
          "A relation's collection cannot change. Remove the field and add a new one instead.",
        );
      }
      return {
        ...base,
        type: "relation",
        collectionId,
        maxSelect: r.integer("maxSelect", 1, 1, MAX_SAFE),
        cascadeDelete: r.boolean("cascadeDelete", false),
      };
    }
    case "file": {
      const mimeTypes = r.strings("mimeTypes", []);
      mimeTypes.forEach((mime, i) => {
        if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime)) {
          issues.add(
            [...path, "mimeTypes", i],
            "validation_invalid_value",
            "Must be a MIME type such as image/png.",
          );
        }
      });
      return {
        ...base,
        type: "file",
        maxSelect: r.integer("maxSelect", 1, 1, MAX_FILES_PER_FIELD),
        maxSize: r.integer("maxSize", DEFAULT_FILE_MAX_SIZE, 1, MAX_SAFE),
        mimeTypes,
        protected: r.boolean("protected", false),
      };
    }
    case "json":
      return {
        ...base,
        type: "json",
        maxSize: r.integer("maxSize", DEFAULT_JSON_MAX_SIZE, 1, MAX_SAFE),
      };
  }
}

/** Reads the editable options of the auth `password` system field. */
export function parsePasswordOptions(
  r: Reader,
  field: PasswordField,
): PasswordField {
  const min = r.integer("min", field.min, 1, MAX_PASSWORD_LENGTH);
  const max = r.integer("max", field.max, 1, MAX_PASSWORD_LENGTH);
  if (min > max)
    r.fail("min", "validation_out_of_range", "Must not exceed max.");
  return { ...field, min, max };
}

/** Reads the editable options of the auth `email` system field. */
export function parseEmailOptions(r: Reader, field: EmailField): EmailField {
  return {
    ...field,
    required: r.boolean("required", field.required),
    ...parseDomains(r, field),
  };
}

function checkPattern(pattern: string, r: Reader): void {
  try {
    new RegExp(pattern, "u");
  } catch {
    r.fail(
      "pattern",
      "validation_invalid_value",
      "Must be a valid regular expression.",
    );
  }
}

function parseDomains(
  r: Reader,
  fallback?: { onlyDomains: string[]; exceptDomains: string[] },
): { onlyDomains: string[]; exceptDomains: string[] } {
  const read = (key: "onlyDomains" | "exceptDomains"): string[] => {
    const domains = r
      .strings(key, fallback?.[key] ?? [])
      .map((d) => d.toLowerCase());
    domains.forEach((domain, i) => {
      if (
        !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
          domain,
        )
      ) {
        r.issues.add(
          [...r.path, key, i],
          "validation_invalid_value",
          "Must be a domain such as example.com.",
        );
      }
    });
    return domains;
  };
  const onlyDomains = read("onlyDomains");
  const exceptDomains = read("exceptDomains");
  if (onlyDomains.length > 0 && exceptDomains.length > 0) {
    r.fail(
      "exceptDomains",
      "validation_invalid_value",
      "Set onlyDomains or exceptDomains, not both.",
    );
  }
  return { onlyDomains, exceptDomains };
}

// Normalizes to the ISO form Postgres and the API both use, so bounds compare as strings.
function parseTimestamp(r: Reader, key: "min" | "max"): string {
  const value = r.string(key, "");
  if (value === "") return "";
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    r.fail(
      key,
      "validation_invalid_value",
      "Must be an ISO 8601 date, or empty.",
    );
    return "";
  }
  return new Date(time).toISOString();
}

function parseSelectValues(r: Reader): string[] {
  const values = r.strings("values", []);
  if (values.length === 0) {
    r.fail("values", "validation_required", "Add at least one value.");
  }
  const seen = new Set<string>();
  values.forEach((value, i) => {
    const path = [...r.path, "values", i];
    if (value === "" || value.length > MAX_SELECT_VALUE_LENGTH) {
      r.issues.add(
        path,
        "validation_invalid_value",
        `Must be 1 to ${MAX_SELECT_VALUE_LENGTH} characters.`,
      );
    } else if (seen.has(value)) {
      r.issues.add(path, "validation_not_unique", "Values must be unique.");
    }
    seen.add(value);
  });
  return values;
}
