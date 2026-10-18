import type { Row } from "@nextbase/dbx";
import type { Collection } from "../../shared/schema.ts";
import type { Principal } from "../auth/principal.ts";

/**
 * Turns a database row into a record's API representation: hidden fields are
 * left out, SQL NULL blanks become `""`, and timestamps become ISO strings.
 * An auth record's email is shown only when it is visible, to the record
 * itself, or to a superuser.
 */
export function serializeRecord(
  collection: Collection,
  row: Row,
  viewer: Principal,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    collectionId: collection.id,
    collectionName: collection.name,
  };
  const showEmail =
    collection.type !== "auth" ||
    row.emailVisibility === true ||
    viewer.superuser ||
    (viewer.record !== undefined &&
      viewer.collection?.id === collection.id &&
      viewer.record.id === row.id);

  for (const field of collection.fields) {
    if (field.hidden) continue;
    const value = row[field.name];
    if (field.type === "date" || field.type === "autodate") {
      out[field.name] = value instanceof Date ? value.toISOString() : "";
    } else if (field.type === "relation" && value === null) {
      out[field.name] = "";
    } else if (field.system && field.name === "email" && !showEmail) {
      out[field.name] = "";
    } else {
      out[field.name] = value;
    }
  }
  return out;
}
