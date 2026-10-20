import { createHash, randomInt } from "node:crypto";
import type { AuthCollection } from "@nextbasejs/client";
import { type Builder, type DB, hash, type Row } from "@nextbasejs/dbx";
import { table } from "../db/system.ts";
import { ApiError } from "../errors.ts";
import { normalizePhone } from "../phone.ts";
import { ALPHANUMERIC, LOWER_ALPHANUMERIC, randomString } from "../random.ts";
import {
  newRecord,
  type RecordsContext,
  updateRecord,
} from "../records/service.ts";
import type { Schema } from "../schema/cache.ts";
import type { Mailer } from "./mail.ts";
import type { Principal } from "./principal.ts";
import type { Sms } from "./sms.ts";
import {
  accountKey,
  clearAttempts,
  countAttempt,
  phoneKey,
  smsKey,
} from "./throttle.ts";

// Sign-in and verification with codes texted to a phone, as NIST SP 800-63B
// rev 4 3.1.3 describes out-of-band authentication over the phone network:
// random codes of six digits, valid for 10 minutes and accepted once, with
// guesses limited per phone across every code sent to it, so a new code does
// not reset the count. Requests answer the same whether or not an account
// exists, and texts per phone are limited, as SMS costs money to send.

export interface PhoneContext {
  db: DB;
  schema: Schema;
  sms: Sms;
  mailer: Mailer;
  breachedPasswords: boolean;
}

/** Why a code was sent, which only that use accepts. */
type CodePurpose = "signIn" | "passwordReset" | "verifyPhone";

const CODE_LIFETIME = "10 minutes";
/** Wrong guesses one code allows before it is discarded. */
const MAX_CODE_ATTEMPTS = 5;
/** Texts per phone and hour. */
const SMS_LIMIT = { max: 5, window: "1 hour" };

const invalidCode = (): ApiError =>
  new ApiError(400, "The code is invalid or has expired.", {
    code: { code: "validation_invalid_code", message: "Invalid or expired." },
  });

/**
 * Texts a code for signing in or resetting a password, when it can be used:
 * to a phone of an existing record, or, for signing in, to a new phone the
 * collection lets sign up. Answers the same either way.
 */
export async function requestPhoneCode(
  ctx: PhoneContext,
  collection: AuthCollection,
  input: Record<string, unknown>,
): Promise<void> {
  checkEnabled(collection);
  const purpose = input.purpose ?? "signIn";
  if (purpose !== "signIn" && purpose !== "passwordReset") {
    throw new ApiError(400, "Failed to send the code.", {
      purpose: {
        code: "validation_invalid_value",
        message: "Must be signIn or passwordReset.",
      },
    });
  }
  const phone = checkPhone(input.phone);
  ctx.sms.check(phone);
  await countAttempt(ctx.db, [smsKey(collection.id, phone)], SMS_LIMIT);
  const record = await findByPhone(ctx.db, collection, phone);
  const usable =
    purpose === "signIn"
      ? record !== undefined || collection.createRule !== null
      : record?.phoneVerified === true;
  if (!usable) return;
  const code = await issueCode(ctx.db, collection, phone, purpose);
  ctx.sms.send(purpose, collection.name, phone, code);
}

/**
 * Signs in with a code texted to `phone`, creating a record for a new phone
 * under the collection's create rule. Returns the record, whose phone is
 * then verified.
 */
export async function authWithPhoneCode(
  ctx: PhoneContext,
  collection: AuthCollection,
  phoneInput: unknown,
  codeInput: unknown,
): Promise<Row> {
  checkEnabled(collection);
  const phone = checkPhone(phoneInput);
  await consumeCode(ctx.db, collection, phone, "signIn", codeInput);
  const existing = await findByPhone(ctx.db, collection, phone);
  if (existing) {
    if (existing.phoneVerified !== true) {
      await privilegedUpdate(ctx, collection, existing, {
        phoneVerified: true,
      });
    }
    return (await findRecord(ctx.db, collection, existing.id as string)) as Row;
  }
  const id = randomString(15, LOWER_ALPHANUMERIC);
  // The password is random and never shown: the record signs in with codes
  // until it sets one through a password reset.
  const field = collection.fields.find((f) => f.type === "password");
  const length = field ? Math.min(Math.max(field.min, 64), field.max) : 64;
  const password = randomString(length, ALPHANUMERIC);
  const input = {
    id,
    phone,
    phoneVerified: true,
    password,
    passwordConfirm: password,
  };
  await newRecord(
    {
      db: ctx.db,
      pool: ctx.db,
      schema: ctx.schema,
      principal: { superuser: false },
      request: { method: "POST", query: {}, headers: {}, body: input },
      // The code just proved the phone, which callers may not set alone.
      vouched: new Set(["phone", "phoneVerified"]),
    },
    collection,
    input,
    new URLSearchParams(),
  );
  return (await findRecord(ctx.db, collection, id)) as Row;
}

