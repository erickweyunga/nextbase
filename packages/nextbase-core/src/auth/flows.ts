import type { AuthCollection, TokenType } from "@nextbasejs/client";
import { type Builder, type DB, exp, hash, type Row } from "@nextbasejs/dbx";
import { table } from "../db/system.ts";
import { ApiError } from "../errors.ts";
import { updateRecord } from "../records/service.ts";
import { EMAIL_PATTERN } from "../records/values.ts";
import type { Schema } from "../schema/cache.ts";
import { hasNul } from "../storable.ts";
import type { Mailer } from "./mail.ts";
import { verifyPassword } from "./password.ts";
import type { Principal } from "./principal.ts";
import {
  accountKey,
  clearAttempts,
  countAttempt,
  identityKey,
  mailKey,
} from "./throttle.ts";
import { peekToken, signToken, verifyToken } from "./tokens.ts";

// Email verification, password reset and email change.
//
// - Requests answer the same whether or not the account exists, and send mail
//   in the background, so neither the answer nor its timing reveals accounts.
// - Tokens are signed and expire. They are bound to the record's tokenKey,
//   which a reset or email change replaces: that makes each token work once
//   and ends every session.
// - Links are built from the configured app URL, never the Host header.

export interface FlowContext {
  db: DB;
  schema: Schema;
  mailer: Mailer;
  /** Reject new passwords found in data breaches. */
  rejectBreachedPasswords: boolean;
}

const invalidToken = (): ApiError =>
  new ApiError(400, "The link is invalid or has expired.", {
    token: {
      code: "validation_invalid_token",
      message: "Invalid or expired.",
    },
  });

/** Sends a verification link to `email`, if it belongs to an unverified record. */
export async function requestEmailVerification(
  ctx: FlowContext,
  collection: AuthCollection,
  email: unknown,
): Promise<void> {
  const address = checkEmail(email);
  ctx.mailer.check();
  await countAttempt(ctx.db, [mailKey(collection.id, address)]);
  const record = await findByEmail(ctx.db, collection, address);
  if (!record || record.emailVerified === true) return;
  ctx.mailer.send("verification", collection.name, record.email as string, {
    token: await token(collection, record, "verification", {
      email: record.email,
    }),
  });
}

/** Marks the record of a verification token as verified. */
export async function confirmEmailVerification(
  ctx: FlowContext,
  collection: AuthCollection,
  token: unknown,
): Promise<void> {
  const { record, claims } = await verified(
    ctx.db,
    collection,
    token,
    "verification",
  );
  // A token for an address the record no longer has proves nothing.
  if (claims.email !== record.email) throw invalidToken();
  if (record.emailVerified === true) return;
  await privilegedUpdate(ctx, collection, record, { emailVerified: true });
}

/** Sends a password reset link to `email`, if it belongs to a record. */
export async function requestPasswordReset(
  ctx: FlowContext,
  collection: AuthCollection,
  email: unknown,
): Promise<void> {
  const address = checkEmail(email);
  ctx.mailer.check();
  await countAttempt(ctx.db, [mailKey(collection.id, address)]);
  const record = await findByEmail(ctx.db, collection, address);
  if (!record) return;
  ctx.mailer.send("passwordReset", collection.name, record.email as string, {
    token: await token(collection, record, "passwordReset", {
      email: record.email,
    }),
  });
}

/**
 * Sets a new password with a reset token. The record's tokenKey rotates, so
 * the token cannot be used again and every session ends; its email is now
 * verified; a login lockout ends; and the owner is told. The user signs in
 * as usual afterwards.
 */
export async function confirmPasswordReset(
  ctx: FlowContext,
  collection: AuthCollection,
  input: Record<string, unknown>,
): Promise<void> {
  const { record, claims } = await verified(
    ctx.db,
    collection,
    input.token,
    "passwordReset",
  );
  if (claims.email !== record.email) throw invalidToken();
  await privilegedUpdate(ctx, collection, record, {
    password: input.password,
    passwordConfirm: input.passwordConfirm,
    emailVerified: true,
  });
  // Ends a lockout, counted per account and per identity it signs in with.
  await clearAttempts(ctx.db, [
    accountKey(collection.id, record.id as string),
    ...collection.identityFields.flatMap((name) =>
      typeof record[name] === "string" && record[name] !== ""
        ? [identityKey(collection.id, record[name] as string)]
        : [],
    ),
  ]);
  ctx.mailer.send("passwordChanged", collection.name, record.email as string);
}

