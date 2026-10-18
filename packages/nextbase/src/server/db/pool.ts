import type { Pool } from "@nextbase/dbx";
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
    pool = new pg.Pool({ connectionString });
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
