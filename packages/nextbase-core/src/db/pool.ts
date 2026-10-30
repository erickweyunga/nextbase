import type { Pool } from '@nextbasejs/dbx';
import { attachDatabasePool } from '@vercel/functions';
import pg from 'pg';

// On globalThis so `next dev` reloads reuse pools instead of leaking connections.
const POOLS = Symbol.for('nextbase.pools');

type PoolCache = Map<string, pg.Pool>;

export function sharedPool(connectionString: string): Pool {
  const global = globalThis as { [POOLS]?: PoolCache };
  const pools = global[POOLS] ?? new Map();
  global[POOLS] = pools;
  let pool = pools.get(connectionString);
  if (!pool) {
    pool = new pg.Pool({
      connectionString,
      // Short, so a suspended serverless instance releases its connections.
      idleTimeoutMillis: 5_000,
      // The default waits forever, hanging requests on a full pool or dead database.
      connectionTimeoutMillis: 10_000,
    });
    // Releases idle clients before a Vercel function suspends; no-op elsewhere.
    attachDatabasePool(pool);
    // Without a listener an idle connection's failure crashes the process. The
    // pool discards it and the next query reconnects.
    pool.on('error', (error: Error) => {
      console.error('[nextbase] idle database connection failed:', error);
    });
    pools.set(connectionString, pool);
  }
  return pool;
}

/**
 * Ends a pool and waits until its connections have closed. `pool.end()`
 * resolves while they are still closing, and a server that ends them first,
 * such as when their database is dropped, then fails them with an error
 * nothing is left to handle.
 */
export async function endPool(pool: pg.Pool): Promise<void> {
  let open = pool.totalCount;
  const closed = new Promise<void>((resolve) => {
    if (open === 0) resolve();
    pool.on('remove', () => {
      if (--open === 0) resolve();
    });
  });
  await pool.end();
  await closed;
}
