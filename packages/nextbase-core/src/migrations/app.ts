import type { Collection, Field } from '@nextbasejs/client';
import type { Tx } from '@nextbasejs/dbx';
import type { Effects } from '../effects.ts';
import { ApiError } from '../errors.ts';
import type { Join, JoinedClient } from '../records/hooks.ts';
import { readSchemaVersion, Schema } from '../schema/cache.ts';
import { loadCollections } from '../schema/store.ts';
import {
  deleteCollection,
  newCollection,
  updateCollection,
} from '../schema/sync.ts';
import { readViewRole } from '../schema/views.ts';
import type { CollectionDraft, FieldList, MigrationApp } from './define.ts';
import { asInput, importCollections } from './import.ts';

export interface MigrationRun {
  app: MigrationApp;
  /** Waits for the client's requests and closes it. */
  close(): Promise<void>;
  /** Files of removed file fields, to delete once the migration commits. */
  obsoleteFiles: string[];
  /** Ids of deleted collections, whose files go once it commits. */
  deleted: string[];
}

/** Joins a client to a migration's transaction, reading `schema` for each request. */
export type JoinMigration = (
  join: Join,
  schema: () => Promise<Schema>,
) => JoinedClient;

/** The `app` of one migration, in its transaction. */
export async function migrationRun(
  tx: Tx,
  name: string,
  effects: Effects,
  joined: JoinMigration,
): Promise<MigrationRun> {
  const obsoleteFiles: string[] = [];
  const deleted: string[] = [];
  // Records see the collections as the migration has changed them so far.
  const schema = async (): Promise<Schema> =>
    new Schema(
      await readSchemaVersion(tx),
      await loadCollections(tx),
      await readViewRole(tx),
    );
  const client = joined(
    { tx, schema: await schema(), effects, chain: [`migration ${name}`] },
    schema,
  );
  const find = async (idOrName: string): Promise<Collection> => {
    const found = (await loadCollections(tx)).find(
      (c) => c.id === idOrName || c.name === idOrName,
    );
    if (!found) throw new ApiError(404, `Collection ${idOrName} not found.`);
    return found;
  };
  const app: MigrationApp = {
    db: tx,
    nextbase: client.client,
    collections: {
      get: find,
      create: (input) => newCollection(tx, input),
      async change(idOrName, edit) {
        const existing = await find(idOrName);
        const draft = structuredClone(existing) as unknown as CollectionDraft;
        draft.fields = fieldList(draft.fields, existing.fields);
        await edit(draft as Parameters<typeof edit>[0]);
        return updateCollection(
          tx,
          existing.id,
          asInput({ ...draft, fields: [...draft.fields] } as Collection),
          obsoleteFiles,
        );
      },
      async delete(idOrName) {
        const { id } = await find(idOrName);
        await deleteCollection(tx, id);
        deleted.push(id);
      },
      async import(collections, options) {
        const result = await importCollections(
          tx,
          collections,
          options?.deleteMissing ?? false,
        );
        obsoleteFiles.push(...result.obsoleteFiles);
        deleted.push(...result.deleted);
      },
    },
  };
  return {
    app,
    close: async () => {
      await client.close();
    },
    obsoleteFiles,
    deleted,
  };
}

/**
 * The fields as an array with the by-id helpers generated migrations use. A field of
 * another database's id is this one's of the same name and type, such as `created`.
 */
function fieldList(fields: Field[], stored: readonly Field[]): FieldList {
  const list = [...fields] as FieldList;
  Object.defineProperties(list, {
    getById: {
      value: (id: string) => list.find((f) => f.id === id),
    },
    removeById: {
      value: (id: string) => {
        const at = list.findIndex((f) => f.id === id);
        if (at !== -1) list.splice(at, 1);
      },
    },
    addAt: {
      value: (index: number, input: Partial<Field>) => {
        const twin =
          typeof input.id === 'string' && !stored.some((f) => f.id === input.id)
            ? stored.find((f) => f.name === input.name && f.type === input.type)
            : undefined;
        const field = twin ? { ...input, id: twin.id } : input;
        if (typeof field.id === 'string') list.removeById(field.id);
        list.splice(
          Math.min(Math.max(index, 0), list.length),
          0,
          field as Field,
        );
      },
    },
  });
  return list;
}
