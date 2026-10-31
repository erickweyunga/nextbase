import type {
  Collection,
  CollectionInput,
  Field,
  ViewCollection,
} from '@nextbasejs/client';
import type { Tx } from '@nextbasejs/dbx';
import { lockSchema } from '../db/system.ts';
import { ApiError } from '../errors.ts';
import { findCollection } from '../schema/cache.ts';
import { isRecord } from '../schema/input.ts';
import { loadCollections } from '../schema/store.ts';
import {
  deleteCollection,
  newCollection,
  updateCollection,
} from '../schema/sync.ts';
import { createView, dropView, readViewRole } from '../schema/views.ts';

/** What an import leaves to do once it commits. */
export interface ImportResult {
  obsoleteFiles: string[];
  /** Ids of the collections it deleted, whose files go too. */
  deleted: string[];
}

const RULES = [
  'listRule',
  'viewRule',
  'createRule',
  'updateRule',
  'deleteRule',
  'authRule',
  'manageRule',
] as const;

/** A stored collection as input for a change: `system` is not an input, nor a view's fields. */
export function asInput(collection: Collection): CollectionInput {
  const { system: _, ...input } = collection as Collection & {
    viewQuery?: string;
  };
  if (collection.type === 'view') {
    const { fields: __, indexes: ___, ...view } = input;
    return view as CollectionInput;
  }
  return input as CollectionInput;
}

interface Match {
  item: CollectionInput;
  id: string | undefined;
  existing: Collection | undefined;
  view: boolean;
}

/**
 * Lays `items` over the collections, matched by id, then name, in one transaction.
 * Tables change first, then views, then every rule, so all may refer to one another.
 */
export async function importCollections(
  db: Tx,
  items: readonly CollectionInput[],
  deleteMissing: boolean,
): Promise<ImportResult> {
  if (!Array.isArray(items) || items.length === 0) {
    // As otherwise deleteMissing would drop every collection.
    throw new ApiError(400, 'Import at least one collection.');
  }
  const result: ImportResult = { obsoleteFiles: [], deleted: [] };
  await db.transaction(async (tx) => {
    await lockSchema(tx);
    const before = await loadCollections(tx);
    const matches = items.map((item, i): Match => {
      if (!isRecord(item)) {
        throw new ApiError(400, `Collection ${i + 1} must be an object.`);
      }
      const input = item as CollectionInput;
      const key = typeof input.id === 'string' ? input.id : undefined;
      const existing =
        (key && findCollection(before, key)) ||
        (typeof input.name === 'string'
          ? findCollection(before, input.name)
          : undefined);
      return {
        item: input,
        id: existing?.id ?? key,
        existing,
        view: (existing?.type ?? input.type) === 'view',
      };
    });
    const kept = new Set(matches.map((m) => m.id));
    const missing = deleteMissing
      ? before.filter((c) => !c.system && !kept.has(c.id))
      : [];
    await deleteAll(
      tx,
      missing.filter((c) => c.type === 'view'),
      result.deleted,
    );

    // Views go down while tables change under them, and come back after.
    const role = await readViewRole(tx);
    const views = before.filter(
      (c): c is ViewCollection =>
        c.type === 'view' && !result.deleted.includes(c.id),
    );
    for (const view of views) {
      await dropView(tx, role as string, view.name);
    }

    const tables = matches.filter((m) => !m.view);
    for (const m of tables) {
      if (m.existing) continue;
      const created = await newCollection(tx, {
        ...(m.id !== undefined && { id: m.id }),
        name: m.item.name,
        ...(m.item.type !== undefined && { type: m.item.type }),
        fields: (m.item.fields ?? []).filter((f) => f.type !== 'relation'),
      });
      m.id = created.id;
    }
    for (const m of tables) {
      const current = await find(tx, m.id as string);
      await updateCollection(
        tx,
        current.id,
        current.system
          ? fixedRules(overlay(current, m.item, deleteMissing))
          : withoutRules(overlay(current, m.item, deleteMissing), m.item),
        result.obsoleteFiles,
      );
    }

    // Kept views as they were, then imported ones as the import says.
    for (const view of views) {
      if (matches.some((m) => m.id === view.id)) continue;
      await createView(tx, role as string, view, {
        previous: view.fields,
        replace: true,
      });
    }
    for (const m of matches.filter((x) => x.view)) {
      const { fields: _, indexes: __, ...view } = m.item;
      const input = withoutRules(view, m.item);
      if (m.existing?.type === 'view') {
        // Recreated with its query, changed or not, as it went down above.
        await createView(
          tx,
          role as string,
          { ...m.existing, ...(view as Partial<ViewCollection>) },
          { previous: m.existing.fields, replace: true },
        );
        await updateCollection(tx, m.existing.id, {
          ...input,
          id: m.existing.id,
        });
      } else {
        m.id = (await newCollection(tx, input)).id;
      }
    }

    for (const m of matches) {
      if (m.existing?.system) continue;
      const rules = rulesOf(m.item);
      if (Object.keys(rules).length > 0) {
        await updateCollection(tx, m.id as string, rules);
      }
    }
    // Last, once kept tables no longer refer to them.
    await deleteAll(
      tx,
      missing.filter((c) => c.type !== 'view'),
      result.deleted,
    );
  });
  return result;
}

