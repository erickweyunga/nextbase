import type { AuthCollection } from "@nextbasejs/client";
import { type Builder, type DB, hash, type Row } from "@nextbasejs/dbx";
import { lockSchema, table } from "../db/system.ts";
import { ApiError } from "../errors.ts";
import { ALPHANUMERIC, newId, randomString } from "../random.ts";
import { EMAIL_PATTERN } from "../records/values.ts";
import type { Schema } from "../schema/cache.ts";
import {
  DEFAULT_PASSWORD_MAX,
  DEFAULT_PASSWORD_MIN,
  passwordField,
} from "../schema/fields.ts";
import { Issues } from "../schema/input.ts";
import { hasNul } from "../storable.ts";
import { hashPassword } from "./password.ts";
import { signToken, verifyToken } from "./tokens.ts";

const SETUP_TOKEN_DURATION = 60 * 60;

function superusers(schema: Schema): AuthCollection {
  return schema.get("_superusers") as AuthCollection;
}

export async function hasSuperuser(q: Builder): Promise<boolean> {
  const rows = await q
    .select("id")
    .from(table("_superusers"))
    .limit(1)
    .column();
  return rows.length > 0;
}

export async function setupToken(q: Builder): Promise<string> {
  const [secret] = await q
    .select("setup_secret")
    .from(table("_meta"))
    .column<string>();
  return signToken(secret as string, { type: "setup" }, SETUP_TOKEN_DURATION);
}

/** 404 once any superuser exists: setup is over. */
export async function completeSetup(
  db: DB,
  schema: Schema,
  input: Record<string, unknown>,
): Promise<Row> {
  return db.transaction(async (tx) => {
    // Serializes concurrent setups, so only one can see an empty table.
    await lockSchema(tx);
    if (await hasSuperuser(tx)) throw new ApiError(404, "Not found.");
    const [secret] = await tx
      .select("setup_secret")
      .from(table("_meta"))
      .column<string>();
    const token = typeof input.token === "string" ? input.token : "";
    if (!(await verifyToken(token, secret as string, "setup"))) {
      throw new ApiError(
        403,
        "The setup token is invalid or has expired. Check the server logs for a new one.",
      );
    }
    return insertSuperuser(tx, superusers(schema), input.email, input.password);
  });
}

export async function insertSuperuser(
  q: Builder,
  collection: AuthCollection,
  email: unknown,
  password: unknown,
): Promise<Row> {
  const issues = new Issues();
  const field = passwordField(collection);
  const min = field?.min ?? DEFAULT_PASSWORD_MIN;
  const max = field?.max ?? DEFAULT_PASSWORD_MAX;
  if (
    typeof email !== "string" ||
    hasNul(email) ||
    email.length > 254 ||
    !EMAIL_PATTERN.test(email)
  ) {
    issues.add(
      ["email"],
      "validation_invalid_email",
      "Must be a valid email address.",
    );
  }
  if (
    typeof password !== "string" ||
    // Characters as people see them, not UTF-16 units.
    [...password].length < min ||
    [...password].length > max
  ) {
    issues.add(
      ["password"],
      "validation_length_out_of_range",
      `Must be ${min} to ${max} characters.`,
    );
  }
  if (!issues.empty)
    throw new ApiError(400, "Failed to create the superuser.", issues.data);

  const row = {
    id: newId(),
    email: (email as string).trim(),
    emailVisibility: false,
    emailVerified: true,
    password: await hashPassword(password as string),
    tokenKey: randomString(50, ALPHANUMERIC),
  };
  try {
    await q.insert(table(collection.name), row).execute();
  } catch (error) {
    if ((error as { code?: unknown }).code === "23505") {
      throw new ApiError(400, "Failed to create the superuser.", {
        email: {
          code: "validation_not_unique",
          message: "A superuser with this email exists.",
        },
      });
    }
    throw error;
  }
  const [inserted] = await q
    .select()
    .from(table(collection.name))
    .where(hash({ id: row.id }))
    .all();
  return inserted as Row;
}
