import type { TypeParsers } from "@nextbasejs/dbx";
import pg from "pg";
import { parseTimestamptz } from "../storable.ts";

const TIMESTAMPTZ_OID = 1184;

/**
 * Result parsers for NextBase's queries: node-postgres's defaults, except
 * timestamptz, which it misreads for historical and far-future dates. Scoped
 * to NextBase's DB, so the host app's own pg usage is unaffected.
 */
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
