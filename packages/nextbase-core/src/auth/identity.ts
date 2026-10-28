import type { AuthCollection } from "@nextbasejs/client";
import { type Builder, type Expression, exp, type Row } from "@nextbasejs/dbx";
import { table } from "../db/system.ts";

// Unique indexes on email and phone fields leave out empty values. Each
// condition says the value is not empty too, so Postgres can use the index.

/** Matches `email` case-insensitively, as email uniqueness is enforced. */
export function emailIs(column: string, email: string): Expression {
  return exp(`lower([[${column}]]) = lower({:email}) AND [[${column}]] <> ''`, {
    email,
  });
}

/** Matches a phone in E.164, the form phones are stored in. */
export function phoneIs(column: string, phone: string): Expression {
  return exp(`[[${column}]] = {:phone} AND [[${column}]] <> ''`, { phone });
}

/** Case-insensitive, matching how email uniqueness is enforced. */
export async function findByEmail(
  db: Builder,
  collection: AuthCollection,
  email: string,
): Promise<Row | undefined> {
  const [record] = await db
    .select()
    .from(table(collection.name))
    .where(emailIs("email", email))
    .limit(1)
    .all();
  return record;
}
