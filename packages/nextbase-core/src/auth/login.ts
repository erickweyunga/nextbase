import type { AuthCollection } from "@nextbasejs/client";
import {
  and,
  type DB,
  type Expression,
  exp,
  hash,
  type Row,
} from "@nextbasejs/dbx";
import { table } from "../db/system.ts";
import { ApiError } from "../errors.ts";
import { compileFilter } from "../filter/compiler.ts";
import { normalizePhone } from "../phone.ts";
import type { Schema } from "../schema/cache.ts";
import { hasNul } from "../storable.ts";
import {
  hashPassword,
  needsRehash,
  verifyDummyPassword,
  verifyPassword,
} from "./password.ts";
import {
  accountKey,
  clearAttempts,
  countAttempt,
  identityKey,
} from "./throttle.ts";

// Longer passwords cannot be valid (the field allows at most 1024 characters);
// rejecting them early bounds hashing cost.
const MAX_PASSWORD_INPUT = 1024;

/**
 * Checks that a record may log in: `null` disables logins, `""` allows every
 * record, and any other authRule is a condition the record must meet, such as
 * `emailVerified = true`. Called only after the password matched, so the 403 tells
 * nothing to someone without it.
 */
export async function checkAuthRule(
  db: DB,
  schema: Schema,
  collection: AuthCollection,
  id: string,
): Promise<void> {
  if (collection.authRule === "") return;
  const denied = new ApiError(
    403,
    "This account does not meet the requirements to sign in.",
  );
  if (collection.authRule === null) throw denied;
  const rule = compileFilter(collection.authRule, collection, "t0", {
    schema,
    principal: { superuser: false },
    request: { method: "POST", query: {}, headers: {}, body: {} },
    mode: "rule",
  });
  const rows = await db
    .select("t0.id")
    .from(`${table(collection.name)} t0`)
    .where(and(hash({ "t0.id": id }), rule))
    .column();
  if (rows.length === 0) throw denied;
}

/**
 * Finds the record whose identity field matches `identity` and whose password
 * matches. Every failure is the same 400, so responses do not reveal which
 * identities exist.
 */
export async function authWithPassword(
  db: DB,
  schema: Schema,
  collection: AuthCollection,
  identity: string,
  password: string,
): Promise<Row> {
  const failed = new ApiError(400, "Failed to authenticate.");
  // No stored identity can contain NUL, and Postgres would reject it.
  if (hasNul(identity)) throw failed;
  // Counted per typed identity, which may match no account, and per account.
  const keys = [identityKey(collection.id, identity)];
  await countAttempt(db, keys);

  const record =
    password.length <= MAX_PASSWORD_INPUT
      ? await findByIdentity(db, collection, identity)
      : undefined;
  if (record) {
    keys.push(accountKey(collection.id, record.id as string));
    await countAttempt(db, keys.slice(1));
  }
  let valid = false;
  if (record) valid = await verifyPassword(password, record.password as string);
  else await verifyDummyPassword(password);
  if (!record || !valid) throw failed;
  await clearAttempts(db, keys);
  await checkAuthRule(db, schema, collection, record.id as string);

  if (needsRehash(record.password as string)) {
    await db
      .update(
        table(collection.name),
        { password: await hashPassword(password) },
        hash({ id: record.id }),
      )
      .execute();
  }
  return record;
}

// Identity fields are tried in order; the first match wins.
async function findByIdentity(
  db: DB,
  collection: AuthCollection,
  identity: string,
): Promise<Row | undefined> {
  for (const name of collection.identityFields) {
    const field = collection.fields.find((f) => f.name === name);
    if (!field || identity === "") continue;
    // Emails are unique regardless of case, so they match regardless of case;
    // phones are stored in E.164, so the identity is read as a phone first.
    let condition: Expression;
    if (field.type === "email") {
      condition = exp(`lower([[${name}]]) = lower({:identity})`, { identity });
    } else if (field.type === "phone") {
      const phone = normalizePhone(identity);
      if (phone === undefined) continue;
      condition = hash({ [name]: phone });
    } else {
      condition = hash({ [name]: identity });
    }
    const [record] = await db
      .select()
      .from(table(collection.name))
      .where(condition)
      .limit(1)
      .all();
    if (record) return record;
  }
  return undefined;
}
