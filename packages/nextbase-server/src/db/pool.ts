import type { Pool } from "@nextbase/dbx";
import { attachDatabasePool } from "@vercel/functions";
import pg from "pg";

// `next dev` re-evaluates modules on every change. Pools are kept on
// globalThis, keyed by connection string, so reloads reuse them instead of
// leaking connections.
const POOLS = Symbol.for("nextbase.pools");

type PoolCache = Map<string, pg.Pool>;

/** Returns the pool for `connectionString`, creating it on first use. */
export function sharedPool(connectionString: string): Pool {
  const global = globalThis as { [POOLS]?: PoolCache };
  const pools = global[POOLS] ?? new Map();
  global[POOLS] = pools;
  let pool = pools.get(connectionString);
  if (!pool) {
    pool = new pg.Pool({
      connectionString,
      // Vercel's guide for functions: a short idle timeout, so connections a
      // suspended instance holds are released soon.
      idleTimeoutMillis: 5_000,
      // node-postgres waits forever for a connection by default; a full pool
      // or an unreachable database then hangs the request until the platform
      // kills it.
      connectionTimeoutMillis: 10_000,
    });
    // Releases idle clients before a Vercel function suspends; does nothing
    // elsewhere.
    attachDatabasePool(pool);
    // An idle connection can fail at any time (server restart, network). Without
    // a listener, node-postgres re-emits that as an uncaught error and the
    // process exits. The pool discards the connection; the next query reconnects.
    pool.on("error", (error: Error) => {
      console.error("[nextbase] idle database connection failed:", error);
    });
    pools.set(connectionString, pool);
  }
  return pool;
}
