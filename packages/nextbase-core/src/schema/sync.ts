import type { Collection, ErrorData, Field } from "@nextbasejs/client";
import type { Builder, DB, Tx } from "@nextbasejs/dbx";
import { lockSchema, table } from "../db/system.ts";
import { ApiError } from "../errors.ts";
import { ruleProblem } from "../filter/compiler.ts";
import { Schema } from "./cache.ts";
import { parseCollection } from "./collection.ts";
import { isMultiple } from "./fields.ts";
import {
  bumpSchemaVersion,
  deleteCollectionRow,
  loadCollections,
  saveCollectionRow,
} from "./store.ts";
import {
  createView,
  dropView,
  ensureViewRole,
  grantViewRole,
  readViewRole,
  renameView,
} from "./views.ts";

// Every schema change runs in one transaction holding the schema lock: load the
// current schema, validate against it, run the DDL, store the definition and
// bump the version. Postgres DDL is transactional, so a failure at any step
// leaves both the tables and the stored definitions as they were.

export async function newCollection(
  db: DB,
  input: unknown,
): Promise<Collection> {
  return db.transaction(async (tx) => {
    await lockSchema(tx);
    const others = await loadCollections(tx);
    let collection = parseCollection(input, { others });
    if (collection.type === "view") {
      const role = await ensureViewRole(tx);
      await grantViewRole(tx, role, others);
      // Its fields come from the query, so rules are checked after.
      collection = {
        ...collection,
        fields: await createView(tx, role, collection),
      };
      checkRules(collection, others);
    } else {
      checkRules(collection, others);
      await createCollectionTable(tx, collection, others);
      await refreshViewGrants(tx, [...others, collection]);
    }
    await saveCollectionRow(tx, collection);
    await bumpSchemaVersion(tx);
    return collection;
  });
}

export async function updateCollection(
  db: DB,
  idOrName: string,
  input: unknown,
): Promise<Collection> {
  return db.transaction(async (tx) => {
    await lockSchema(tx);
    const all = await loadCollections(tx);
    const existing = find(all, idOrName);
    const others = all.filter((c) => c !== existing);
    let collection = parseCollection(input, { existing, others });
    if (existing.type === "view" && collection.type === "view") {
      const role = (await readViewRole(tx)) as string;
      if (collection.name !== existing.name) {
        await renameView(tx, role, existing.name, collection.name);
      }
      if (collection.viewQuery !== existing.viewQuery) {
        collection = {
          ...collection,
          fields: await createView(tx, role, collection, {
            previous: existing.fields,
            replace: true,
          }),
        };
      }
      checkRules(collection, others);
    } else {
      checkRules(collection, others);
      await alterCollectionTable(tx, existing, collection, others);
      await refreshViewGrants(tx, [...others, collection]);
    }
    await saveCollectionRow(tx, collection);
    await bumpSchemaVersion(tx);
    return collection;
  });
}

export async function deleteCollection(
  db: DB,
  idOrName: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockSchema(tx);
    const all = await loadCollections(tx);
    const existing = find(all, idOrName);
    if (existing.system) {
      throw new ApiError(400, "System collections cannot be deleted.");
    }
    const references = all.flatMap((c) =>
      c === existing
        ? []
        : c.fields
            .filter(
              (f) => f.type === "relation" && f.collectionId === existing.id,
            )
            .map((f) => `${c.name}.${f.name}`),
    );
    if (references.length > 0) {
      throw new ApiError(
        400,
        `The collection is referenced by ${references.join(", ")}. Remove those relation fields first.`,
      );
    }
    if (existing.type === "view") {
      await dropView(tx, (await readViewRole(tx)) as string, existing.name);
    } else
      await tx.newQuery(`DROP TABLE {{${table(existing.name)}}}`).execute();
    await deleteCollectionRow(tx, existing.id);
    if (existing.type === "auth") {
      for (const name of ["_sessions", "_external_auths", "_oauth2_states"]) {
        await tx
          .newQuery(
            `DELETE FROM {{${table(name)}}} WHERE collection_id = {:collectionId}`,
          )
          .bind({ collectionId: existing.id })
          .execute();
      }
    }
    await bumpSchemaVersion(tx);
  });
}

/** Keeps the view role's grants in step with the tables, once it exists. */
async function refreshViewGrants(
  tx: Tx,
  collections: readonly Collection[],
): Promise<void> {
  const role = await readViewRole(tx);
  if (role) await grantViewRole(tx, role, collections);
}

const RULE_KEYS = [
  "listRule",
  "viewRule",
  "createRule",
  "updateRule",
  "deleteRule",
  "authRule",
  "manageRule",
] as const;

/**
 * Checks that every stored rule still compiles once `collection` is saved:
 * its own, and those of other collections that may reach it through a
 * relation. A rename that breaks a rule is rejected instead of leaving a rule
 * that fails at request time.
 */
