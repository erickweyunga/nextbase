import { type Expression, exp } from "@nextbasejs/dbx";

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
