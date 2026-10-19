import { randomUUID } from "node:crypto";
import pg from "pg";
import { DB } from "../src/index.ts";

const url =
  process.env.NEXTBASE_TEST_DATABASE_URL ??
  "postgres://localhost/nextbase_test";

export interface TestDatabase {
  db: DB;
  pool: pg.Pool;
  /** The private schema every connection in `pool` uses as its search path. */
  schema: string;
  close(): Promise<void>;
}

/**
 * Creates a private schema in the test database and a pool whose connections
 * use it, so test files run in parallel without interfering.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const schema = `dbx_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    connectionString: url,
    options: `-c search_path=${schema}`,
  });
  return {
    db: new DB(pool),
    pool,
    schema,
    async close() {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}