function checkRules(
  collection: Collection,
  others: readonly Collection[],
): void {
  const schema = new Schema(0, [...others, collection]);
  const data: ErrorData = {};
  for (const target of schema.collections) {
    for (const key of RULE_KEYS) {
      const rule = (
        target as Partial<Record<(typeof RULE_KEYS)[number], string | null>>
      )[key];
      const problem =
        rule === undefined ? undefined : ruleProblem(rule, target, schema);
      if (problem === undefined) continue;
      if (target === collection) {
        data[key] = { code: "validation_invalid_rule", message: problem };
      } else {
        throw new ApiError(
          400,
          `This change breaks the ${key} of ${target.name}: ${problem}`,
        );
      }
    }
  }
  if (Object.keys(data).length > 0)
    throw new ApiError(400, "Failed to validate the collection.", data);
}

/**
 * Creates the table of a validated collection. Exported for the system
 * migration that creates `_superusers`; everything else uses newCollection.
 */
export async function createCollectionTable(
  tx: Tx,
  collection: Collection,
  others: readonly Collection[],
): Promise<void> {
  const tables = tableNames(collection, others);
  const columns = collection.fields.map(
    (f) =>
      `${tx.quoteSimpleColumnName(f.name)} ${columnType(tx, f, collection)}`,
  );
  const foreignKeys = collection.fields
    .filter(isSingleRelation)
    .map((f) => foreignKey(tx, f, tables));
  await tx
    .newQuery(
      `CREATE TABLE {{${table(collection.name)}}} (${[...columns, ...foreignKeys].join(", ")})`,
    )
    .execute();
  for (const index of systemIndexes(tx, collection)) {
    await tx.newQuery(index.sql).execute();
  }
  for (const index of collection.indexes) {
    await createIndex(tx, collection, index);
  }
}

async function alterCollectionTable(
  tx: Tx,
  before: Collection,
  after: Collection,
  others: readonly Collection[],
): Promise<void> {
  const tables = tableNames(after, others);
  const exec = (sql: string): Promise<unknown> => tx.newQuery(sql).execute();

  if (before.name !== after.name) {
    await exec(
      `ALTER TABLE {{${table(before.name)}}} RENAME TO ${tx.quoteSimpleTableName(after.name)}`,
    );
  }
  const t = `{{${table(after.name)}}}`;
  const col = (name: string): string => tx.quoteSimpleColumnName(name);

  // Indexes first: a column changing between text and text[] cannot keep an
  // index built for its old type.
  const afterSystem = new Set(systemIndexes(tx, after).map((i) => i.name));
  for (const { name } of systemIndexes(tx, before)) {
    if (!afterSystem.has(name)) await exec(dropIndex(name));
  }
  const afterIndexes = new Map(after.indexes.map((i) => [i.name, i]));
  for (const index of before.indexes) {
    if (!sameIndex(index, afterIndexes.get(index.name))) {
      await exec(dropIndex(index.name));
    }
  }

  const beforeById = new Map(before.fields.map((f) => [f.id, f]));
  const afterById = new Map(after.fields.map((f) => [f.id, f]));

  // Dropping first frees names that renamed or added fields may take.
  for (const field of before.fields) {
    if (!afterById.has(field.id)) {
      await exec(`ALTER TABLE ${t} DROP COLUMN ${col(field.name)}`);
    }
  }

  // Renames go through temporary names, so swapping two names works.
  const renamed = after.fields.filter((f) => {
    const old = beforeById.get(f.id);
    return old !== undefined && old.name !== f.name;
  });
  for (const field of renamed) {
    const old = beforeById.get(field.id) as Field;
    await exec(
      `ALTER TABLE ${t} RENAME COLUMN ${col(old.name)} TO ${col(temporaryName(field))}`,
    );
  }
  for (const field of renamed) {
    await exec(
      `ALTER TABLE ${t} RENAME COLUMN ${col(temporaryName(field))} TO ${col(field.name)}`,
    );
  }

  for (const field of after.fields) {
    const old = beforeById.get(field.id);
    if (!old) {
      await exec(
        `ALTER TABLE ${t} ADD COLUMN ${col(field.name)} ${columnType(tx, field, after)}`,
      );
      if (isSingleRelation(field)) {
        await exec(`ALTER TABLE ${t} ADD ${foreignKey(tx, field, tables)}`);
      }
    } else if (isMultiple(old) !== isMultiple(field)) {
      await convertMultiplicity(tx, t, field, tables);
    }
  }

  const beforeSystem = new Set(systemIndexes(tx, before).map((i) => i.name));
  for (const index of systemIndexes(tx, after)) {
    if (!beforeSystem.has(index.name)) await exec(index.sql);
  }
  const beforeIndexes = new Map(before.indexes.map((i) => [i.name, i]));
  for (const index of after.indexes) {
    if (!sameIndex(index, beforeIndexes.get(index.name))) {
      await createIndex(tx, after, index);
    }
  }
}

