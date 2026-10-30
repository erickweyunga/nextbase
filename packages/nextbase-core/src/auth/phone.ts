import { createHash } from 'node:crypto';
import type { AuthCollection } from '@nextbasejs/client';
import { type Builder, type DB, hash, type Row } from '@nextbasejs/dbx';
import { table } from '../db/system.ts';
import type { Effects } from '../effects.ts';
import { ApiError } from '../errors.ts';
import { normalizePhone } from '../phone.ts';
import { newId } from '../random.ts';
import type { Hooks } from '../records/hooks.ts';
import { newRecord, systemContext, updateRecord } from '../records/service.ts';
import type { Schema } from '../schema/cache.ts';
import { randomPassword } from '../schema/fields.ts';
import { newCode, typedCode } from './codes.ts';
import { phoneIs } from './identity.ts';
import type { Mailer } from './mail.ts';
import type { Mfa } from './mfa.ts';
import { type PasswordOrigin, setPasswordOrigin } from './password-origins.ts';
import { type Principal, recordIn } from './principal.ts';
import type { Sms } from './sms.ts';
import {
  accountKey,
  clearAttempts,
  countAttempt,
  phoneKey,
  smsKey,
} from './throttle.ts';

// Sign-in and verification with codes texted to a phone.
// - Six-digit, single-use codes valid for 10 minutes.
// - Wrong guesses are limited per phone across all its codes, so requesting a
//   new code does not reset the count.
// - Answers are the same whether or not an account exists.
// - Texts per phone are capped, since each one costs money.

export interface PhoneContext {
  db: DB;
  schema: Schema;
  sms: Sms;
  mailer: Mailer;
  rejectBreachedPasswords: boolean;
  effects: Effects;
  hooks: Hooks;
  mfa: Mfa;
}

/** A code is accepted only for the purpose it was sent for. */
type CodePurpose = 'signIn' | 'passwordReset' | 'verifyPhone';

const CODE_LIFETIME = '10 minutes';
const MAX_CODE_ATTEMPTS = 5;
const SMS_LIMIT = { max: 5, window: '1 hour' };

const invalidCode = (): ApiError =>
  new ApiError(400, 'The code is invalid or has expired.', {
    code: { code: 'validation_invalid_code', message: 'Invalid or expired.' },
  });

/** Texts only an existing record's phone, or a new one the collection lets sign up. */
export function requestPhoneCode(
  ctx: PhoneContext,
  collection: AuthCollection,
  phone: unknown,
): Promise<void> {
  return sendCode(ctx, collection, phone, 'signIn');
}

/** Texts only when `phone` is a record's verified phone. */
export function requestPasswordResetByPhone(
  ctx: PhoneContext,
  collection: AuthCollection,
  phone: unknown,
): Promise<void> {
  return sendCode(ctx, collection, phone, 'passwordReset');
}

async function sendCode(
  ctx: PhoneContext,
  collection: AuthCollection,
  phoneInput: unknown,
  purpose: 'signIn' | 'passwordReset',
): Promise<void> {
  checkEnabled(collection);
  const phone = checkPhone(phoneInput);
  ctx.sms.check(phone);
  await countAttempt(ctx.db, [smsKey(collection.id, phone)], SMS_LIMIT);
  const record = await findByPhone(ctx.db, collection, phone);
  const usable =
    purpose === 'signIn'
      ? record !== undefined || collection.createRule !== null
      : record?.phoneVerified === true;
  if (!usable) return;
  const code = await issueCode(ctx.db, collection, phone, purpose);
  ctx.sms.send(purpose, collection.name, phone, code);
}

/**
 * Texts a new sign-in code to a record's verified phone and returns it, for
 * a second sign-in step that keeps the code itself. Texts per phone are
 * capped as for every code.
 */
export async function textSignInCode(
  ctx: Pick<PhoneContext, 'db' | 'sms'>,
  collection: AuthCollection,
  phone: string,
): Promise<string> {
  ctx.sms.check(phone);
  await countAttempt(ctx.db, [smsKey(collection.id, phone)], SMS_LIMIT);
  const code = newCode();
  ctx.sms.send('signIn', collection.name, phone, code);
  return code;
}

