import type { AuthCollection, LinkedAccountModel } from "@nextbasejs/client";
import {
  type Builder,
  type DB,
  hash,
  type Row,
  type Tx,
} from "@nextbasejs/dbx";
import { table } from "../db/system.ts";
import { ApiError } from "../errors.ts";
import { ALPHANUMERIC, LOWER_ALPHANUMERIC, randomString } from "../random.ts";
import { newRecord, updateRecord } from "../records/service.ts";
import type { Schema } from "../schema/cache.ts";
import { findByEmail } from "./flows.ts";
import { type Identity, OAuth2Error } from "./oauth2.ts";

// Provider accounts linked to auth records. A sign-in finds its record by the
// provider's permanent account id, never by email. An email match links
// automatically only when both the provider and NextBase verified that email,
// and the owner is told; anything weaker could hand an account to whoever
// controls a provider account claiming its address (CVE-2026-53516).

export interface AccountContext {
  db: DB;
  schema: Schema;
}

/** The record a provider sign-in belongs to, and the address to tell of a new link. */
export interface Account {
  record: Row;
  /** Set when this sign-in linked the provider: the owner should be told. */
  linkedTo?: string;
}

/**
 * Finds or creates the record for a provider account, linking it to
 * `linkRecordId` when a signed-in record asked to link. New records follow
 * the collection's create rule, as a sign-up does.
 */
export async function accountFor(
  ctx: AccountContext,
  collection: AuthCollection,
  provider: string,
  identity: Identity,
  linkRecordId: string | null,
): Promise<Account> {
  return ctx.db.transaction(async (tx) => {
    const linked = await findLinked(tx, collection, provider, identity.id);
    if (linkRecordId !== null) {
      if (linked) {
        if (linked.id !== linkRecordId) throw alreadyLinked();
        return { record: linked };
      }
      const record = await findRecord(tx, collection, linkRecordId);
      if (!record) {
        throw new OAuth2Error("oauth2_failed", "The account no longer exists.");
      }
      await link(tx, collection, record.id as string, provider, identity.id);
      return { record, linkedTo: record.email as string };
    }
    if (linked) return { record: linked };
    if (identity.email === undefined) {
      throw new OAuth2Error(
        "email_required",
        "The provider did not share an email address.",
      );
    }
    const existing = await findByEmail(tx, collection, identity.email);
    if (existing) {
      if (!identity.emailVerified || existing.emailVerified !== true) {
        throw new OAuth2Error(
          "account_exists",
          "An account with this email exists. Sign in to it, then link this provider.",
        );
      }
      await link(tx, collection, existing.id as string, provider, identity.id);
      return { record: existing, linkedTo: existing.email as string };
    }
    const record = await signUp(
      { db: tx, schema: ctx.schema, pool: ctx.db },
      collection,
      identity,
    );
    await link(tx, collection, record.id as string, provider, identity.id);
    return { record };
  });
}

/** The providers linked to a record, oldest first. */
export async function listLinkedAccounts(
  q: Builder,
  collectionId: string,
  recordId: string,
): Promise<LinkedAccountModel[]> {
  const rows = await q
    .newQuery(
      `SELECT id, provider, created FROM {{${table("_linked_accounts")}}}
       WHERE collection_id = {:collectionId} AND record_id = {:recordId}
       ORDER BY created, id`,
    )
    .bind({ collectionId, recordId })
    .all<{ id: string; provider: string; created: Date }>();
  return rows.map((row) => ({ ...row, created: row.created.toISOString() }));
}

/** Unlinks a provider from a record. Returns whether it was linked. */
export async function unlinkAccount(
  q: Builder,
  collectionId: string,
  recordId: string,
  provider: string,
): Promise<boolean> {
  const deleted = await q
    .newQuery(
      `DELETE FROM {{${table("_linked_accounts")}}}
       WHERE collection_id = {:collectionId} AND record_id = {:recordId}
         AND provider = {:provider}
       RETURNING id`,
    )
    .bind({ collectionId, recordId, provider })
    .column();
  return deleted.length > 0;
}

async function findLinked(
  q: Builder,
  collection: AuthCollection,
  provider: string,
  providerId: string,
): Promise<Row | undefined> {
  const [recordId] = await q
    .newQuery(
      `SELECT record_id FROM {{${table("_linked_accounts")}}}
       WHERE collection_id = {:collectionId} AND provider = {:provider}
         AND provider_id = {:providerId}`,
    )
    .bind({ collectionId: collection.id, provider, providerId })
    .column();
  return recordId === undefined
    ? undefined
    : findRecord(q, collection, recordId as string);
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

const alreadyLinked = (): OAuth2Error =>
  new OAuth2Error(
    "already_linked",
    "This provider account is linked to another account, or this account already has one from this provider.",
  );

async function link(
  q: Builder,
  collection: AuthCollection,
  recordId: string,
  provider: string,
  providerId: string,
): Promise<void> {
  const inserted = await q
    .newQuery(
      `INSERT INTO {{${table("_linked_accounts")}}}
         (id, collection_id, record_id, provider, provider_id)
       VALUES ({:id}, {:collectionId}, {:recordId}, {:provider}, {:providerId})
       ON CONFLICT DO NOTHING
       RETURNING id`,
    )
    .bind({
      id: randomString(15, LOWER_ALPHANUMERIC),
      collectionId: collection.id,
      recordId,
      provider,
      providerId,
    })
    .column();
  if (inserted.length === 0) throw alreadyLinked();
}

/**
 * Creates a record for a provider account, as an anonymous sign-up under
 * the create rule. Its password is random and never shown, so it signs in
 * through the provider until it sets one with a password reset.
 */
async function signUp(
  ctx: { db: Tx; pool: DB; schema: Schema },
  collection: AuthCollection,
  identity: Identity,
): Promise<Row> {
  const id = randomString(15, LOWER_ALPHANUMERIC);
  const field = collection.fields.find((f) => f.type === "password");
  const length = field ? Math.min(Math.max(field.min, 64), field.max) : 64;
  const password = randomString(length, ALPHANUMERIC);
  const input = {
    id,
    email: identity.email,
    password,
    passwordConfirm: password,
  };
  const records = {
    db: ctx.db,
    pool: ctx.pool,
    schema: ctx.schema,
    request: { method: "POST", query: {}, headers: {}, body: input },
  };
  try {
    await newRecord(
      { ...records, principal: { superuser: false } },
      collection,
      input,
      new URLSearchParams(),
    );
    // Only NextBase itself may mark a record verified.
    if (identity.emailVerified) {
      await updateRecord(
        { ...records, principal: { superuser: true } },
        collection,
        id,
        { emailVerified: true },
        new URLSearchParams(),
      );
    }
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) {
      throw new OAuth2Error(
        error.status === 403 ? "sign_up_disabled" : "sign_up_failed",
        error.message,
      );
    }
    throw error;
  }
  return (await findRecord(ctx.db, collection, id)) as Row;
}
