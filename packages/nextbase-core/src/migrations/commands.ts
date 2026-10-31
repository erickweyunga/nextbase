import { resolve } from 'node:path';
import type { DB } from '@nextbasejs/dbx';
import { lockSchema, table } from '../db/system.ts';
import { loadCollections } from '../schema/store.ts';
import { migrationNames, nextName, writeMigration } from './files.ts';
import { blankTemplate, snapshotTemplate } from './templates.ts';

// The `nextbase migrate` subcommands: they write files and tidy the history,
// never load the app's TypeScript.

export const DEFAULT_DIR = 'nextbase/migrations';

/** A migration to fill in. */
export async function createMigration(
  root: string,
  dir: string,
  words: string,
): Promise<string> {
  const name = await nextName(resolve(root, dir), words);
  return writeMigration(root, dir, name, blankTemplate());
}

/** A snapshot of the database's collections, counted as applied there. */
export async function snapshotMigration(
  db: DB,
  root: string,
  dir: string,
): Promise<string> {
  return db.transaction(async (tx) => {
    await lockSchema(tx);
    const collections = await loadCollections(tx);
    const name = await nextName(resolve(root, dir), 'collections_snapshot');
    await tx.insert(table('_app_migrations'), { name }).execute();
    return writeMigration(root, dir, name, snapshotTemplate(collections));
  });
}

/** Forgets applied migrations whose file is gone, such as after a squash. */
export async function syncHistory(
  db: DB,
  root: string,
  dir: string,
): Promise<string[]> {
  const names = await migrationNames(resolve(root, dir));
  return db
    .newQuery(
      `DELETE FROM {{${table('_app_migrations')}}}
       WHERE NOT (name = ANY({:names}::text[])) RETURNING name`,
    )
    .bind({ names })
    .column<string>();
}
