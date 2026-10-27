import type { Collection } from "@nextbasejs/client";
import type { DB, Tx } from "@nextbasejs/dbx";
import { ALPHANUMERIC, randomString } from "../random.ts";
import { superusersCollection } from "../schema/collection.ts";
import { loadCollections, saveCollectionRow } from "../schema/store.ts";
import { createCollectionTable } from "../schema/sync.ts";
import { renameRuleField } from "./rename-rule-field.ts";
import { lockSchema, SCHEMA, table } from "./system.ts";

// Postgres 16: pg_input_is_valid and the CREATEROLE rules view roles rely on.
const MIN_SERVER_VERSION = 160_000;

interface Migration {
  /** Unique and permanent: never edit or remove a released migration. */
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
      // Tokens are stored hashed; key_hash binds a session to its record's
      // tokenKey and collection secret.
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
      // JSON to timestamp for filters, NULL when invalid; a missing zone means
      // UTC. PL/pgSQL so the planner never folds the casts of a constant.
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
      // Keyed by a hash of the state the browser holds in a cookie, so a
      // database leak cannot finish anyone's sign-in.
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
      // At most one per provider and record; each provider account to one record.
      await exec(`
        CREATE TABLE {{${table("_linked_accounts")}}} (
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
  {
    name: "0006_phone",
    async up(tx) {
      // One live code per phone and purpose, stored hashed.
      await tx
        .newQuery(
          `CREATE TABLE {{${table("_phone_codes")}}} (
             collection_id text NOT NULL,
             phone         text NOT NULL,
             purpose       text NOT NULL,
             record_id     text NOT NULL DEFAULT '',
             code_hash     text NOT NULL,
             attempts      integer NOT NULL DEFAULT 0,
             expires       timestamptz NOT NULL,
             PRIMARY KEY (collection_id, phone, purpose)
           )`,
        )
        .execute();
      // Adds phone fields and phoneSignIn to auth collections created before them.
      const collections = await tx
        .newQuery(
          `SELECT id, name, fields FROM {{${table("_collections")}}} WHERE type = 'auth'`,
        )
        .all<{ id: string; name: string; fields: { id: string }[] }>();
      let changed = false;
      for (const { id, name, fields } of collections) {
        if (fields.some((f) => f.id === "_phone")) continue;
        changed = true;
        fields.splice(
          fields.findIndex((f) => f.id === "_verified") + 1,
          0,
          {
            id: "_phone",
            name: "phone",
            type: "phone",
            system: true,
            required: false,
            hidden: false,
          } as { id: string },
          {
            id: "_phoneVerified",
            name: "phoneVerified",
            type: "bool",
            system: true,
            required: false,
            hidden: false,
          } as { id: string },
        );
        const t = `{{${table(name)}}}`;
        await tx
          .newQuery(
            `ALTER TABLE ${t}
               ADD COLUMN "phone" text NOT NULL DEFAULT '',
               ADD COLUMN "phoneVerified" boolean NOT NULL DEFAULT false`,
          )
          .execute();
        await tx
          .newQuery(
            `CREATE UNIQUE INDEX ${tx.quoteSimpleColumnName(`_${id}_phone`)} ON ${t} ("phone") WHERE "phone" <> ''`,
          )
          .execute();
        await tx
          .newQuery(
            `UPDATE {{${table("_collections")}}}
             SET fields = {:fields}::jsonb, options = options || '{"phoneSignIn": false}'::jsonb
             WHERE id = {:id}`,
          )
          .bind({ id, fields: JSON.stringify(fields) })
          .execute();
      }
      // Instances that cached the old definitions reload them.
      if (changed) {
        await tx
          .newQuery(
            `UPDATE {{${table("_meta")}}} SET schema_version = schema_version + 1`,
          )
          .execute();
      }
    },
  },
  {
    name: "0007_email_verified",
    async up(tx) {
      // `verified` becomes `emailVerified`. The id stays, so indexes survive;
      // rules referring to it are rewritten.
      const collections = await loadCollections(tx);
      const auth = collections.filter(
        (c) =>
          c.type === "auth" &&
          c.fields.some((f) => f.id === "_verified" && f.name === "verified"),
      );
      if (auth.length === 0) return;
      const rename = (rule: string | null, c: Collection): string | null =>
        rule === null
          ? null
          : renameRuleField(rule, c, collections, "verified", "emailVerified");
      for (const c of collections) {
        const renamed = {
          ...c,
          listRule: rename(c.listRule, c),
          viewRule: rename(c.viewRule, c),
          createRule: rename(c.createRule, c),
          updateRule: rename(c.updateRule, c),
          deleteRule: rename(c.deleteRule, c),
          ...(c.type === "auth" && {
            authRule: rename(c.authRule, c),
            manageRule: rename(c.manageRule, c),
            fields: c.fields.map((f) =>
              f.id === "_verified" ? { ...f, name: "emailVerified" } : f,
            ),
          }),
        } as Collection;
        if (auth.includes(c)) {
          await tx
            .newQuery(
              `ALTER TABLE {{${table(c.name)}}} RENAME COLUMN "verified" TO "emailVerified"`,
            )
            .execute();
        }
        await saveCollectionRow(tx, renamed);
      }
      await tx
        .newQuery(
          `UPDATE {{${table("_meta")}}} SET schema_version = schema_version + 1`,
        )
        .execute();
    },
  },
  {
    name: "0008_uploads",
    async up(tx) {
      // Direct uploads awaiting a record, each for one file field and exact
      // size, until it expires.
      await tx
        .newQuery(
          `CREATE TABLE {{${table("_uploads")}}} (
             id            text PRIMARY KEY,
             collection_id text NOT NULL,
             field_id      text NOT NULL,
             filename      text NOT NULL,
             size          bigint NOT NULL,
             content_type  text NOT NULL,
             expires       timestamptz NOT NULL
           )`,
        )
        .execute();
      await tx
        .newQuery(
          `CREATE INDEX "_uploads_expires" ON {{${table("_uploads")}}} (expires)`,
        )
        .execute();
    },
  },
];

// Safe to run concurrently: one transaction under the schema lock, skipped
// without locking when already up to date.
export async function migrate(db: DB): Promise<void> {
  await checkSettings(db);
  if (await isUpToDate(db)) return;
  await db.transaction(async (tx) => {
    await lockSchema(tx);
    // CREATE SCHEMA IF NOT EXISTS needs database CREATE even if the schema
    // exists, which restricted roles lack.
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

// Fails fast rather than misreading data later: timestamps are parsed as ISO
// and literals assume standard strings.
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
