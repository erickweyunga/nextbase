import { resolve } from 'node:path';
import type { Collection } from '@nextbasejs/client';
import type { Tx } from '@nextbasejs/dbx';
import { table } from '../db/system.ts';
import type { OnSchemaChange } from '../schema/sync.ts';
import { nextName, writeMigration } from './files.ts';
import { changeTemplate } from './templates.ts';

/**
 * Writes a migration for each collection change, in its transaction, and counts it
 * as applied here. Files are written last, so a failed write undoes the change.
 */
export function automigrate(root: string, dir: string): OnSchemaChange {
  return async (
    tx: Tx,
    before: Collection | undefined,
    after: Collection | undefined,
  ) => {
    const source = changeTemplate(before, after);
    if (source === undefined) return;
    const action = !before ? 'created' : !after ? 'deleted' : 'updated';
    const collection = (before ?? after) as Collection;
    const name = await nextName(
      resolve(root, dir),
      `${action}_${collection.name}`,
    );
    await tx.insert(table('_app_migrations'), { name }).execute();
    await writeMigration(root, dir, name, source);
  };
}
