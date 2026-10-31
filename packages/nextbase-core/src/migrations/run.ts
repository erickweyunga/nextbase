import { type Builder, type DB, hash, type Tx } from '@nextbasejs/dbx';
import { lockSchema, table } from '../db/system.ts';
import { Effects } from '../effects.ts';
import { type JoinMigration, type MigrationRun, migrationRun } from './app.ts';
import type { Migration, Migrations } from './define.ts';

/** What a migration leaves to do once it commits. */
export type AfterMigration = (run: MigrationRun, effects: Effects) => void;

/**
 * Runs the pending migrations in name order, each in its own transaction under the
 * schema lock. Safe to run concurrently; a failure stops the run.
 */
export async function runMigrations(
  db: DB,
  list: Migrations,
  joined: JoinMigration,
  after: AfterMigration,
): Promise<void> {
  const names = Object.keys(list.files).sort();
  // The common case on every cold start: one read, no lock.
  const applied = new Set(await appliedNames(db));
  for (const name of names) {
    if (applied.has(name)) continue;
    await step(db, name, joined, after, async (tx, run) => {
      if ((await appliedNames(tx, name)).length > 0) return false;
      await (list.files[name] as Migration).up(run.app);
      await tx.insert(table('_app_migrations'), { name }).execute();
      return true;
    });
  }
}

/** Runs `down` of the last `count` applied migrations, newest first. */
export async function revertMigrations(
  db: DB,
  list: Migrations,
  count: number,
  joined: JoinMigration,
  after: AfterMigration,
): Promise<string[]> {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError('Revert at least one migration.');
  }
  const reverted: string[] = [];
  for (let i = 0; i < count; i++) {
    const [name] = await db
      .newQuery(
        `SELECT name FROM {{${table('_app_migrations')}}}
         ORDER BY applied DESC, name DESC LIMIT 1`,
      )
      .column<string>();
    if (name === undefined) break;
    const migration = list.files[name];
    if (!migration?.down) {
      throw new Error(
        migration
          ? `The migration ${name} has no down function to revert it with.`
          : `The migration ${name} is applied but not among the app's migrations.`,
      );
    }
    await step(db, name, joined, after, async (tx, run) => {
      const deleted = await tx
        .newQuery(
          `DELETE FROM {{${table('_app_migrations')}}} WHERE name = {:name} RETURNING 1`,
        )
        .bind({ name })
        .column();
      if (deleted.length === 0) return false;
      await migration.down?.(run.app);
      return true;
    });
    reverted.push(name);
  }
  return reverted;
}

async function step(
  db: DB,
  name: string,
  joined: JoinMigration,
  after: AfterMigration,
  work: (tx: Tx, run: MigrationRun) => Promise<boolean>,
): Promise<void> {
  const effects = new Effects();
  let done: MigrationRun | undefined;
  try {
    await db.transaction(async (tx) => {
      await lockSchema(tx);
      const run = await migrationRun(tx, name, effects, joined);
      try {
        if (await work(tx, run)) done = run;
      } finally {
        await run.close();
      }
    });
  } catch (error) {
    throw new Error(
      `The migration ${name} failed, and none of its changes were kept: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (done) {
    effects.commit();
    after(done, effects);
  }
}

async function appliedNames(q: Builder, name?: string): Promise<string[]> {
  const query = q.select('name').from(table('_app_migrations'));
  return (
    name === undefined ? query : query.where(hash({ name }))
  ).column<string>();
}