/** Whether texted codes can be a second sign-in step for `record`. */
export function textsCodes(collection: AuthCollection, record: Row): boolean {
  return (
    collection.phoneSignIn &&
    collection.id !== '_superusers' &&
    record.phoneVerified === true &&
    typeof record.phone === 'string' &&
    record.phone !== ''
  );
}

/** A new phone creates a record under the collection's create rule. */
export async function authWithPhoneCode(
  ctx: PhoneContext,
  collection: AuthCollection,
  phoneInput: unknown,
  codeInput: unknown,
): Promise<Row> {
  checkEnabled(collection);
  const phone = checkPhone(phoneInput);
  await consumeCode(ctx.db, collection, phone, 'signIn', codeInput);
  const existing = await findByPhone(ctx.db, collection, phone);
  if (existing) {
    if (existing.phoneVerified !== true) {
      await privilegedUpdate(ctx, collection, existing, {
        phoneVerified: true,
      });
    }
    return (await findRecord(ctx.db, collection, existing.id as string)) as Row;
  }
  const id = newId();
  const password = randomPassword(collection);
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
      request: { method: 'POST', query: {}, headers: {}, body: input },
      // Callers may not set phoneVerified themselves; the code just proved it.
      vouched: new Set(['phone', 'phoneVerified']),
      effects: ctx.effects,
      hooks: ctx.hooks,
      source: 'system',
    },
    collection,
    input,
    new URLSearchParams(),
  );
  // Nobody knows the generated password, so it is never a sign-in step.
  await setPasswordOrigin(ctx.db, collection.id, id, 'random');
  return (await findRecord(ctx.db, collection, id)) as Row;
}

export async function confirmPasswordResetByPhone(
  ctx: PhoneContext,
  collection: AuthCollection,
  input: Record<string, unknown>,
): Promise<void> {
  checkEnabled(collection);
  const phone = checkPhone(input.phone);
  await consumeCode(ctx.db, collection, phone, 'passwordReset', input.code);
  const record = await findByPhone(ctx.db, collection, phone);
  if (record?.phoneVerified !== true) throw invalidCode();
  // The update tells the owner their password changed, if they have an email.
  await privilegedUpdate(
    ctx,
    collection,
    record,
    { password: input.password, passwordConfirm: input.passwordConfirm },
    'phoneReset',
  );
  await ctx.mfa.resetNotice(ctx.db, ctx.schema, collection, record, 'phone');
  await clearAttempts(ctx.db, [accountKey(collection.id, record.id as string)]);
}

/**
 * Setting or changing the phone needs the current password, and with an
 * authenticator app a code from it: a stolen session cannot move the
 * account to the thief's phone.
 */
export async function requestPhoneVerification(
  ctx: PhoneContext,
  collection: AuthCollection,
  principal: Principal,
  input: Record<string, unknown>,
): Promise<void> {
  const record = signedIn(collection, principal);
  checkEnabled(collection);
  const phone = checkPhone(input.phone);
  await reauthenticateFor(ctx, collection, record, phone, input);
  ctx.sms.check(phone);
  await countAttempt(ctx.db, [smsKey(collection.id, phone)], SMS_LIMIT);
  // Uniqueness is checked on confirm, so this request does not reveal it.
  const code = await issueCode(
    ctx.db,
    collection,
    phone,
    'verifyPhone',
    record.id as string,
  );
  ctx.sms.send('verifyPhone', collection.name, phone, code);
}