/**
 * Switches a select, relation or file column between one value (text) and
 * several (text[]), keeping the data: one value becomes a one-element array,
 * and an array keeps its first element.
 */
async function convertMultiplicity(
  tx: Tx,
  t: string,
  field: Field,
  tables: ReadonlyMap<string, string>,
): Promise<void> {
  const c = tx.quoteSimpleColumnName(field.name);
  const exec = (sql: string): Promise<unknown> => tx.newQuery(sql).execute();
  const relation = field.type === "relation";
  if (isMultiple(field)) {
    if (relation) {
      await exec(
        `ALTER TABLE ${t} DROP CONSTRAINT ${foreignKeyName(tx, field)}`,
      );
    }
    const blank = relation ? `${c} IS NULL` : `${c} = ''`;
    await exec(
      `ALTER TABLE ${t} ALTER COLUMN ${c} DROP DEFAULT, ALTER COLUMN ${c} TYPE text[] USING (CASE WHEN ${blank} THEN '{}'::text[] ELSE ARRAY[${c}] END), ALTER COLUMN ${c} SET DEFAULT '{}', ALTER COLUMN ${c} SET NOT NULL`,
    );
  } else if (relation) {
    await exec(
      `ALTER TABLE ${t} ALTER COLUMN ${c} DROP DEFAULT, ALTER COLUMN ${c} DROP NOT NULL, ALTER COLUMN ${c} TYPE text USING (${c}[1])`,
    );
    await exec(`ALTER TABLE ${t} ADD ${foreignKey(tx, field, tables)}`);
  } else {
    await exec(
      `ALTER TABLE ${t} ALTER COLUMN ${c} DROP DEFAULT, ALTER COLUMN ${c} TYPE text USING (COALESCE(${c}[1], '')), ALTER COLUMN ${c} SET DEFAULT ''`,
    );
  }
}

/**
 * The column definition of a field. Blank values are zero values for most
 * types, so filters never meet three-valued logic. Dates and JSON have no
 * honest zero value, and single relations need NULL for their foreign key.
 */
function columnType(q: Builder, field: Field, collection: Collection): string {
  switch (field.type) {
    case "text":
      if (field.primaryKey) {
        // Ids appear in file storage paths, so their format is enforced by the
        // database too, not only by validation. Named after the collection id:
        // Postgres would name it after the table, and a later collection could
        // reuse that table name.
        return `text CONSTRAINT ${q.quoteSimpleColumnName(`_${collection.id}_pkey`)} PRIMARY KEY CHECK (${q.quoteSimpleColumnName(field.name)} ~ '^[a-z0-9]{15}$')`;
      }
      return "text NOT NULL DEFAULT ''";
    case "email":
    case "phone":
    case "url":
      return "text NOT NULL DEFAULT ''";
    case "password":
      return "text NOT NULL";
    case "number":
      return "double precision NOT NULL DEFAULT 0";
    case "bool":
      return "boolean NOT NULL DEFAULT false";
    case "date":
      return "timestamptz";
    case "autodate":
      return "timestamptz NOT NULL DEFAULT now()";
    case "json":
      return "jsonb";
    case "select":
    case "file":
      return isMultiple(field)
        ? "text[] NOT NULL DEFAULT '{}'"
        : "text NOT NULL DEFAULT ''";
    case "relation":
      return isMultiple(field) ? "text[] NOT NULL DEFAULT '{}'" : "text";
  }
}

function isSingleRelation(field: Field): boolean {
  return field.type === "relation" && !isMultiple(field);
}

function foreignKeyName(q: Builder, field: Field): string {
  return q.quoteSimpleColumnName(`_${field.id}_fk`);
}

/**
 * A foreign key backing a single relation. NO ACTION: NextBase clears or
 * cascades references itself before deleting a record, so the key only stops
 * raw SQL from leaving dangling references.
 */
function foreignKey(
  q: Builder,
  field: Field,
  tables: ReadonlyMap<string, string>,
): string {
  if (field.type !== "relation") throw new Error("Not a relation field.");
  const target = tables.get(field.collectionId);
  if (target === undefined) {
    throw new Error(`Unknown relation target ${field.collectionId}.`);
  }
  return `CONSTRAINT ${foreignKeyName(q, field)} FOREIGN KEY (${q.quoteSimpleColumnName(field.name)}) REFERENCES ${q.quoteTableName(table(target))} ("id")`;
}

interface SystemIndex {
  /** `_<collection id>_...`: user index names cannot start with `_`. */
  name: string;
  sql: string;
}

