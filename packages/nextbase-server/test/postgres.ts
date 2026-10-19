import { randomUUID } from "node:crypto";
import { DB } from "@nextbase/dbx";
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
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const name = `nextbase_test_${suffix}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const target = new URL(url);
  target.pathname = `/${name}`;
  let owner: string | undefined;
  if (roleAttributes === undefined) {
    await admin.query(`CREATE DATABASE ${name}`);
  } else {
    owner = `nextbase_test_role_${suffix}`;
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

/**
 * Ends a pool and waits until its connections have closed. `pool.end()`
 * resolves while they are still closing, and dropping the database then
 * terminates them with an error nothing is left to handle.
 */
export async function endPool(pool: pg.Pool): Promise<void> {
  let open = pool.totalCount;
  const closed = new Promise<void>((resolve) => {
    if (open === 0) resolve();
    pool.on("remove", () => {
      if (--open === 0) resolve();
    });
  });
  await pool.end();
  await closed;
}
