import type { AuthCollection } from '@nextbasejs/client';
import { and, type DB, type Expression, hash, type Row } from '@nextbasejs/dbx';
import { table } from '../db/system.ts';
import { ApiError } from '../errors.ts';
import { compileFilter } from '../filter/compiler.ts';
import { normalizePhone } from '../phone.ts';
import type { Schema } from '../schema/cache.ts';
import { unstorableText } from '../storable.ts';
import { emailIs, phoneIs } from './identity.ts';
import {
  hashPassword,
  needsRehash,
  verifyDummyPassword,
  verifyPassword,
} from './password.ts';
import {
  accountKey,
  clearAttempts,
  countAttempt,
  identityKey,
} from './throttle.ts';

// The field caps passwords at 1024 chars; rejecting longer ones bounds hashing cost.
const MAX_PASSWORD_INPUT = 1024;

/** A sign-in refused until the account's email is verified. */
export class EmailNotVerified extends ApiError {
  readonly email: string;

  constructor(email: string) {
    super(403, 'Verify your email to sign in.');
    this.email = email;
  }
}

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
  await checkAuthFilter(db, schema, collection, id);
  await checkEmailVerified(db, collection, id);
}

/** The authRule alone, for sign-ins that check the email later or prove it. */
export async function checkAuthFilter(
  db: DB,
  schema: Schema,
  collection: AuthCollection,
  id: string,
): Promise<void> {
  const denied = new ApiError(
    403,
    'This account does not meet the requirements to sign in.',
  );
  if (collection.authRule === null) throw denied;
  if (
    collection.authRule !== '' &&
    !(await recordMatches(db, schema, collection, collection.authRule, id))
  ) {
    throw denied;
  }
}

/** Refuses an unverified email when the collection requires it. */
export async function checkEmailVerified(
  db: DB,
  collection: AuthCollection,
  id: string,
): Promise<void> {
  if (collection.emailVerification.required) {
    const [record] = await db
      .select('email', 'emailVerified')
      .from(table(collection.name))
      .where(hash({ id }))
      .all();
    if (record && record.email !== '' && record.emailVerified !== true) {
      throw new EmailNotVerified(record.email as string);
    }
  }
}

/**
 * Whether the record matches a sign-in rule, such as the authRule. The rule
 * sees no caller: it is about the record signing in.
 */
export async function recordMatches(
  db: DB,
  schema: Schema,
  collection: AuthCollection,
  source: string,
  id: string,
): Promise<boolean> {
  const rule = compileFilter(source, collection, 't0', {
    schema,
    principal: { superuser: false },
    request: { method: 'POST', query: {}, headers: {}, body: {} },
    mode: 'rule',
  });
  const rows = await db
    .select('t0.id')
    .from(`${table(collection.name)} t0`)
    .where(and(hash({ 't0.id': id }), rule))
    .column();
  return rows.length > 0;
}

/** Every failure is the same 400, so responses do not reveal which identities exist. */
export async function authWithPassword(
  db: DB,
  schema: Schema,
  collection: AuthCollection,
  identity: string,
  password: string,
): Promise<Row> {
  const failed = new ApiError(400, 'Failed to authenticate.');
  // No stored identity can contain text Postgres cannot store.
  if (unstorableText(identity) !== undefined) throw failed;
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
  // The email is checked by the caller, after the app's own check.
  await checkAuthFilter(db, schema, collection, record.id as string);

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
    if (!field || identity === '') continue;
    let condition: Expression;
    if (field.type === 'email') {
      condition = emailIs(name, identity);
    } else if (field.type === 'phone') {
      const phone = normalizePhone(identity);
      if (phone === undefined) continue;
      condition = phoneIs(name, phone);
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