/**
 * Indexes every collection of a given shape has: unique emails and token keys
 * for auth collections, btree indexes for single relations, and GIN indexes
 * for array columns. Index names carry the kind, so switching a field between
 * one value and several drops the old index and creates the new one.
 */
function systemIndexes(q: Builder, collection: Collection): SystemIndex[] {
  const t = `{{${table(collection.name)}}}`;
  const col = (name: string): string => q.quoteSimpleColumnName(name);
  const name = (suffix: string): string => `_${collection.id}_${suffix}`;
  const indexes: SystemIndex[] = [];
  if (collection.type === "auth") {
    indexes.push(
      {
        name: name("email"),
        sql: `CREATE UNIQUE INDEX ${col(name("email"))} ON ${t} (lower("email")) WHERE "email" <> ''`,
      },
      {
        name: name("phone"),
        sql: `CREATE UNIQUE INDEX ${col(name("phone"))} ON ${t} ("phone") WHERE "phone" <> ''`,
      },
      {
        name: name("tokenKey"),
        sql: `CREATE UNIQUE INDEX ${col(name("tokenKey"))} ON ${t} ("tokenKey")`,
      },
    );
  }
  for (const field of collection.fields) {
    if (isMultiple(field)) {
      indexes.push({
        name: name(`${field.id}_gin`),
        sql: `CREATE INDEX ${col(name(`${field.id}_gin`))} ON ${t} USING gin (${col(field.name)})`,
      });
    } else if (field.type === "relation") {
      // Rules such as `author = @request.auth.id`, back-relations and delete
      // cascades all look records up by this column.
      indexes.push({
        name: name(field.id),
        sql: `CREATE INDEX ${col(name(field.id))} ON ${t} (${col(field.name)})`,
      });
    } else if (field.type === "autodate" && field.name === "created") {
      // Lists sort by `-created, -id` when no sort is given.
      indexes.push({
        name: name(`${field.id}_sort`),
        sql: `CREATE INDEX ${col(name(`${field.id}_sort`))} ON ${t} (${col(field.name)}, "id")`,
      });
    }
  }
  return indexes;
}

type Index = Collection["indexes"][number];

async function createIndex(
  tx: Tx,
  collection: Collection,
  index: Index,
): Promise<void> {
  const opclass =
    index.type === "trigram" ? ` ${await trigramOperatorClass(tx)}` : "";
  const columns = index.fields.map((id) => {
    const field = collection.fields.find((f) => f.id === id);
    if (!field)
      throw new Error(`Index ${index.name} uses unknown field ${id}.`);
    return `${tx.quoteSimpleColumnName(field.name)}${opclass}`;
  });
  const using = index.type === "trigram" ? " USING gin" : "";
  await tx
    .newQuery(
      `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${tx.quoteSimpleColumnName(index.name)} ON {{${table(collection.name)}}}${using} (${columns.join(", ")})`,
    )
    .execute();
}

/**
 * The trigram operator class, qualified with the schema pg_trgm lives in, so
 * it resolves whatever the search path. Installs the extension when missing,
 * which needs the CREATE privilege on the database.
 */
async function trigramOperatorClass(tx: Tx): Promise<string> {
  const find = (): Promise<string[]> =>
    tx
      .newQuery(
        "SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm'",
      )
      .column<string>();
  let [schema] = await find();
  if (schema === undefined) {
    try {
      await tx.newQuery("CREATE EXTENSION pg_trgm").execute();
    } catch (error) {
      // The schema change rolls back with it.
      throw new ApiError(
        400,
        `Trigram indexes need the pg_trgm extension, which could not be installed: ${(error as Error).message}. Ask a database administrator to run CREATE EXTENSION pg_trgm.`,
      );
    }
    [schema] = await find();
  }
  return `${tx.quoteSimpleColumnName(schema as string)}.gin_trgm_ops`;
}

function dropIndex(name: string): string {
  // IF EXISTS: dropping a column already dropped the indexes on it.
  return `DROP INDEX IF EXISTS {{${table(name)}}}`;
}

function sameIndex(a: Index, b: Index | undefined): boolean {
  return (
    b !== undefined &&
    a.unique === b.unique &&
    (a.type ?? "btree") === (b.type ?? "btree") &&
    a.fields.length === b.fields.length &&
    a.fields.every((id, i) => id === b.fields[i])
  );
}

// Field names cannot start with `_`, so this never collides with a real column.
function temporaryName(field: Field): string {
  return `_rename_${field.id}`;
}

function tableNames(
  collection: Collection,
  others: readonly Collection[],
): Map<string, string> {
  return new Map([...others, collection].map((c) => [c.id, c.name]));
}

function find(
  collections: readonly Collection[],
  idOrName: string,
): Collection {
  const found = collections.find(
    (c) => c.id === idOrName || c.name === idOrName,
  );
  if (!found) throw new ApiError(404, "Collection not found.");
  return found;
}