/** Sets a new password with a code texted to the record's verified phone. */
export async function confirmPasswordResetByPhone(
  ctx: PhoneContext,
  collection: AuthCollection,
  input: Record<string, unknown>,
): Promise<void> {
  checkEnabled(collection);
  const phone = checkPhone(input.phone);
  await consumeCode(ctx.db, collection, phone, "passwordReset", input.code);
  const record = await findByPhone(ctx.db, collection, phone);
  if (record?.phoneVerified !== true) throw invalidCode();
  // A new password rotates the tokenKey, which ends every session.
  await privilegedUpdate(ctx, collection, record, {
    password: input.password,
    passwordConfirm: input.passwordConfirm,
  });
  // The reset also lifts a password lockout, as an email reset does.
  await clearAttempts(ctx.db, [accountKey(collection.id, record.id as string)]);
  if (record.email) {
    ctx.mailer.send("passwordChanged", collection.name, record.email as string);
  }
}

/** Texts a code to `phone` that verifies it as the signed-in record's phone. */
export async function requestPhoneVerification(
  ctx: PhoneContext,
  collection: AuthCollection,
  principal: Principal,
  phoneInput: unknown,
): Promise<void> {
  const record = signedIn(collection, principal);
  checkEnabled(collection);
  const phone = checkPhone(phoneInput);
  ctx.sms.check(phone);
  await countAttempt(ctx.db, [smsKey(collection.id, phone)], SMS_LIMIT);
  // Whether another record has the phone is checked on confirming, so this
  // request does not reveal it.
  const code = await issueCode(
    ctx.db,
    collection,
    phone,
    "verifyPhone",
    record.id as string,
  );
  ctx.sms.send("verifyPhone", collection.name, phone, code);
}

/**
 * Makes `phone` the signed-in record's verified phone, given the code texted
 * to it. A new phone is a new way to sign in (NIST SP 800-63B 3.1.3.3): the
 * record's other sessions end, and its previous phone and email are told.
 */
export async function confirmPhoneVerification(
  ctx: PhoneContext,
  collection: AuthCollection,
  principal: Principal,
  input: Record<string, unknown>,
): Promise<void> {
  const record = signedIn(collection, principal);
  checkEnabled(collection);
  const phone = checkPhone(input.phone);
  await consumeCode(
    ctx.db,
    collection,
    phone,
    "verifyPhone",
    input.code,
    record.id as string,
  );
  const previous = record.phone as string;
  try {
    await updateRecord(
      recordsContext(ctx, principal, { phone, phoneVerified: true }),
      collection,
      record.id as string,
      { phone, phoneVerified: true },
      new URLSearchParams(),
    );
  } catch (error) {
    if (error instanceof ApiError && error.data.phone) {
      throw new ApiError(400, "Failed to verify the phone.", error.data);
    }
    throw error;
  }
  if (previous !== "" && previous !== phone) {
    ctx.sms.send("phoneChanged", collection.name, previous);
  }
  if (previous !== phone && record.email) {
    ctx.mailer.send("phoneChanged", collection.name, record.email as string);
  }
}

/** Finds the record a phone belongs to. */
async function findByPhone(
  q: Builder,
  collection: AuthCollection,
  phone: string,
): Promise<Row | undefined> {
  const [record] = await q
    .select()
    .from(table(collection.name))
    .where(hash({ phone }))
    .limit(1)
    .all();
  return record;
}

function checkEnabled(collection: AuthCollection): void {
  if (!collection.phoneAuth || collection.id === "_superusers") {
    throw new ApiError(
      400,
      "Phone sign-in is not enabled for this collection.",
    );
  }
}

function checkPhone(value: unknown): string {
  const phone = typeof value === "string" ? normalizePhone(value) : undefined;
  if (phone === undefined) {
    throw new ApiError(400, "Failed to use the phone number.", {
      phone: {
        code: "validation_invalid_phone",
        message:
          "Must be a valid phone number in international format, such as +255712345678.",
      },
    });
  }
  return phone;
}