/** Sends a link to `newEmail` that moves the signed-in record to it. */
export async function requestEmailChange(
  ctx: FlowContext,
  collection: AuthCollection,
  principal: Principal,
  newEmail: unknown,
): Promise<void> {
  const record = principal.record;
  if (!record || principal.collection?.id !== collection.id) {
    throw new ApiError(401, "Sign in to this collection to change its email.");
  }
  const address = checkEmail(newEmail, "newEmail");
  if (address.toLowerCase() === String(record.email).toLowerCase()) {
    throw new ApiError(400, "Failed to request the email change.", {
      newEmail: {
        code: "validation_same_email",
        message: "Is the current email.",
      },
    });
  }
  ctx.mailer.check();
  await countAttempt(ctx.db, [mailKey(collection.id, address)]);
  // Whether another record has the address is checked on confirming, so
  // this request does not reveal it.
  ctx.mailer.send("emailChange", collection.name, address, {
    token: await token(collection, record, "emailChange", {
      email: record.email,
      newEmail: address,
    }),
  });
}

/**
 * Moves a record to the new email of an email change token, given its
 * current password. The tokenKey rotates, ending every session; the new
 * email is verified; the old address is told.
 */
export async function confirmEmailChange(
  ctx: FlowContext,
  collection: AuthCollection,
  input: Record<string, unknown>,
): Promise<void> {
  const { record, claims } = await verified(
    ctx.db,
    collection,
    input.token,
    "emailChange",
  );
  if (claims.email !== record.email || typeof claims.newEmail !== "string") {
    throw invalidToken();
  }
  const keys = [accountKey(collection.id, record.id as string)];
  await countAttempt(ctx.db, keys);
  const ok =
    typeof input.password === "string" &&
    (await verifyPassword(input.password, record.password as string));
  if (!ok) {
    throw new ApiError(400, "Failed to confirm the email change.", {
      password: {
        code: "validation_invalid_password",
        message: "Does not match the current password.",
      },
    });
  }
  await clearAttempts(ctx.db, keys);
  await privilegedUpdate(ctx, collection, record, {
    email: claims.newEmail,
    emailVerified: true,
  });
  ctx.mailer.send("emailChanged", collection.name, record.email as string);
}

function checkEmail(value: unknown, field = "email"): string {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    hasNul(value) ||
    !EMAIL_PATTERN.test(value)
  ) {
    throw new ApiError(400, "Failed to send the email.", {
      [field]: {
        code: "validation_invalid_email",
        message: "Must be a valid email address.",
      },
    });
  }
  return value;
}

/** Emails are unique regardless of case, so they match regardless of case. */
export async function findByEmail(
  db: Builder,
  collection: AuthCollection,
  email: string,
): Promise<Row | undefined> {
  const [record] = await db
    .select()
    .from(table(collection.name))
    .where(exp(`lower("email") = lower({:email})`, { email }))
    .limit(1)
    .all();
  return record;
}

/** Signs a token of `type` with the record's tokenKey and the collection's secret. */
function token(
  collection: AuthCollection,
  record: Row,
  type: TokenType,
  claims: Record<string, unknown>,
): Promise<string> {
  const { secret, duration } = collection.tokens[type];
  return signToken(
    `${record.tokenKey as string}${secret}`,
    { type, id: record.id, collectionId: collection.id, ...claims },
    duration,
  );
}

/** The record a token of `type` was issued to, once its signature checks out. */
async function verified(
  db: DB,
  collection: AuthCollection,
  value: unknown,
  type: TokenType,
): Promise<{ record: Row; claims: Record<string, unknown> }> {
  const tokenText = typeof value === "string" ? value : "";
  const peeked = peekToken(tokenText);
  if (peeked?.collectionId !== collection.id || typeof peeked.id !== "string") {
    throw invalidToken();
  }
  const [record] = await db
    .select()
    .from(table(collection.name))
    .where(hash({ id: peeked.id }))
    .all();
  if (!record) throw invalidToken();
  const claims = await verifyToken(
    tokenText,
    `${record.tokenKey as string}${collection.tokens[type].secret}`,
    type,
  );
  if (!claims) throw invalidToken();
  return { record, claims };
}

/**
 * Updates the record as NextBase itself, through the records service, so
 * values are validated as on any write and a new tokenKey ends its sessions.
 */
async function privilegedUpdate(
  ctx: FlowContext,
  collection: AuthCollection,
  record: Row,
  input: Record<string, unknown>,
): Promise<void> {
  await updateRecord(
    {
      db: ctx.db,
      pool: ctx.db,
      schema: ctx.schema,
      principal: { superuser: true },
      request: { method: "PATCH", query: {}, headers: {}, body: input },
      rejectBreachedPasswords: ctx.rejectBreachedPasswords,
    },
    collection,
    record.id as string,
    input,
    new URLSearchParams(),
  );
}
