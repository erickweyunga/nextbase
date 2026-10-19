import type {
  AuthCollection,
  Collection,
  ViewCollection,
} from "@nextbasejs/client";
import { type Builder, exp, hash, type Tx } from "@nextbasejs/dbx";
import { table } from "../db/system.ts";

interface CollectionRow {
  id: string;
  type: Collection["type"];
  name: string;
  system: boolean;
  fields: Collection["fields"];
  indexes: Collection["indexes"];
  options: Partial<AuthOptions> | Partial<ViewOptions>;
  list_rule: string | null;
  view_rule: string | null;
  create_rule: string | null;
  update_rule: string | null;
  delete_rule: string | null;
}

type AuthOptions = Pick<
  AuthCollection,
  "authRule" | "manageRule" | "identityFields" | "tokens"
>;

type ViewOptions = Pick<ViewCollection, "viewQuery">;

/** Every collection, in creation order. */
export async function loadCollections(q: Builder): Promise<Collection[]> {
  const rows = await q
    .select()
    .from(table("_collections"))
    .orderBy("created", "id")
    .all<CollectionRow>();
  return rows.map(fromRow);
}

/** Inserts or replaces the stored definition of `collection`. */
export async function saveCollectionRow(
  tx: Tx,
  collection: Collection,
): Promise<void> {
  const options: Partial<AuthOptions> | ViewOptions =
    collection.type === "auth"
      ? {
          authRule: collection.authRule,
          manageRule: collection.manageRule,
          identityFields: collection.identityFields,
          tokens: collection.tokens,
        }
      : collection.type === "view"
        ? { viewQuery: collection.viewQuery }
        : {};
  await tx
    .upsert(
      table("_collections"),
      {
        id: collection.id,
        type: collection.type,
        name: collection.name,
        system: collection.system,
        // Serialized explicitly: node-postgres turns JS arrays into Postgres
        // arrays, not JSON.
        fields: JSON.stringify(collection.fields),
        indexes: JSON.stringify(collection.indexes),
        options: JSON.stringify(options),
        list_rule: collection.listRule,
        view_rule: collection.viewRule,
        create_rule: collection.createRule,
        update_rule: collection.updateRule,
        delete_rule: collection.deleteRule,
        updated: exp("now()"),
      },
      "id",
    )
    .execute();
}

export async function deleteCollectionRow(tx: Tx, id: string): Promise<void> {
  await tx.delete(table("_collections"), hash({ id })).execute();
}

/** Marks every instance's cached schema as stale. */
export async function bumpSchemaVersion(tx: Tx): Promise<void> {
  await tx
    .newQuery(
      `UPDATE {{${table("_meta")}}} SET schema_version = schema_version + 1`,
    )
    .execute();
}

function fromRow(row: CollectionRow): Collection {
  const base = {
    id: row.id,
    name: row.name,
    system: row.system,
    fields: row.fields,
    indexes: row.indexes,
    listRule: row.list_rule,
    viewRule: row.view_rule,
    createRule: row.create_rule,
    updateRule: row.update_rule,
    deleteRule: row.delete_rule,
  };
  if (row.type === "base") return { ...base, type: "base" };
  if (row.type === "view")
    return { ...base, type: "view", ...(row.options as ViewOptions) };
  return { ...base, type: "auth", ...(row.options as AuthOptions) };
}
