import type {
  Collection,
  ErrorData,
  Field,
  FileField,
} from '@nextbasejs/client';
import type { Builder, DB, Tx } from '@nextbasejs/dbx';
import { lockSchema, table } from '../db/system.ts';
import { ApiError, indexRowTooLarge } from '../errors.ts';
import { fileKey, fileNames } from '../files/files.ts';
import { ruleProblem } from '../filter/compiler.ts';
import { ID_PATTERN } from '../random.ts';
import { findCollection, Schema } from './cache.ts';
import { parseCollection } from './collection.ts';
import { isMultiple } from './fields.ts';
import {
  bumpSchemaVersion,
  deleteCollectionRow,
  loadCollections,
  saveCollectionRow,
} from './store.ts';
import {
  createView,
  dropView,
  ensureViewRole,
  grantViewRole,
  readViewRole,
  renameView,
} from './views.ts';

// Each schema change is one transaction under the schema lock (load, validate,
// DDL, store, bump version). DDL is transactional, so a failure changes nothing.

export async function newCollection(
  db: DB,
  input: unknown,
): Promise<Collection> {
  return db.transaction(async (tx) => {
    await lockSchema(tx);
    const others = await loadCollections(tx);
    let collection = parseCollection(input, { others });
    if (collection.type === 'view') {
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
  obsoleteFiles: string[] = [],
): Promise<Collection> {
  return db.transaction(async (tx) => {
    await lockSchema(tx);
    const all = await loadCollections(tx);
    const existing = find(all, idOrName);
    const others = all.filter((c) => c !== existing);
    let collection = parseCollection(input, { existing, others });
    if (existing.type === 'view' && collection.type === 'view') {
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
      obsoleteFiles.push(...(await removedFiles(tx, existing, collection)));
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
      throw new ApiError(400, 'System collections cannot be deleted.');
    }
    const references = all.flatMap((c) =>
      c === existing
        ? []
        : c.fields
            .filter(
              (f) => f.type === 'relation' && f.collectionId === existing.id,
            )
            .map((f) => `${c.name}.${f.name}`),
    );
    if (references.length > 0) {
      throw new ApiError(
        400,
        `The collection is referenced by ${references.join(', ')}. Remove those relation fields first.`,
      );
    }
    // Such as `@collection.<name>` or `<name>_via_<field>` in another rule.
    const broken = ruleProblems(all.filter((c) => c !== existing)).map(
      ({ collection, key }) => `the ${key} of ${collection.name}`,
    );
    if (broken.length > 0) {
      throw new ApiError(
        400,
        `The collection is used by ${broken.join(', ')}. Change those rules first.`,
      );
    }
    if (existing.type === 'view') {
      await dropView(tx, (await readViewRole(tx)) as string, existing.name);
    } else
      await tx.newQuery(`DROP TABLE {{${table(existing.name)}}}`).execute();
    await deleteCollectionRow(tx, existing.id);
    if (existing.type === 'auth') {
      for (const name of [
        '_sessions',
        '_linked_accounts',
        '_oauth2_states',
        '_mfas',
        '_totp',
        '_recovery_codes',
        '_password_origins',
        '_otps',
        '_passkeys',
        '_webauthn_challenges',
      ]) {
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

async function removedFiles(
  tx: Tx,
  existing: Collection,
  next: Collection,
): Promise<string[]> {
  const removed = existing.fields.filter(
    (f): f is FileField =>
      f.type === 'file' &&
      !next.fields.some((n) => n.id === f.id && n.type === 'file'),
  );
  if (removed.length === 0) return [];
  const rows = await tx
    .select('id', ...removed.map((f) => f.name))
    .from(table(existing.name))
    .all();
  return rows.flatMap((row) =>
    removed.flatMap((field) =>
      fileNames(field, row[field.name]).map((name) =>
        fileKey(existing.id, row.id as string, name),
      ),
    ),
  );
}

async function refreshViewGrants(
  tx: Tx,
  collections: readonly Collection[],
): Promise<void> {
  const role = await readViewRole(tx);
  if (role) await grantViewRole(tx, role, collections);
}

const RULE_KEYS = [
  'listRule',
  'viewRule',
  'createRule',
  'updateRule',
  'deleteRule',
  'authRule',
  'manageRule',
] as const;

interface RuleProblem {
  collection: Collection;
  key: (typeof RULE_KEYS)[number] | 'mfa.rule';
  problem: string;
}

/** The stored rules that do not compile against `collections`. */
function ruleProblems(collections: readonly Collection[]): RuleProblem[] {
  const schema = new Schema(0, collections);
  const problems: RuleProblem[] = [];
  for (const target of collections) {
    const rules: [RuleProblem['key'], string | null | undefined][] =
      RULE_KEYS.map((key) => [
        key,
        (target as Partial<Record<(typeof RULE_KEYS)[number], string | null>>)[
          key
        ],
      ]);
    if (target.type === 'auth') rules.push(['mfa.rule', target.mfa.rule]);
    for (const [key, rule] of rules) {
      const problem =
        rule === undefined ? undefined : ruleProblem(rule, target, schema);
      if (problem !== undefined)
        problems.push({ collection: target, key, problem });
    }
  }
  return problems;
}

// Rejects a change (e.g. a rename) that would break any stored rule, rather
// than letting it fail at request time.
function checkRules(
  collection: Collection,
  others: readonly Collection[],
): void {
  const data: ErrorData = {};
  for (const { collection: target, key, problem } of ruleProblems([
    ...others,
    collection,
  ])) {
    if (target !== collection) {
      throw new ApiError(
        400,
        `This change breaks the ${key} of ${target.name}: ${problem}`,
      );
    }
    const error = { code: 'validation_invalid_rule', message: problem };
    if (key === 'mfa.rule') data.mfa = { rule: error };
    else data[key] = error;
  }
  if (Object.keys(data).length > 0)
    throw new ApiError(400, 'Failed to validate the collection.', data);
}

/** Exported for the migration that creates `_superusers`; use newCollection otherwise. */
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
      `CREATE TABLE {{${table(collection.name)}}} (${[...columns, ...foreignKeys].join(', ')})`,
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

  // Indexes first: a text <-> text[] change cannot keep an index of the old type.
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

// text <-> text[]: a value becomes a one-element array; an array keeps its first element.
async function convertMultiplicity(
  tx: Tx,
  t: string,
  field: Field,
  tables: ReadonlyMap<string, string>,
): Promise<void> {
  const c = tx.quoteSimpleColumnName(field.name);
  const exec = (sql: string): Promise<unknown> => tx.newQuery(sql).execute();
  const relation = field.type === 'relation';
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
 * Blanks are stored as "", 0 or false, not NULL, so filters like `name != "x"`
 * still match blank rows. Dates, JSON and single relations use NULL.
 */
function columnType(q: Builder, field: Field, collection: Collection): string {
  switch (field.type) {
    case 'text':
      if (field.primaryKey) {
        // Ids appear in storage paths, so the database enforces their format too.
        // Named by collection id, since a later collection could reuse the table name.
        return `text CONSTRAINT ${q.quoteSimpleColumnName(`_${collection.id}_pkey`)} PRIMARY KEY CHECK (${q.quoteSimpleColumnName(field.name)} ~ '${ID_PATTERN.source}')`;
      }
      return "text NOT NULL DEFAULT ''";
    case 'email':
    case 'phone':
    case 'url':
      return "text NOT NULL DEFAULT ''";
    case 'password':
      return 'text NOT NULL';
    case 'number':
      return 'double precision NOT NULL DEFAULT 0';
    case 'bool':
      return 'boolean NOT NULL DEFAULT false';
    case 'date':
      return 'timestamptz';
    case 'autodate':
      return 'timestamptz NOT NULL DEFAULT now()';
    case 'json':
      return 'jsonb';
    case 'select':
    case 'file':
      return isMultiple(field)
        ? "text[] NOT NULL DEFAULT '{}'"
        : "text NOT NULL DEFAULT ''";
    case 'relation':
      return isMultiple(field) ? "text[] NOT NULL DEFAULT '{}'" : 'text';
    default: {
      const unknown: never = field;
      throw new Error(`Unknown field type: ${JSON.stringify(unknown)}.`);
    }
  }
}

function isSingleRelation(field: Field): boolean {
  return field.type === 'relation' && !isMultiple(field);
}

function foreignKeyName(q: Builder, field: Field): string {
  return q.quoteSimpleColumnName(`_${field.id}_fk`);
}

// NO ACTION: NextBase resolves references itself; the key only guards raw SQL.
function foreignKey(
  q: Builder,
  field: Field,
  tables: ReadonlyMap<string, string>,
): string {
  if (field.type !== 'relation') throw new Error('Not a relation field.');
  const target = tables.get(field.collectionId);
  if (target === undefined) {
    throw new Error(`Unknown relation target ${field.collectionId}.`);
  }
  return `CONSTRAINT ${foreignKeyName(q, field)} FOREIGN KEY (${q.quoteSimpleColumnName(field.name)}) REFERENCES ${q.quoteTableName(table(target))} ("id")`;
}

interface SystemIndex {
  /** `_<collection id>_...`, which user index names cannot collide with. */
  name: string;
  sql: string;
}

// Names carry the index kind, so switching a field's multiplicity replaces its index.
function systemIndexes(q: Builder, collection: Collection): SystemIndex[] {
  const t = `{{${table(collection.name)}}}`;
  const col = (name: string): string => q.quoteSimpleColumnName(name);
  const name = (suffix: string): string => `_${collection.id}_${suffix}`;
  const indexes: SystemIndex[] = [];
  if (collection.type === 'auth') {
    indexes.push(
      {
        name: name('email'),
        sql: `CREATE UNIQUE INDEX ${col(name('email'))} ON ${t} (lower("email")) WHERE "email" <> ''`,
      },
      {
        name: name('phone'),
        sql: `CREATE UNIQUE INDEX ${col(name('phone'))} ON ${t} ("phone") WHERE "phone" <> ''`,
      },
      {
        name: name('tokenKey'),
        sql: `CREATE UNIQUE INDEX ${col(name('tokenKey'))} ON ${t} ("tokenKey")`,
      },
    );
  }
  for (const field of collection.fields) {
    if (isMultiple(field)) {
      indexes.push({
        name: name(`${field.id}_gin`),
        sql: `CREATE INDEX ${col(name(`${field.id}_gin`))} ON ${t} USING gin (${col(field.name)})`,
      });
    } else if (field.type === 'relation') {
      // Rules, back-relations and delete cascades look records up by this column.
      indexes.push({
        name: name(field.id),
        sql: `CREATE INDEX ${col(name(field.id))} ON ${t} (${col(field.name)})`,
      });
    } else if (field.type === 'autodate' && field.name === 'created') {
      // Lists sort by `-created, -id` when no sort is given.
      indexes.push({
        name: name(`${field.id}_sort`),
        sql: `CREATE INDEX ${col(name(`${field.id}_sort`))} ON ${t} (${col(field.name)}, "id")`,
      });
    }
  }
  return indexes;
}

type Index = Collection['indexes'][number];

async function createIndex(
  tx: Tx,
  collection: Collection,
  index: Index,
): Promise<void> {
  const opclass =
    index.type === 'trigram' ? ` ${await trigramOperatorClass(tx)}` : '';
  const columns = index.fields.map((id) => {
    const field = collection.fields.find((f) => f.id === id);
    if (!field)
      throw new Error(`Index ${index.name} uses unknown field ${id}.`);
    return `${tx.quoteSimpleColumnName(field.name)}${opclass}`;
  });
  const using = index.type === 'trigram' ? ' USING gin' : '';
  try {
    await tx
      .newQuery(
        `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${tx.quoteSimpleColumnName(index.name)} ON {{${table(collection.name)}}}${using} (${columns.join(', ')})`,
      )
      .execute();
  } catch (error) {
    // An entry must fit in a page, so long text cannot go in a btree index.
    if (!indexRowTooLarge(error)) throw error;
    const problem = {
      code: 'validation_length_out_of_range',
      message: 'Some records have values too large to index.',
    };
    throw new ApiError(
      400,
      `The index ${index.name} cannot be created: some records have values too large to index. Index other fields, or use a trigram index to search long text.`,
      { indexes: { [collection.indexes.indexOf(index)]: { fields: problem } } },
    );
  }
}

// Schema-qualified so it resolves whatever the search path. Installing pg_trgm
// needs the CREATE privilege on the database.
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
      await tx.newQuery('CREATE EXTENSION pg_trgm').execute();
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
    (a.type ?? 'btree') === (b.type ?? 'btree') &&
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
  const found = findCollection(collections, idOrName);
  if (!found) throw new ApiError(404, 'Collection not found.');
  return found;
}
