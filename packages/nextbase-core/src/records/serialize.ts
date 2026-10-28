import type { Collection, Field } from "@nextbasejs/client";
import type { Row } from "@nextbasejs/dbx";
import type { Principal } from "../auth/principal.ts";

/**
 * Drops hidden fields, unless `hidden`, turns NULL into `""` and timestamps into ISO strings.
 * Email shows if visible, to the record itself or superusers; phone only to the latter two.
 */
export function serializeRecord(
  collection: Collection,
  row: Row,
  viewer: Principal,
  hidden = false,
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

  // Phones have no visibility setting: only the record and superusers see them.
  const showPhone =
    collection.type !== "auth" ||
    viewer.superuser ||
    (viewer.record !== undefined &&
      viewer.collection?.id === collection.id &&
      viewer.record.id === row.id);

  for (const field of collection.fields) {
    if (field.hidden && (!hidden || secret(field))) continue;
    const value = row[field.name];
    if (field.type === "date" || field.type === "autodate") {
      out[field.name] = value instanceof Date ? value.toISOString() : "";
    } else if (field.type === "relation" && value === null) {
      out[field.name] = "";
    } else if (field.system && field.name === "email" && !showEmail) {
      out[field.name] = "";
    } else if (field.system && field.name === "phone" && !showPhone) {
      out[field.name] = "";
    } else {
      out[field.name] = value;
    }
  }
  return out;
}

/**
 * A record as hooks see it: as a superuser does, with hidden fields too, but
 * never a password hash or token key.
 */
export function serverRecord(
  collection: Collection,
  row: Row,
): Record<string, unknown> {
  return serializeRecord(collection, row, { superuser: true }, true);
}

function secret(field: Field): boolean {
  return (
    field.type === "password" || (field.system && field.name === "tokenKey")
  );
}
