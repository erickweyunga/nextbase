import pg from "pg";
import { DATABASE_PREFIX } from "./server.ts";

const adminUrl =
  process.env.NEXTBASE_TEST_DATABASE_URL ??
  "postgres://localhost/nextbase_test";
/** Databases older than this are left over from runs that were interrupted. */
const STALE_MS = 60 * 60 * 1000;

/**
 * Runs once before the suite: drops the databases interrupted runs left
 * behind, which never reached their cleanup. Only ones older than an hour,
 * so suites running at the same time against the same server keep theirs.
 */
export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE $1",
      [`${DATABASE_PREFIX}\\_%`],
    );
    for (const { datname } of rows) {
      const time = /_([0-9a-z]+)_[0-9a-f]{8}$/.exec(datname)?.[1];
      // Names from before the time was added are always leftovers by now.
      if (time !== undefined && Date.now() - parseInt(time, 36) <= STALE_MS) {
        continue;
      }
      await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
}
