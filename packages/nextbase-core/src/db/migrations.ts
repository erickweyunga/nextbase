import type { DB, Tx } from "@nextbasejs/dbx";
import { ALPHANUMERIC, randomString } from "../random.ts";
import { superusersCollection } from "../schema/collection.ts";
import { saveCollectionRow } from "../schema/store.ts";
import { createCollectionTable } from "../schema/sync.ts";
import { lockSchema, SCHEMA, table } from "./system.ts";

/** Postgres 16: pg_input_is_valid, and the CREATEROLE rules view roles rely on. */
const MIN_SERVER_VERSION = 160_000;

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
  {
    name: "0002_sessions",
    async up(tx) {
      const exec = (sql: string): Promise<unknown> =>
        tx.newQuery(sql).execute();
      // Signed-in sessions of auth records. Tokens are stored as SHA-256
      // hashes; key_hash binds a session to its record's tokenKey and its
      // collection's auth secret (see auth/sessions.ts).
      await exec(`
        CREATE TABLE {{${table("_sessions")}}} (
          id            text PRIMARY KEY,
          token_hash    text NOT NULL UNIQUE,
          collection_id text NOT NULL,
          record_id     text NOT NULL,
          key_hash      text NOT NULL,
          user_agent    text NOT NULL DEFAULT '',
          created       timestamptz NOT NULL DEFAULT now(),
          expires       timestamptz NOT NULL
        )`);
      await exec(
        `CREATE INDEX "_sessions_record" ON {{${table("_sessions")}}} (collection_id, record_id)`,
      );
      await exec(
        `CREATE INDEX "_sessions_expires" ON {{${table("_sessions")}}} (expires)`,
      );
    },
  },
  {
    name: "0003_parse_timestamptz",
    async up(tx) {
      // Reads an ISO 8601 timestamp from JSON, for filters comparing JSON
      // values with dates. Returns NULL for anything else or an impossible
      // date, checked with pg_input_is_valid rather than by failing a cast.
      // A missing zone means UTC, as NextBase stores dates. PL/pgSQL rather
      // than SQL, so the planner never folds the casts of a constant.
      await tx
        .newQuery(
          `CREATE FUNCTION {{${table("parse_timestamptz")}}}(value text)
           RETURNS timestamptz LANGUAGE plpgsql STABLE STRICT PARALLEL SAFE AS $fn$
           BEGIN
             IF value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)?)?$' THEN
               RETURN NULL;
             END IF;
             IF value ~ '[T ][0-9:.]+(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' THEN
               IF pg_input_is_valid(value, 'timestamptz') THEN
                 RETURN value::timestamptz;
               END IF;
               RETURN NULL;
             END IF;
             IF pg_input_is_valid(value, 'timestamp') THEN
               RETURN value::timestamp AT TIME ZONE 'UTC';
             END IF;
             RETURN NULL;
           END
           $fn$`,
        )
        .execute();
    },
  },
  {
    name: "0004_view_collections",
    async up(tx) {
      await tx
        .newQuery(
          `ALTER TABLE {{${table("_collections")}}}
             DROP CONSTRAINT "_collections_type_check",
             ADD CONSTRAINT "_collections_type_check" CHECK (type IN ('base', 'auth', 'view'))`,
        )
        .execute();
      // The role view collections run as, created with the first view.
      await tx
        .newQuery(`ALTER TABLE {{${table("_meta")}}} ADD COLUMN view_role text`)
        .execute();
    },
  },
  {
    name: "0005_oauth2",
    async up(tx) {
      const exec = (sql: string): Promise<unknown> =>
        tx.newQuery(sql).execute();
      // OAuth2 sign-ins in progress, one per redirect to a provider. Keyed by
      // the SHA-256 of the state the browser also holds in a cookie, so a
      // database leak cannot finish anyone's sign-in (see auth/oauth2.ts).
      await exec(`
        CREATE TABLE {{${table("_oauth2_states")}}} (
          id             text PRIMARY KEY,
          collection_id  text NOT NULL,
          provider       text NOT NULL,
          code_verifier  text NOT NULL,
          nonce          text NOT NULL,
          redirect       text NOT NULL,
          error_redirect text NOT NULL,
          link_record_id text,
          expires        timestamptz NOT NULL
        )`);
      // Provider accounts linked to auth records: at most one per provider
      // and record, and each provider account to one record.
      await exec(`
        CREATE TABLE {{${table("_external_auths")}}} (
          id            text PRIMARY KEY,
          collection_id text NOT NULL,
          record_id     text NOT NULL,
          provider      text NOT NULL,
          provider_id   text NOT NULL,
          created       timestamptz NOT NULL DEFAULT now(),
          UNIQUE (collection_id, provider, provider_id),
          UNIQUE (collection_id, record_id, provider)
        )`);
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
  const [dateStyle, standardStrings, version] = await db
    .newQuery(
      "SELECT current_setting('DateStyle'), current_setting('standard_conforming_strings'), current_setting('server_version_num')::int",
    )
    .row<[string, string, number]>();
  if (version < MIN_SERVER_VERSION) {
    throw new Error(
      `NextBase cannot use this database: it runs Postgres ${Math.floor(version / 10_000)}, and NextBase needs Postgres 16 or newer.`,
    );
  }
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
