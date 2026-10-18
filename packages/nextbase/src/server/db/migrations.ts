import type { DB, Tx } from "@nextbase/dbx";
import { ALPHANUMERIC, randomString } from "../random.ts";
import { superusersCollection } from "../schema/collection.ts";
import { saveCollectionRow } from "../schema/store.ts";
import { createCollectionTable } from "../schema/sync.ts";
import { lockSchema, SCHEMA, table } from "./system.ts";

interface Migration {
  /** Unique and permanent. A released migration is never edited or removed. */
  name: string;
  up(tx: Tx): Promise<void>;
}

const MIGRATIONS: readonly Migration[] = [
  {
    name: "0001_init",
    async up(tx) {
      const exec = (sql: string): Promise<unknown> =>
        tx.newQuery(sql).execute();
      await exec(`
        CREATE TABLE {{${table("_meta")}}} (
          id             boolean PRIMARY KEY DEFAULT true CHECK (id),
          schema_version bigint NOT NULL DEFAULT 1,
          setup_secret   text NOT NULL
        )`);
      // Signs the one-time token that creates the first superuser.
      await tx
        .insert(table("_meta"), {
          setup_secret: randomString(50, ALPHANUMERIC),
        })
        .execute();
      await exec(`
        CREATE TABLE {{${table("_collections")}}} (
          id          text PRIMARY KEY,
          type        text NOT NULL CHECK (type IN ('base', 'auth')),
          name        text NOT NULL,
          system      boolean NOT NULL DEFAULT false,
          fields      jsonb NOT NULL,
          indexes     jsonb NOT NULL DEFAULT '[]',
          options     jsonb NOT NULL DEFAULT '{}',
          list_rule   text,
          view_rule   text,
          create_rule text,
          update_rule text,
          delete_rule text,
          created     timestamptz NOT NULL DEFAULT now(),
          updated     timestamptz NOT NULL DEFAULT now()
        )`);
      await exec(
        `CREATE UNIQUE INDEX "_collections_name" ON {{${table("_collections")}}} (lower(name))`,
      );
      // Failed password logins per collection and identity, for throttling.
      await exec(`
        CREATE TABLE {{${table("_auth_attempts")}}} (
          key        text PRIMARY KEY,
          failures   integer NOT NULL,
          window_end timestamptz NOT NULL
        )`);
      const superusers = superusersCollection();
      await createCollectionTable(tx, superusers, []);
      await saveCollectionRow(tx, superusers);
    },
  },
];

/**
 * Brings the system tables up to date. Safe to call from many instances at
 * once: the work runs in one transaction under the schema lock, and instances
 * that find nothing to do return without taking it.
 */
export async function migrate(db: DB): Promise<void> {
  await checkSettings(db);
  if (await isUpToDate(db)) return;
  await db.transaction(async (tx) => {
    await lockSchema(tx);
    // Checked first: CREATE SCHEMA IF NOT EXISTS needs the database-level CREATE
    // privilege even when the schema exists, which restricted roles lack.
    const exists = await tx
      .newQuery("SELECT 1 FROM pg_namespace WHERE nspname = {:schema}")
      .bind({ schema: SCHEMA })
      .column();
    if (exists.length === 0) {
      await tx.newQuery(`CREATE SCHEMA {{${SCHEMA}}}`).execute();
    }
    await tx
      .newQuery(
        `CREATE TABLE IF NOT EXISTS {{${table("_migrations")}}} (
          name    text PRIMARY KEY,
          applied timestamptz NOT NULL DEFAULT now()
        )`,
      )
      .execute();
    const applied = new Set(
      await tx.select("name").from(table("_migrations")).column<string>(),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.name)) continue;
      await migration.up(tx);
      await tx.insert(table("_migrations"), { name: migration.name }).execute();
    }
  });
}

/**
 * Fails fast on server settings NextBase depends on, rather than misreading
 * data later: timestamps are parsed from ISO output, and quoted literals
 * assume standard strings. Database- or role-level settings apply to every
 * connection, so checking one is enough.
 */
async function checkSettings(db: DB): Promise<void> {
  const [dateStyle, standardStrings] = await db
    .newQuery(
      "SELECT current_setting('DateStyle'), current_setting('standard_conforming_strings')",
    )
    .row<[string, string]>();
  const problems: string[] = [];
  if (!dateStyle.startsWith("ISO"))
    problems.push(`DateStyle is "${dateStyle}"; set it to 'ISO, MDY'`);
  if (standardStrings !== "on")
    problems.push("standard_conforming_strings is off; turn it on");
  if (problems.length > 0) {
    throw new Error(
      `NextBase cannot use this database: ${problems.join(", and ")} (for example with ALTER DATABASE ... SET).`,
    );
  }
}

// The common case on every cold start: one read, no lock.
async function isUpToDate(db: DB): Promise<boolean> {
  try {
    const applied = await db
      .select("name")
      .from(table("_migrations"))
      .column<string>();
    const names = new Set(applied);
    return MIGRATIONS.every((m) => names.has(m.name));
  } catch (error) {
    // 42P01 undefined_table, 3F000 invalid_schema_name: a fresh database.
    const code = (error as { code?: unknown }).code;
    if (code === "42P01" || code === "3F000") return false;
    throw error;
  }
}
