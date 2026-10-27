import type { Tx } from "@nextbasejs/dbx";

export const SCHEMA = "nextbase";

// Advisory lock held by every schema change and migration, so DDL never runs concurrently.
const SCHEMA_LOCK = 7_163_845_122_001;

// Unquoted: builder methods quote it, raw SQL uses `{{name}}`.
export function table(name: string): string {
  return `${SCHEMA}.${name}`;
}

/** Held until `tx` ends. */
export async function lockSchema(tx: Tx): Promise<void> {
  await tx
    .newQuery("SELECT pg_advisory_xact_lock({:key})")
    .bind({ key: SCHEMA_LOCK })
    .execute();
}
