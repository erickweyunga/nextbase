import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MIGRATION_NAME } from './define.ts';
import { indexTemplate } from './templates.ts';

// Migration files in the app's folder, and the index that bundles them.

/** The names of the migrations in `dir`. */
export async function migrationNames(dir: string): Promise<string[]> {
  const entries = await readdir(dir).catch((error: unknown) => {
    if ((error as { code?: unknown }).code === 'ENOENT') return [];
    throw error;
  });
  return entries
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.slice(0, -3))
    .filter((name) => MIGRATION_NAME.test(name))
    .sort();
}

/**
 * A name after every one in `dir`, so files sort in the order they were made,
 * even when several are made within one second.
 */
export async function nextName(dir: string, words: string): Promise<string> {
  const latest = (await migrationNames(dir))
    .map((name) => Number(name.slice(0, name.indexOf('_'))))
    .reduce((a, b) => Math.max(a, b), 0);
  const seconds = Math.max(Math.floor(Date.now() / 1000), latest + 1);
  return `${seconds}_${slug(words)}`;
}

/** Writes the migration and rewrites the folder's index. */
export async function writeMigration(
  root: string,
  dir: string,
  name: string,
  source: string,
): Promise<string> {
  const folder = resolve(root, dir);
  await mkdir(folder, { recursive: true });
  const path = join(folder, `${name}.ts`);
  await writeFile(path, source, { flag: 'wx' });
  try {
    await writeIndex(folder, dir);
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
  return path;
}

/** Takes back a migration whose change did not commit. */
export async function removeMigration(
  root: string,
  dir: string,
  name: string,
): Promise<void> {
  const folder = resolve(root, dir);
  await rm(join(folder, `${name}.ts`), { force: true });
  await writeIndex(folder, dir);
}

async function writeIndex(folder: string, dir: string): Promise<void> {
  await writeFile(
    join(folder, 'index.ts'),
    indexTemplate(dir, await migrationNames(folder)),
  );
}

function slug(words: string): string {
  return (
    words
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'migration'
  );
}
