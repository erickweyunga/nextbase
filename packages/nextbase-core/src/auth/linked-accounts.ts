import type { AuthCollection, LinkedAccountModel } from '@nextbasejs/client';
import {
  type Builder,
  type DB,
  hash,
  type Row,
  type Tx,
} from '@nextbasejs/dbx';
import { table } from '../db/system.ts';
import { Effects } from '../effects.ts';
import { ApiError } from '../errors.ts';
import type { Storage } from '../files/storage.ts';
import type { Logger } from '../logs/logger.ts';
import { newId } from '../random.ts';
import type { Hooks } from '../records/hooks.ts';
import { newRecord, systemContext, updateRecord } from '../records/service.ts';
import type { Schema } from '../schema/cache.ts';
import { randomPassword } from '../schema/fields.ts';
import { findByEmail } from './identity.ts';
import { takesSecondStep } from './mfa.ts';
import { type Identity, OAuth2Error } from './oauth2.ts';
import { setPasswordOrigin } from './password-origins.ts';
import { type ProfilePolicy, profileValues, resolveFiles } from './profile.ts';
import {
  checkSignIn,
  type SignInAction,
  type ValidateSignIn,
} from './validate.ts';

// Sign-ins find their record by the provider's account id, never by email. Auto-linking
// by email needs both sides to have verified it, or anyone could claim your account.

export interface AccountContext {
  db: DB;
  schema: Schema;
  effects: Effects;
  hooks: Hooks;
  storage?: Storage;
  logger: Logger;
  validateSignIn?: ValidateSignIn;
}

export interface Account {
  record: Row;
  /** Set when this sign-in linked the provider, so the owner can be told. */
  linkedTo?: string;
}

/** How a provider makes accounts: see `OAuth2ProviderOptions`. */
export interface SignUpPolicy extends ProfilePolicy {
  disableSignUp: boolean;
  refreshProfile: string[];
}

/**
 * Effects such as after hooks join `ctx.effects` only once committed: a failed
 * sign-in is a redirect, not an error, so the request would still run them.
 */
export async function accountFor(
  ctx: AccountContext,
  collection: AuthCollection,
  provider: SignUpPolicy,
  identity: Identity,
  linkRecordId: string | null,
): Promise<Account> {
  const effects = new Effects();
  const { refresh, ...account } = await ctx.db.transaction((tx) =>
    findAccount(
      { ...ctx, effects },
      tx,
      collection,
      provider,
      identity,
      linkRecordId,
    ),
  );
  ctx.effects.absorb(effects);
  // Done even if the sign-in fails after this, as on its auth rule.
  ctx.effects.commit();
  if (!refresh || provider.refreshProfile.length === 0) return account;
  return {
    ...account,
    record: await refreshProfile(ctx, collection, provider, identity, account),
  };
}

async function refreshProfile(
  ctx: AccountContext,
  collection: AuthCollection,
  policy: SignUpPolicy,
  identity: Identity,
  { record }: Account,
): Promise<Row> {
  const effects = new Effects();
  try {
    const all = await profileValues(collection, policy, identity.profile);
    const listed = Object.fromEntries(
      Object.entries(all).filter(([name]) =>
        policy.refreshProfile.includes(name),
      ),
    );
    const values = await resolveFiles(collection, policy, listed, ctx.logger);
    if (Object.keys(values).length === 0) return record;
    const id = record.id as string;
    await updateRecord(
      {
        ...systemContext({ ...ctx, effects }, values),
        ...(ctx.storage && { storage: ctx.storage }),
      },
      collection,
      id,
      values,
      new URLSearchParams(),
    );
    ctx.effects.absorb(effects);
    return (await findRecord(ctx.db, collection, id)) ?? record;
  } catch (error) {
    if (ctx.storage && effects.newFiles.length > 0) {
      await ctx.storage.delete(effects.newFiles).catch(() => {});
    }
    ctx.logger.failure(
      'oauth2',
      `the ${policy.name} profile of ${collection.name} was not refreshed`,
      error,
      'warn',
    );
    return record;
  }
}

async function findAccount(
  ctx: AccountContext,
  tx: Tx,
  collection: AuthCollection,
  policy: SignUpPolicy,
  identity: Identity,
  linkRecordId: string | null,
): Promise<Account & { refresh?: boolean }> {
  const provider = policy.name;
  // The app's check, with what the provider says about the account now.
  const check = (
    action: SignInAction,
    record: Record<string, unknown>,
  ): Promise<void> =>
    checkSignIn(ctx.validateSignIn, {
      action,
      method: 'oauth2',
      collection: collection.name,
      record,
      oauth2: { provider, profile: identity.profile },
    });
  const linked = await findLinked(tx, collection, provider, identity.id);
  if (linkRecordId !== null) {
    if (linked) {
      if (linked.id !== linkRecordId) throw alreadyLinked();
      await check('link', linked);
      return { record: linked };
    }
    const record = await findRecord(tx, collection, linkRecordId);
    if (!record) {
      throw new OAuth2Error('oauth2_failed', 'The account no longer exists.');
    }
    // A record without an email, such as one that signs in by phone, has
    // no address anyone could claim.
    if (record.email !== '' && record.emailVerified !== true) {
      throw new OAuth2Error(
        'email_not_verified',
        "Verify this account's email before linking a provider.",
      );
    }
    await check('link', record);
    await link(tx, collection, record.id as string, provider, identity.id);
    return { record, linkedTo: record.email as string };
  }
  if (linked) {
    await check('sign-in', linked);
    return { record: linked, refresh: true };
  }
  if (identity.email === undefined) {
    throw new OAuth2Error(
      'email_required',
      'The provider did not share an email address.',
    );
  }
  if (!identity.emailVerified) {
    throw new OAuth2Error(
      'email_not_verified',
      'The provider has not verified this email address.',
    );
  }
  const existing = await findByEmail(tx, collection, identity.email);
  if (existing) {
    // A provider linked here would be proven by the same inbox as an email code,
    // so an account with a second step links one only from inside.
    if (
      existing.emailVerified !== true ||
      !collection.implicitLinking ||
      (await takesSecondStep(
        ctx.db,
        ctx.schema,
        collection,
        existing.id as string,
      ))
    ) {
      throw new OAuth2Error(
        'account_exists',
        'An account with this email exists. Sign in to it, then link this provider.',
      );
    }
    await check('link', existing);
    await link(tx, collection, existing.id as string, provider, identity.id);
    return { record: existing, linkedTo: existing.email as string };
  }
  if (policy.disableSignUp) {
    throw new OAuth2Error(
      'sign_up_disabled',
      'This provider signs in existing accounts only. Sign up another way first.',
    );
  }
  const record = await signUp(
    { ...ctx, tx },
    collection,
    identity,
    policy,
    (values) => check('sign-up', values),
  );
  await link(tx, collection, record.id as string, provider, identity.id);
  return { record };
}

