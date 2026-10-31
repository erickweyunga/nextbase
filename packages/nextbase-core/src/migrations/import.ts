import type { Collection, CollectionInput, Field } from '@nextbasejs/client';
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

/** What an import leaves to do once it commits. */
export interface ImportResult {
  obsoleteFiles: string[];
  /** Ids of the collections it deleted, whose files go too. */
  deleted: string[];
}

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

/**
 * Lays `items` over the collections, matched by id, then name, in one transaction.
 * New tables start without relations, rules and indexes, so they can refer to one another.
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
    const matches = items.map((item, i) => {
      if (!isRecord(item)) {
        throw new ApiError(400, `Collection ${i + 1} must be an object.`);
      }
      const key = typeof item.id === 'string' ? item.id : undefined;
      const existing =
        (key && findCollection(before, key)) ||
        (typeof item.name === 'string'
          ? findCollection(before, item.name)
          : undefined);
      return {
        item: item as CollectionInput,
        id: existing?.id ?? key,
        existing,
      };
    });
    const isView = (m: (typeof matches)[number]) =>
      (m.existing?.type ?? m.item.type) === 'view';
    const tables = matches.filter((m) => !isView(m));
    const kept = new Set(matches.map((m) => m.existing?.id ?? m.id));
    const missing = deleteMissing
      ? before.filter((c) => !c.system && !kept.has(c.id))
      : [];
    // Views read the tables, so the ones left out go before tables change.
    await deleteAll(
      tx,
      missing.filter((c) => c.type === 'view'),
      result.deleted,
    );

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
      const all = await loadCollections(tx);
      const current = findCollection(all, m.id as string) as Collection;
      await updateCollection(
        tx,
        current.id,
        overlay(current, m.item, deleteMissing),
        result.obsoleteFiles,
      );
    }
    for (const m of matches.filter(isView)) {
      const { fields: _, indexes: __, ...view } = m.item;
      if (m.existing) {
        await updateCollection(tx, m.existing.id, view);
      } else {
        await newCollection(tx, view);
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

/** The import over the stored collection; fields it leaves out are kept unless `deleteMissing`. */
function overlay(
  current: Collection,
  item: CollectionInput,
  deleteMissing: boolean,
): CollectionInput {
  const imported = (item.fields ?? current.fields).map((field) => {
    if (typeof field.id === 'string') return field;
    // A field by name and type is the one stored, so its column stays.
    const same = current.fields.find(
      (f) => f.name === field.name && f.type === field.type,
    );
    return same ? { ...field, id: same.id } : field;
  });
  const ids = new Set(imported.map((f) => f.id));
  const left = current.fields.filter(
    (f) => !ids.has(f.id) && (f.system || !deleteMissing),
  );
  return {
    ...asInput(current),
    ...item,
    id: current.id,
    fields: [...imported, ...left] as Partial<Field>[],
  };
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
