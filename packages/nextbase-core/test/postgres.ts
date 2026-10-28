import { randomUUID } from "node:crypto";
import { DB } from "@nextbasejs/dbx";
import pg from "pg";

const url =
  process.env.NEXTBASE_TEST_DATABASE_URL ??
  "postgres://localhost/nextbase_test";

export interface TestDatabase {
  db: DB;
  pool: pg.Pool;
  /** Connection string of the database. */
  url: string;
  close(): Promise<void>;
}

const PREFIX = "nextbase_test";
/** Databases older than this are left over from runs that were interrupted. */
const STALE_MS = 60 * 60 * 1000;

/**
 * The creation time, in base 36, and a random part: `lmqx1k2a_9f3c0b7d`.
 * The time lets a later run tell a leftover from a database in use.
 */
function uniqueSuffix(): string {
  return `${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function isStale(name: string): boolean {
  const time = /_([0-9a-z]+)_[0-9a-f]{8}$/.exec(name)?.[1];
  // Names from before the time was added are always leftovers by now.
  return time === undefined || Date.now() - parseInt(time, 36) > STALE_MS;
}

/**
 * Drops the databases and roles that interrupted runs left behind, which
 * never reached their cleanup. Only ones older than an hour, so suites
 * running at the same time against the same server keep theirs. A view role
 * is dropped once nothing grants it anything, which is the case once its
 * database is gone; Postgres refuses to drop one still in use.
 */
export async function dropStaleTestDatabases(): Promise<void> {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    const { rows: databases } = await admin.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE $1",
      [`${PREFIX}\\_%`],
    );
    for (const { datname } of databases) {
      if (!isStale(datname)) continue;
      await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
    }
    const { rows: roles } = await admin.query<{ rolname: string }>(
      "SELECT rolname FROM pg_roles WHERE rolname LIKE $1 OR rolname LIKE 'nextbase\\_views\\_%'",
      [`${PREFIX}\\_role\\_%`],
    );
    for (const { rolname } of roles) {
      if (rolname.startsWith(PREFIX) && !isStale(rolname)) continue;
      await admin.query(`DROP ROLE IF EXISTS "${rolname}"`).catch(() => {});
    }
  } finally {
    await admin.end();
  }
}

/**
 * Creates an empty database for one test file. NextBase owns a fixed Postgres
 * schema, so test files are isolated by database rather than by schema.
 *
 * With `roleAttributes`, the database is owned by and used through a new
 * non-superuser role with those attributes (e.g. "CREATEROLE"), since a
 * superuser bypasses every privilege check.
 */
export async function createTestDatabase(
  roleAttributes?: string,
): Promise<TestDatabase> {
  const suffix = uniqueSuffix();
  const name = `${PREFIX}_${suffix}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const target = new URL(url);
  target.pathname = `/${name}`;
  let owner: string | undefined;
  if (roleAttributes === undefined) {
    await admin.query(`CREATE DATABASE ${name}`);
  } else {
    owner = `${PREFIX}_role_${suffix}`;
    await admin.query(
      `CREATE ROLE ${owner} LOGIN PASSWORD '${suffix}' NOSUPERUSER ${roleAttributes}`,
    );
    await admin.query(`CREATE DATABASE ${name} OWNER ${owner}`);
    target.username = owner;
    target.password = suffix;
  }
  const pool = new pg.Pool({ connectionString: target.toString() });
  return {
    db: new DB(pool),
    pool,
    url: target.toString(),
    async close() {
      // Roles outlive databases, so the view role is dropped by name.
      const role = await pool
        .query("SELECT view_role FROM nextbase._meta")
        .then((r) => r.rows[0]?.view_role as string | null | undefined)
        .catch(() => undefined);
      await endPool(pool);
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      for (const r of [role, owner]) {
        if (r) await admin.query(`DROP ROLE IF EXISTS "${r}"`);
      }
      await admin.end();
    },
  };
}

export { endPool } from "../src/db/pool.ts";
