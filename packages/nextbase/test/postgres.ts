import { randomUUID } from "node:crypto";
import { DB } from "@nextbase/dbx";
import pg from "pg";

const url =
  process.env.NEXTBASE_TEST_DATABASE_URL ??
  "postgres://localhost/nextbase_test";

export interface TestDatabase {
  db: DB;
  pool: pg.Pool;
  close(): Promise<void>;
}

/**
 * Creates an empty database for one test file. NextBase owns a fixed Postgres
 * schema, so test files are isolated by database rather than by schema.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `nextbase_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const target = new URL(url);
  target.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: target.toString() });
  return {
    db: new DB(pool),
    pool,
    async close() {
      await pool.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}