/** A new phone is a new way in, so other sessions end and the old phone and email are told. */
export async function confirmPhoneVerification(
  ctx: PhoneContext,
  collection: AuthCollection,
  principal: Principal,
  input: Record<string, unknown>,
): Promise<void> {
  const record = signedIn(collection, principal);
  checkEnabled(collection);
  const phone = checkPhone(input.phone);
  await reauthenticateFor(ctx, collection, record, phone, input);
  await consumeCode(
    ctx.db,
    collection,
    phone,
    'verifyPhone',
    input.code,
    record.id as string,
  );
  const previous = record.phone as string;
  try {
    await updateRecord(
      systemContext(ctx, { phone, phoneVerified: true }, principal),
      collection,
      record.id as string,
      { phone, phoneVerified: true },
      new URLSearchParams(),
    );
  } catch (error) {
    if (error instanceof ApiError && error.data.phone) {
      throw new ApiError(400, 'Failed to verify the phone.', error.data);
    }
    throw error;
  }
  if (previous !== '' && previous !== phone) {
    ctx.sms.send('phoneChanged', collection.name, previous);
  }
  if (previous !== phone && record.email) {
    ctx.mailer.send('phoneChanged', collection.name, record.email as string);
  }
}

// Only when the phone would be new or changed: confirming the same
// verified phone again adds no way in.
async function reauthenticateFor(
  ctx: PhoneContext,
  collection: AuthCollection,
  record: Row,
  phone: string,
  input: Record<string, unknown>,
): Promise<void> {
  if (record.phone === phone && record.phoneVerified === true) return;
  await ctx.mfa.reauthenticate(ctx.db, collection, record, input);
}

async function findByPhone(
  q: Builder,
  collection: AuthCollection,
  phone: string,
): Promise<Row | undefined> {
  const [record] = await q
    .select()
    .from(table(collection.name))
    .where(phoneIs('phone', phone))
    .limit(1)
    .all();
  return record;
}

function checkEnabled(collection: AuthCollection): void {
  if (!collection.phoneSignIn || collection.id === '_superusers') {
    throw new ApiError(
      400,
      'Phone sign-in is not enabled for this collection.',
    );
  }
}

function checkPhone(value: unknown): string {
  const phone = typeof value === 'string' ? normalizePhone(value) : undefined;
  if (phone === undefined) {
    throw new ApiError(400, 'Failed to use the phone number.', {
      phone: {
        code: 'validation_invalid_phone',
        message:
          'Must be a valid phone number in international format, such as +255712345678.',
      },
    });
  }
  return phone;
}

function signedIn(collection: AuthCollection, principal: Principal): Row {
  return recordIn(principal, collection, 'verify a phone');
}

// Hashed and salted with the purpose, so a database leak shows no live codes.
function codeHash(
  collection: AuthCollection,
  phone: string,
  purpose: CodePurpose,
  code: string,
): string {
  return createHash('sha256')
    .update(`${collection.id}:${phone}:${purpose}:${code}`)
    .digest('hex');
}

/** Replaces any earlier code for the same phone and purpose. */
async function issueCode(
  q: Builder,
  collection: AuthCollection,
  phone: string,
  purpose: CodePurpose,
  recordId = '',
): Promise<string> {
  const code = newCode();
  await q
    .newQuery(`DELETE FROM {{${table('_phone_codes')}}} WHERE expires <= now()`)
    .execute();
  await q
    .newQuery(
      `INSERT INTO {{${table('_phone_codes')}}}
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
 * Counts the guess per phone before checking, so neither parallel guesses nor
 * new codes get around the limit.
 */
async function consumeCode(
  db: DB,
  collection: AuthCollection,
  phone: string,
  purpose: CodePurpose,
  codeInput: unknown,
  recordId = '',
): Promise<void> {
  const key = phoneKey(collection.id, phone);
  await countAttempt(db, [key]);
  const code = typedCode(codeInput);
  if (code === undefined) throw invalidCode();
  const [stored] = await db
    .newQuery(
      `DELETE FROM {{${table('_phone_codes')}}}
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
      `UPDATE {{${table('_phone_codes')}}} SET attempts = attempts + 1
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

async function privilegedUpdate(
  ctx: PhoneContext,
  collection: AuthCollection,
  record: Row,
  input: Record<string, unknown>,
  passwordOrigin?: PasswordOrigin,
): Promise<void> {
  await updateRecord(
    {
      ...systemContext(ctx, input),
      ...(passwordOrigin !== undefined && { passwordOrigin }),
    },
    collection,
    record.id as string,
    input,
    new URLSearchParams(),
  );
}