async function find(tx: Tx, id: string): Promise<Collection> {
  return findCollection(await loadCollections(tx), id) as Collection;
}

/** The import over the stored collection; fields it leaves out are kept unless `deleteMissing`. */
function overlay(
  current: Collection,
  item: CollectionInput,
  deleteMissing: boolean,
): CollectionInput {
  const known = new Set(current.fields.map((f) => f.id));
  const claimed = new Set<string>();
  const imported = (item.fields ?? current.fields).map((field) => {
    if (typeof field.id === 'string' && known.has(field.id)) {
      claimed.add(field.id);
      return field;
    }
    // A field of the same name and type is the one stored, such as `created`, whose
    // id differs per database, so its column stays.
    const same = current.fields.find(
      (f) =>
        f.name === field.name && f.type === field.type && !claimed.has(f.id),
    );
    if (!same) return field;
    claimed.add(same.id);
    return { ...field, id: same.id };
  });
  const left = current.fields.filter(
    (f) => !claimed.has(f.id) && (f.system || !deleteMissing),
  );
  return {
    ...asInput(current),
    ...item,
    id: current.id,
    fields: [...imported, ...left] as Partial<Field>[],
  };
}

/** The rules the item sets, applied once every collection is in place. */
function rulesOf(item: CollectionInput): CollectionInput {
  const rules: Record<string, unknown> = {};
  for (const key of RULES) {
    if (key in item) rules[key] = item[key];
  }
  if (isRecord(item.mfa) && 'rule' in item.mfa) {
    rules.mfa = { rule: item.mfa.rule };
  }
  return rules as CollectionInput;
}

/** `input` with the rules the item sets left null until `rulesOf` sets them. */
function withoutRules(
  input: CollectionInput,
  item: CollectionInput,
): CollectionInput {
  const held: Record<string, unknown> = { ...input };
  for (const key of RULES) {
    if (key in item) held[key] = null;
  }
  if (isRecord(item.mfa) && 'rule' in item.mfa) {
    held.mfa = { ...(input.mfa ?? {}), rule: null };
  }
  return held as CollectionInput;
}

/** A system collection's input without its rules, which never change. */
function fixedRules(input: CollectionInput): CollectionInput {
  const kept: Record<string, unknown> = { ...input };
  for (const key of RULES) delete kept[key];
  return kept as CollectionInput;
}

/** Deletes each once nothing left refers to it. */
async function deleteAll(
  tx: Tx,
  collections: readonly Collection[],
  deleted: string[],
): Promise<void> {
  let left = [...collections];
  while (left.length > 0) {
    let failure: unknown;
    const next: Collection[] = [];
    for (const collection of left) {
      try {
        await tx.transaction((sp) => deleteCollection(sp, collection.id));
        deleted.push(collection.id);
      } catch (error) {
        failure = error;
        next.push(collection);
      }
    }
    if (next.length === left.length) throw failure;
    left = next;
  }
}
