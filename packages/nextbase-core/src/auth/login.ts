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

// The field caps passwords at 1024 chars; rejecting longer ones bounds hashing cost.
const MAX_PASSWORD_INPUT = 1024;

/**
 * authRule `null` disables logins, `""` allows all, anything else is a filter.
 * Call only after the password matched, so the 403 leaks nothing.
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

/** Every failure is the same 400, so responses do not reveal which identities exist. */
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
    // Emails are unique case-insensitively; phones are stored in E.164.
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
