import type pg from 'pg';

/**
 * Resolves once `done` returns true, checking every 10 ms. Rejects after
 * `timeout` ms naming `what`, so a hanging test fails with a clear message.
 */
export async function waitFor(
  done: () => boolean | Promise<boolean>,
  what: string,
  timeout = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await done())) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Whether a connection to the test database is waiting for a lock. */
export async function waitsForLock(pool: pg.Pool): Promise<boolean> {
  const { rows } = await pool.query(
    "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
  );
  return rows.length > 0;
}
