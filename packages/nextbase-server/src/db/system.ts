import type { Tx } from "@nextbasejs/dbx";

/** The Postgres schema holding every NextBase table. */
export const SCHEMA = "nextbase";

// Arbitrary, fixed advisory lock key. Every schema change and migration holds
// it, so instances never run DDL concurrently.
const SCHEMA_LOCK = 7_163_845_122_001;

/**
 * The schema-qualified name of a NextBase table, unquoted: dbx builder methods
 * quote it, and raw SQL writes it as `{{name}}`. Names are validated before
 * they get here, so they contain no dots.
 */
export function table(name: string): string {
  return `${SCHEMA}.${name}`;
}

/** Serializes schema changes across instances until `tx` ends. */
export async function lockSchema(tx: Tx): Promise<void> {
  await tx
    .newQuery("SELECT pg_advisory_xact_lock({:key})")
    .bind({ key: SCHEMA_LOCK })
    .execute();
}
