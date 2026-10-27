import type { Collection } from "@nextbasejs/client";
import type { Row, TypeParsers } from "@nextbasejs/dbx";
import pg from "pg";
import { parseTimestamptz } from "../storable.ts";

const TIMESTAMPTZ_OID = 1184;
const FLOAT8_OID = 701;

// Overrides timestamptz, which node-postgres misreads for historical and
// far-future dates. Scoped to NextBase's DB, not the host app's pg.
export const TYPES: TypeParsers = {
  getTypeParser(oid: number, format?: string): unknown {
    if (oid === TIMESTAMPTZ_OID && format !== "binary") {
      const fallback = pg.types.getTypeParser(oid, "text") as (
        text: string,
      ) => unknown;
      return (text: string) => parseTimestamptz(text) ?? fallback(text);
    }
    return pg.types.getTypeParser(oid, (format ?? "text") as "text");
  },
};

type TextParser = (text: string) => unknown;
const parseTimestamp = TYPES.getTypeParser(TIMESTAMPTZ_OID) as TextParser;
const parseFloat8 = TYPES.getTypeParser(FLOAT8_OID) as TextParser;

/**
 * Turns a record read with `to_json(row)` into the same object a normal
 * select returns. JSON already keeps the columns in order and most values
 * as they are. Two kinds differ: timestamps arrive as strings such as
 * `2026-01-02T03:04:05+00:00`, and NaN or Infinity as strings such as
 * `"NaN"`. Those are parsed with the same parsers a select uses.
 */
export function decodeRecordJson(collection: Collection, json: Row): Row {
  const record: Row = { ...json };
  for (const field of collection.fields) {
    const value = record[field.name];
    if (typeof value !== "string") continue;
    switch (field.type) {
      case "date":
      case "autodate":
        record[field.name] = parseTimestamp(value.replace("T", " "));
        break;
      case "number":
        record[field.name] = parseFloat8(value);
        break;
      case "text":
      case "email":
      case "phone":
      case "url":
      case "password":
      case "bool":
      case "json":
      case "select":
      case "file":
      case "relation":
        break;
      default:
        field satisfies never;
    }
  }
  return record;
}
