import type { Collection } from '@nextbasejs/client';
import type { DB, Tx } from '@nextbasejs/dbx';
import { ALPHANUMERIC, randomString } from '../random.ts';
import { superusersCollection } from '../schema/collection.ts';
import { loadCollections, saveCollectionRow } from '../schema/store.ts';
import { createCollectionTable } from '../schema/sync.ts';
import { renameRuleField } from './rename-rule-field.ts';
import { lockSchema, SCHEMA, table } from './system.ts';

// Postgres 16: pg_input_is_valid and the CREATEROLE rules view roles rely on.
const MIN_SERVER_VERSION = 160_000;

// Advisory lock a transaction takes as it commits realtime events, so their
// positions follow the commit order.
const REALTIME_LOCK = 7_163_845_122_002;

interface Migration {
  /**
   * Unique and permanent: never rename or remove a released migration. Change one only so
   * it succeeds where it failed, since databases that applied it never run it again.
   */
  name: string;
  up(tx: Tx): Promise<void>;
}

const MIGRATIONS: readonly Migration[] = [
  {
    name: '0001_init',
    async up(tx) {
      const exec = (sql: string): Promise<unknown> =>
        tx.newQuery(sql).execute();
      await exec(`
        CREATE TABLE {{${table('_meta')}}} (
          id             boolean PRIMARY KEY DEFAULT true CHECK (id),
          schema_version bigint NOT NULL DEFAULT 1,
          setup_secret   text NOT NULL
        )`);
      // Signs the one-time token that creates the first superuser.
      await tx
        .insert(table('_meta'), {
          setup_secret: randomString(50, ALPHANUMERIC),
        })
        .execute();
      await exec(`
        CREATE TABLE {{${table('_collections')}}} (
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
        `CREATE UNIQUE INDEX "_collections_name" ON {{${table('_collections')}}} (lower(name))`,
      );
      // Failed password logins per collection and identity, for throttling.
      await exec(`
        CREATE TABLE {{${table('_auth_attempts')}}} (
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
    name: '0002_sessions',
    async up(tx) {
      const exec = (sql: string): Promise<unknown> =>
        tx.newQuery(sql).execute();
      // Tokens are stored hashed; key_hash binds a session to its record's
      // tokenKey and collection secret.
      await exec(`
        CREATE TABLE {{${table('_sessions')}}} (
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
        `CREATE INDEX "_sessions_record" ON {{${table('_sessions')}}} (collection_id, record_id)`,
      );
      await exec(
        `CREATE INDEX "_sessions_expires" ON {{${table('_sessions')}}} (expires)`,
      );
    },
  },
  {
    name: '0003_parse_timestamptz',
    async up(tx) {
      // JSON to timestamp for filters, NULL when invalid; a missing zone means
      // UTC. PL/pgSQL so the planner never folds the casts of a constant.
      await tx
        .newQuery(
          `CREATE FUNCTION {{${table('parse_timestamptz')}}}(value text)
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
    name: '0004_view_collections',
    async up(tx) {
      await tx
        .newQuery(
          `ALTER TABLE {{${table('_collections')}}}
             DROP CONSTRAINT "_collections_type_check",
             ADD CONSTRAINT "_collections_type_check" CHECK (type IN ('base', 'auth', 'view'))`,
        )
        .execute();
      // The role view collections run as, created with the first view.
      await tx
        .newQuery(`ALTER TABLE {{${table('_meta')}}} ADD COLUMN view_role text`)
        .execute();
    },
  },
  {
    name: '0005_oauth2',
    async up(tx) {
      const exec = (sql: string): Promise<unknown> =>
        tx.newQuery(sql).execute();
      // Keyed by a hash of the state the browser holds in a cookie, so a
      // database leak cannot finish anyone's sign-in.
      await exec(`
        CREATE TABLE {{${table('_oauth2_states')}}} (
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
        CREATE TABLE {{${table('_linked_accounts')}}} (
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
    name: '0006_phone',
    async up(tx) {
      // One live code per phone and purpose, stored hashed.
      await tx
        .newQuery(
          `CREATE TABLE {{${table('_phone_codes')}}} (
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
      await renameClashingUserFields(tx, 'phone', '_phone');
      await renameClashingUserFields(tx, 'phoneVerified', '_phoneVerified');
      // Adds phone fields and phoneSignIn to auth collections created before them.
      const collections = await tx
        .newQuery(
          `SELECT id, name, fields FROM {{${table('_collections')}}} WHERE type = 'auth'`,
        )
        .all<{ id: string; name: string; fields: { id: string }[] }>();
      let changed = false;
      for (const { id, name, fields } of collections) {
        if (fields.some((f) => f.id === '_phone')) continue;
        changed = true;
        fields.splice(
          fields.findIndex((f) => f.id === '_verified') + 1,
          0,
          {
            id: '_phone',
            name: 'phone',
            type: 'phone',
            system: true,
            required: false,
            hidden: false,
          } as { id: string },
          {
            id: '_phoneVerified',
            name: 'phoneVerified',
            type: 'bool',
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
            `UPDATE {{${table('_collections')}}}
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
            `UPDATE {{${table('_meta')}}} SET schema_version = schema_version + 1`,
          )
          .execute();
      }
    },
  },
  {
    name: '0007_email_verified',
    async up(tx) {
      // `verified` becomes `emailVerified`. The id stays, so indexes survive;
      // rules referring to it are rewritten.
      await renameClashingUserFields(tx, 'emailVerified', '_verified');
      const collections = await loadCollections(tx);
      const auth = collections.filter(
        (c) =>
          c.type === 'auth' &&
          c.fields.some((f) => f.id === '_verified' && f.name === 'verified'),
      );
      if (auth.length === 0) return;
      const rename = (rule: string | null, c: Collection): string | null =>
        rule === null
          ? null
          : renameRuleField(
              rule,
              c,
              collections,
              'verified',
              'emailVerified',
              (owner) => auth.includes(owner),
            );
      for (const c of collections) {
        const renamed = {
          ...c,
          listRule: rename(c.listRule, c),
          viewRule: rename(c.viewRule, c),
          createRule: rename(c.createRule, c),
          updateRule: rename(c.updateRule, c),
          deleteRule: rename(c.deleteRule, c),
          ...(c.type === 'auth' && {
            authRule: rename(c.authRule, c),
            manageRule: rename(c.manageRule, c),
            fields: c.fields.map((f) =>
              f.id === '_verified' ? { ...f, name: 'emailVerified' } : f,
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
          `UPDATE {{${table('_meta')}}} SET schema_version = schema_version + 1`,
        )
        .execute();
    },
  },
  {
    name: '0008_uploads',
    async up(tx) {
      // Direct uploads awaiting a record, each for one file field and exact
      // size, until it expires.
      await tx
        .newQuery(
          `CREATE TABLE {{${table('_uploads')}}} (
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
          `CREATE INDEX "_uploads_expires" ON {{${table('_uploads')}}} (expires)`,
        )
        .execute();
    },
  },
  {
    name: '0009_expiry_indexes',
    async up(tx) {
      // Expired rows are deleted on every sign-in attempt, OAuth2 sign-in and texted code;
      // these indexes let each delete find them without reading the whole table.
      await tx
        .newQuery(
          `CREATE INDEX "_auth_attempts_window_end" ON {{${table('_auth_attempts')}}} (window_end)`,
        )
        .execute();
      await tx
        .newQuery(
          `CREATE INDEX "_oauth2_states_expires" ON {{${table('_oauth2_states')}}} (expires)`,
        )
        .execute();
      await tx
        .newQuery(
          `CREATE INDEX "_phone_codes_expires" ON {{${table('_phone_codes')}}} (expires)`,
        )
        .execute();
    },
  },
  {
    name: '0010_realtime',
    async up(tx) {
      const exec = (sql: string): Promise<unknown> =>
        tx.newQuery(sql).execute();
      // A transaction that writes to realtime collections, with the position
      // it takes when it commits. Its events are in `_realtime_events`.
      await exec(`CREATE SEQUENCE {{${table('_realtime_transaction_ids')}}}`);
      await exec(`CREATE SEQUENCE {{${table('_realtime_positions')}}}`);
      await exec(`
        CREATE TABLE {{${table('_realtime_transactions')}}} (
          id        bigint PRIMARY KEY,
          position  bigint UNIQUE,
          committed timestamptz
        )`);
      await exec(
        `CREATE INDEX "_realtime_transactions_committed" ON {{${table('_realtime_transactions')}}} (committed)`,
      );
      await exec(`
        CREATE TABLE {{${table('_realtime_events')}}} (
          transaction_id bigint NOT NULL,
          seq            bigserial,
          collection_id  text NOT NULL,
          action         text NOT NULL,
          record_id      text NOT NULL,
          record         jsonb NOT NULL,
          PRIMARY KEY (transaction_id, seq)
        )`);
      // Runs as the transaction commits, holding the lock until the commit is done, so
      // positions are taken, and become visible, in commit order.
      await exec(`
        CREATE FUNCTION {{${table('_realtime_commit')}}}() RETURNS trigger
        LANGUAGE plpgsql SET search_path = '' AS $$
        BEGIN
          PERFORM pg_catalog.pg_advisory_xact_lock(${REALTIME_LOCK});
          UPDATE ${table('_realtime_transactions')}
          SET position = pg_catalog.nextval('${table('_realtime_positions')}'),
              committed = pg_catalog.clock_timestamp()
          WHERE id = NEW.id;
          RETURN NULL;
        END
        $$`);
      await exec(`
        CREATE CONSTRAINT TRIGGER "_realtime_commit"
        AFTER INSERT ON {{${table('_realtime_transactions')}}}
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION {{${table('_realtime_commit')}}}()`);
      // The last event deleted as too old, so readers behind it learn they
      // may have missed events.
      await exec(`
        CREATE TABLE {{${table('_realtime_state')}}} (
          id              boolean PRIMARY KEY DEFAULT true CHECK (id),
          purged_position bigint NOT NULL DEFAULT 0,
          purged_seq      bigint NOT NULL DEFAULT 0
        )`);
      await exec(`INSERT INTO {{${table('_realtime_state')}}} DEFAULT VALUES`);
    },
  },
  {
    name: '0011_logs',
    async up(tx) {
      const exec = (sql: string): Promise<unknown> =>
        tx.newQuery(sql).execute();
      // Request logs and background failures. The index serves the default
      // newest-first listing and the deletes of expired entries.
      await exec(`
        CREATE TABLE {{${table('_logs')}}} (
          id      text PRIMARY KEY,
          created timestamptz NOT NULL DEFAULT now(),
          level   smallint NOT NULL,
          message text NOT NULL,
          data    jsonb NOT NULL DEFAULT '{}'
        )`);
      await exec(
        `CREATE INDEX "_logs_created" ON {{${table('_logs')}}} (created, id)`,
      );
    },
  },
  {
    name: '0012_rate_limits',
    async up(tx) {
      const exec = (sql: string): Promise<unknown> =>
        tx.newQuery(sql).execute();
      // Requests per caller and rule in the current window. Unlogged, since a crash only resets
      // short-lived counts; free page space lets updates stay HOT, in place.
      await exec(`
        CREATE UNLOGGED TABLE {{${table('_rate_limits')}}} (
          key        text PRIMARY KEY,
          hits       integer NOT NULL,
          window_end timestamptz NOT NULL
        ) WITH (fillfactor = 70)`);
      await exec(
        `CREATE INDEX "_rate_limits_window_end" ON {{${table('_rate_limits')}}} (window_end)`,
      );
    },
  },
  {
    name: '0013_impersonation',
    async up(tx) {
      // Set on sessions a superuser started to act as the record: who, and
      // a hash of their key then, so the session ends with their own key.
      await tx
        .newQuery(
          `ALTER TABLE {{${table('_sessions')}}}
             ADD COLUMN impersonator_id text NULL,
             ADD COLUMN impersonator_key_hash text NULL`,
        )
        .execute();
    },
  },
  {
    name: '0014_mfa',
    async up(tx) {
      const exec = (sql: string): Promise<unknown> =>
        tx.newQuery(sql).execute();
      // Sign-ins waiting for their second step, by a hash of their id. The
      // key hash ties one to the record's key, so a new password ends it.
      await exec(`
        CREATE TABLE {{${table('_mfas')}}} (
          id_hash       text PRIMARY KEY,
          collection_id text NOT NULL,
          record_id     text NOT NULL,
          key_hash      text NOT NULL,
          method        text NOT NULL,
          attempts      integer NOT NULL DEFAULT 0,
          code_hash     text NULL,
          code_channel  text NULL,
          expires       timestamptz NOT NULL
        )`);
      await exec(
        `CREATE INDEX "_mfas_expires" ON {{${table('_mfas')}}} (expires)`,
      );
      await exec(
        `CREATE INDEX "_mfas_record" ON {{${table('_mfas')}}} (collection_id, record_id)`,
      );
      // One authenticator app per record, its secret encrypted. Unconfirmed
      // until the record enters a code from it.
      await exec(`
        CREATE TABLE {{${table('_totp')}}} (
          collection_id text NOT NULL,
          record_id     text NOT NULL,
          secret        text NOT NULL,
          last_step     bigint NOT NULL DEFAULT 0,
          confirmed     timestamptz NULL,
          created       timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (collection_id, record_id)
        )`);
      await exec(`
        CREATE TABLE {{${table('_recovery_codes')}}} (
          collection_id text NOT NULL,
          record_id     text NOT NULL,
          code_hash     text NOT NULL,
          PRIMARY KEY (collection_id, record_id, code_hash)
        )`);
      // Single-use tokens already used, such as the link a verified inbox
      // approves an email change with, until they expire.
      await exec(`
        CREATE TABLE {{${table('_used_tokens')}}} (
          id_hash text PRIMARY KEY,
          expires timestamptz NOT NULL
        )`);
      await exec(
        `CREATE INDEX "_used_tokens_expires" ON {{${table('_used_tokens')}}} (expires)`,
      );
      // How each password was last set, so a reset by email or text cannot
      // pair with a code sent to the same place. No row means chosen.
      await exec(`
        CREATE TABLE {{${table('_password_origins')}}} (
          collection_id text NOT NULL,
          record_id     text NOT NULL,
          origin        text NOT NULL,
          set_at        timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (collection_id, record_id)
        )`);
      await exec(
        `ALTER TABLE {{${table('_sessions')}}} ADD COLUMN methods text[] NOT NULL DEFAULT '{}'`,
      );
      await exec(
        `ALTER TABLE {{${table('_oauth2_states')}}} ADD COLUMN mfa_id text NULL`,
      );
    },
  },
  {
    name: '0015_oauth2',
    async up(tx) {
      // What the app passed to a sign-in, for `mapProfile`, and the scopes
      // it asked for, kept when the provider does not say which it granted.
      await tx
        .newQuery(
          `ALTER TABLE {{${table('_oauth2_states')}}}
             ADD COLUMN data jsonb NULL,
             ADD COLUMN scope text NULL`,
        )
        .execute();
      // A provider's tokens, sealed with secretKey, when it stores them.
      await tx
        .newQuery(
          `ALTER TABLE {{${table('_linked_accounts')}}}
             ADD COLUMN access_token text NULL,
             ADD COLUMN refresh_token text NULL,
             ADD COLUMN token_expires timestamptz NULL,
             ADD COLUMN scopes text[] NULL,
             ADD COLUMN tokens_saved timestamptz NULL,
             ADD COLUMN refreshing_until timestamptz NULL`,
        )
        .execute();
    },
  },
  {
    name: '0016_otps',
    async up(tx) {
      // Codes emailed for a sign-in without a password, kept hashed.
      await tx
        .newQuery(
          `CREATE TABLE {{${table('_otps')}}} (
             id_hash       text PRIMARY KEY,
             collection_id text NOT NULL,
             record_id     text NULL,
             email         text NOT NULL,
             code_hash     text NOT NULL,
             attempts      integer NOT NULL DEFAULT 0,
             expires       timestamptz NOT NULL
           )`,
        )
        .execute();
      await tx
        .newQuery(
          `CREATE INDEX "_otps_expires" ON {{${table('_otps')}}} (expires)`,
        )
        .execute();
    },
  },
];

/**
 * Before auth collections get the system field `name`, moves a user field of that name
 * (case-insensitively) to `user_<name>`: column, definition, identity fields and rules.
 */
async function renameClashingUserFields(
  tx: Tx,
  name: string,
  systemId: string,
): Promise<void> {
  const collections = await loadCollections(tx);
  const auth = collections.filter((c) => c.type === 'auth');
  const clashes = auth.flatMap((c) =>
    c.fields
      .filter(
        (f) => f.id !== systemId && f.name.toLowerCase() === name.toLowerCase(),
      )
      .map((field) => ({ collection: c, field })),
  );
  if (clashes.length === 0) return;
  // One name free in every auth collection, so `@request.auth.<name>` still
  // means the same field wherever it is renamed.
  const taken = new Set(
    auth.flatMap((c) => c.fields.map((f) => f.name.toLowerCase())),
  );
  let to = `user_${name}`;
  for (let i = 2; taken.has(to.toLowerCase()); i++) to = `user_${name}${i}`;

  let renamed = collections;
  for (const from of new Set(clashes.map((c) => c.field.name))) {
    const owners = new Set(
      clashes.filter((c) => c.field.name === from).map((c) => c.collection.id),
    );
    const rename = (rule: string | null, c: Collection): string | null =>
      rule === null
        ? null
        : renameRuleField(rule, c, renamed, from, to, (owner) =>
            owners.has(owner.id),
          );
    renamed = renamed.map(
      (c) =>
        ({
          ...c,
          listRule: rename(c.listRule, c),
          viewRule: rename(c.viewRule, c),
          createRule: rename(c.createRule, c),
          updateRule: rename(c.updateRule, c),
          deleteRule: rename(c.deleteRule, c),
          ...(c.type === 'auth' && {
            authRule: rename(c.authRule, c),
            manageRule: rename(c.manageRule, c),
          }),
        }) as Collection,
    );
  }
  for (const { collection, field } of clashes) {
    await tx
      .newQuery(
        `ALTER TABLE {{${table(collection.name)}}} RENAME COLUMN ${tx.quoteSimpleColumnName(field.name)} TO ${tx.quoteSimpleColumnName(to)}`,
      )
      .execute();
    console.warn(
      `[nextbase] The ${collection.name} collection's field "${field.name}" is renamed to "${to}", along with the rules that use it, because NextBase now has a system field "${name}".`,
    );
  }
  for (const c of renamed) {
    const own = clashes.filter((x) => x.collection.id === c.id);
    if (c.type !== 'auth' || own.length === 0) {
      await saveCollectionRow(tx, c);
      continue;
    }
    const ids = new Set(own.map((x) => x.field.id));
    const old = new Set(own.map((x) => x.field.name));
    await saveCollectionRow(tx, {
      ...c,
      fields: c.fields.map((f) => (ids.has(f.id) ? { ...f, name: to } : f)),
      identityFields: c.identityFields.map((n) => (old.has(n) ? to : n)),
    });
  }
  await tx
    .newQuery(
      `UPDATE {{${table('_meta')}}} SET schema_version = schema_version + 1`,
    )
    .execute();
}

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
      .newQuery('SELECT 1 FROM pg_namespace WHERE nspname = {:schema}')
      .bind({ schema: SCHEMA })
      .column();
    if (exists.length === 0) {
      await tx.newQuery(`CREATE SCHEMA {{${SCHEMA}}}`).execute();
    }
    await tx
      .newQuery(
        `CREATE TABLE IF NOT EXISTS {{${table('_migrations')}}} (
          name    text PRIMARY KEY,
          applied timestamptz NOT NULL DEFAULT now()
        )`,
      )
      .execute();
    const applied = new Set(
      await tx.select('name').from(table('_migrations')).column<string>(),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.name)) continue;
      await migration.up(tx);
      await tx.insert(table('_migrations'), { name: migration.name }).execute();
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
  if (!dateStyle.startsWith('ISO'))
    problems.push(`DateStyle is "${dateStyle}"; set it to 'ISO, MDY'`);
  if (standardStrings !== 'on')
    problems.push('standard_conforming_strings is off; turn it on');
  if (problems.length > 0) {
    throw new Error(
      `NextBase cannot use this database: ${problems.join(', and ')} (for example with ALTER DATABASE ... SET).`,
    );
  }
}

// The common case on every cold start: one read, no lock.
async function isUpToDate(db: DB): Promise<boolean> {
  try {
    const applied = await db
      .select('name')
      .from(table('_migrations'))
      .column<string>();
    const names = new Set(applied);
    return MIGRATIONS.every((m) => names.has(m.name));
  } catch (error) {
    // 42P01 undefined_table, 3F000 invalid_schema_name: a fresh database.
    const code = (error as { code?: unknown }).code;
    if (code === '42P01' || code === '3F000') return false;
    throw error;
  }
}