function signedIn(collection: AuthCollection, principal: Principal): Row {
  if (!principal.record || principal.collection?.id !== collection.id) {
    throw new ApiError(401, "Sign in to this collection to verify a phone.");
  }
  return principal.record;
}

// Codes are stored hashed and salted with what they are for, so a database
// leak shows no live codes outright.
function codeHash(
  collection: AuthCollection,
  phone: string,
  purpose: CodePurpose,
  code: string,
): string {
  return createHash("sha256")
    .update(`${collection.id}:${phone}:${purpose}:${code}`)
    .digest("hex");
}

/** Stores a new code, replacing any earlier one, and returns it. */
async function issueCode(
  q: Builder,
  collection: AuthCollection,
  phone: string,
  purpose: CodePurpose,
  recordId = "",
): Promise<string> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  // Expired codes are cleaned up here, where codes are made.
  await q
    .newQuery(`DELETE FROM {{${table("_phone_codes")}}} WHERE expires <= now()`)
    .execute();
  await q
    .newQuery(
      `INSERT INTO {{${table("_phone_codes")}}}
         (collection_id, phone, purpose, record_id, code_hash, attempts, expires)
       VALUES ({:collectionId}, {:phone}, {:purpose}, {:recordId}, {:codeHash}, 0,
               now() + interval '${CODE_LIFETIME}')
       ON CONFLICT (collection_id, phone, purpose) DO UPDATE SET
         record_id = EXCLUDED.record_id, code_hash = EXCLUDED.code_hash,
         attempts = 0, expires = EXCLUDED.expires`,
    )
    .bind({
      collectionId: collection.id,
      phone,
      purpose,
      recordId,
      codeHash: codeHash(collection, phone, purpose, code),
    })
    .execute();
  return code;
}

/**
 * Accepts a code once: the guess is counted first, per phone, so neither
 * parallel guesses nor new codes get around the limit. A code that was
 * guessed wrong too often is discarded.
 */
async function consumeCode(
  db: DB,
  collection: AuthCollection,
  phone: string,
  purpose: CodePurpose,
  codeInput: unknown,
  recordId = "",
): Promise<void> {
  const key = phoneKey(collection.id, phone);
  await countAttempt(db, [key]);
  const code = typeof codeInput === "string" ? codeInput.trim() : "";
  if (!/^\d{6}$/.test(code)) throw invalidCode();
  const [stored] = await db
    .newQuery(
      `DELETE FROM {{${table("_phone_codes")}}}
       WHERE collection_id = {:collectionId} AND phone = {:phone} AND purpose = {:purpose}
         AND record_id = {:recordId} AND expires > now()
         AND attempts < ${MAX_CODE_ATTEMPTS} AND code_hash = {:codeHash}
       RETURNING 1`,
    )
    .bind({
      collectionId: collection.id,
      phone,
      purpose,
      recordId,
      codeHash: codeHash(collection, phone, purpose, code),
    })
    .all();
  if (stored) {
    await clearAttempts(db, [key]);
    return;
  }
  await db
    .newQuery(
      `UPDATE {{${table("_phone_codes")}}} SET attempts = attempts + 1
       WHERE collection_id = {:collectionId} AND phone = {:phone} AND purpose = {:purpose}`,
    )
    .bind({ collectionId: collection.id, phone, purpose })
    .execute();
  throw invalidCode();
}

async function findRecord(
  q: Builder,
  collection: AuthCollection,
  id: string,
): Promise<Row | undefined> {
  const [record] = await q
    .select()
    .from(table(collection.name))
    .where(hash({ id }))
    .all();
  return record;
}

/** Updates a record as NextBase itself, through the records service. */
async function privilegedUpdate(
  ctx: PhoneContext,
  collection: AuthCollection,
  record: Row,
  input: Record<string, unknown>,
): Promise<void> {
  await updateRecord(
    recordsContext(ctx, { superuser: true }, input),
    collection,
    record.id as string,
    input,
    new URLSearchParams(),
  );
}

/**
 * Records context for writes NextBase makes on a record's behalf: as a
 * superuser, but as the signed-in `principal` when there is one, so its own
 * session survives a rotated tokenKey.
 */
function recordsContext(
  ctx: PhoneContext,
  principal: Principal,
  body: Record<string, unknown>,
): RecordsContext {
  return {
    db: ctx.db,
    pool: ctx.db,
    schema: ctx.schema,
    principal: { ...principal, superuser: true },
    request: { method: "PATCH", query: {}, headers: {}, body },
    breachedPasswords: ctx.breachedPasswords,
  };
}