export async function listLinkedAccounts(
  q: Builder,
  collectionId: string,
  recordId: string,
): Promise<LinkedAccountModel[]> {
  const rows = await q
    .newQuery(
      `SELECT id, provider, created FROM {{${table('_linked_accounts')}}}
       WHERE collection_id = {:collectionId} AND record_id = {:recordId}
       ORDER BY created, id`,
    )
    .bind({ collectionId, recordId })
    .all<{ id: string; provider: string; created: Date }>();
  return rows.map((row) => ({ ...row, created: row.created.toISOString() }));
}

export async function unlinkAccount(
  q: Builder,
  collectionId: string,
  recordId: string,
  provider: string,
): Promise<boolean> {
  const deleted = await q
    .newQuery(
      `DELETE FROM {{${table('_linked_accounts')}}}
       WHERE collection_id = {:collectionId} AND record_id = {:recordId}
         AND provider = {:provider}
       RETURNING id`,
    )
    .bind({ collectionId, recordId, provider })
    .column();
  return deleted.length > 0;
}

/**
 * Unlinks every provider of a record whose owner just proved its email for
 * the first time. They were linked before anyone knew whose account it is.
 */
export async function unlinkUnproven(
  q: Builder,
  collectionId: string,
  recordId: string,
): Promise<void> {
  await q
    .newQuery(
      `DELETE FROM {{${table('_linked_accounts')}}}
       WHERE collection_id = {:collectionId} AND record_id = {:recordId}`,
    )
    .bind({ collectionId, recordId })
    .execute();
}

/**
 * The record a provider account is linked to, if any. Never links or signs
 * up, for a sign-in step that only proves an existing link.
 */
export async function findLinked(
  q: Builder,
  collection: AuthCollection,
  provider: string,
  providerId: string,
): Promise<Row | undefined> {
  const [recordId] = await q
    .newQuery(
      `SELECT record_id FROM {{${table('_linked_accounts')}}}
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
    'already_linked',
    'This provider account is linked to another account, or this account already has one from this provider.',
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
      `INSERT INTO {{${table('_linked_accounts')}}}
         (id, collection_id, record_id, provider, provider_id)
       VALUES ({:id}, {:collectionId}, {:recordId}, {:provider}, {:providerId})
       ON CONFLICT DO NOTHING
       RETURNING id`,
    )
    .bind({
      id: newId(),
      collectionId: collection.id,
      recordId,
      provider,
      providerId,
    })
    .column();
  if (inserted.length === 0) throw alreadyLinked();
}

async function signUp(
  ctx: AccountContext & { tx: Tx },
  collection: AuthCollection,
  identity: Identity,
  policy: SignUpPolicy,
  check: (values: Record<string, unknown>) => Promise<void>,
): Promise<Row> {
  const id = newId();
  const password = randomPassword(collection);
  const values = await resolveFiles(
    collection,
    policy,
    await profileValues(collection, policy, identity.profile),
    ctx.logger,
  );
  const input = {
    ...values,
    id,
    email: identity.email,
    password,
    passwordConfirm: password,
  };
  await check(input);
  const { tx, db: pool, schema, effects, hooks, storage } = ctx;
  try {
    await newRecord(
      {
        db: tx,
        pool,
        schema,
        ...(storage && { storage }),
        principal: { superuser: false },
        request: { method: 'POST', query: {}, headers: {}, body: input },
        effects,
        hooks,
        source: 'system',
      },
      collection,
      input,
      new URLSearchParams(),
    );
    // Only NextBase itself may mark a record verified. Sign-ups come only
    // from providers that verified the email.
    await updateRecord(
      systemContext(
        { db: tx, pool, schema, effects, hooks },
        {
          emailVerified: true,
        },
      ),
      collection,
      id,
      { emailVerified: true },
      new URLSearchParams(),
    );
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) {
      const [field, problem] = Object.entries(error.data)[0] ?? [];
      const message = (problem as { message?: unknown } | undefined)?.message;
      throw new OAuth2Error(
        error.status === 403 ? 'sign_up_disabled' : 'sign_up_failed',
        typeof message === 'string' ? `${field}: ${message}` : error.message,
        typeof message === 'string' ? field : undefined,
      );
    }
    throw error;
  }
  // Nobody knows the generated password, so it is never a sign-in step.
  await setPasswordOrigin(tx, collection.id, id, 'random');
  return (await findRecord(tx, collection, id)) as Row;
}
