import { ClientError, type NextBaseClient } from '@nextbasejs/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type MailMessage,
  NextBase,
  type SignInCheck,
  type SmsMessage,
} from '../src/index.ts';
import { createTestDatabase, type TestDatabase } from './postgres.ts';

const PASSWORD = 'password 123 456';

describe('validateSignIn', () => {
  let t: TestDatabase;
  let nextbase: NextBase;
  let admin: NextBaseClient;
  const checks: SignInCheck[] = [];
  const mails: MailMessage[] = [];
  const texts: SmsMessage[] = [];
  const pending: Promise<unknown>[] = [];

  const failure = async (promise: Promise<unknown>): Promise<ClientError> => {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClientError);
    return error as ClientError;
  };
  const users = () => nextbase.client().collection('users');
  const last = (): SignInCheck | undefined => checks.at(-1);

  beforeAll(async () => {
    t = await createTestDatabase();
    nextbase = new NextBase({
      database: t.pool,
      mail: {
        from: 'app@example.com',
        appUrl: 'https://app.example.com',
        send: async (message) => {
          mails.push(message);
        },
      },
      sms: {
        send: async (message) => {
          texts.push(message);
        },
      },
      waitUntil: (promise) => pending.push(promise),
      logs: false,
      rateLimits: false,
      validateSignIn: async (check) => {
        checks.push(check);
        const email = String(check.record.email ?? '');
        if (email.endsWith('@blocked.example')) {
          return {
            error: 'email_not_allowed',
            message: 'Use your work email.',
          };
        }
        if (check.record.phone === '+255700000009') {
          return { error: 'phone_not_allowed' };
        }
        return undefined;
      },
    });
    admin = nextbase.client({ superuser: true });
    await admin.collections.create({
      name: 'users',
      type: 'auth',
      createRule: '',
      viewRule: 'id = @request.auth.id',
      phoneSignIn: true,
      otp: { enabled: true },
    });
  });
  afterAll(async () => {
    await nextbase.flush();
    await t.close();
  });

  it('refuses a sign-up before anything is written, and never shows the password', async () => {
    const error = await failure(
      users().signUp({
        email: 'eve@blocked.example',
        password: PASSWORD,
        passwordConfirm: PASSWORD,
      }),
    );
    expect(error.status).toBe(403);
    expect(error.message).toBe('Use your work email.');
    expect(error.data).toMatchObject({
      account: { code: 'email_not_allowed' },
    });
    expect(last()).toMatchObject({
      action: 'sign-up',
      method: 'password',
      collection: 'users',
    });
    expect(last()?.record).not.toHaveProperty('password');
    expect(last()?.record).not.toHaveProperty('passwordConfirm');
    expect(Object.isFrozen(last()?.record)).toBe(true);
    expect((await t.pool.query('SELECT 1 FROM nextbase.users')).rows).toEqual(
      [],
    );
  });

  it('checks every password sign-in, as the account is now', async () => {
    const record = await admin.collection('users').create({
      email: 'ann@example.com',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    await users().signInWithPassword('ann@example.com', PASSWORD);
    expect(last()).toMatchObject({
      action: 'sign-in',
      method: 'password',
      record: { email: 'ann@example.com' },
    });
    expect(last()?.record).not.toHaveProperty('tokenKey');
    // An email moved out of the allowed domain no longer signs in.
    await admin
      .collection('users')
      .update(record?.id ?? '', { email: 'ann@blocked.example' });
    const error = await failure(
      users().signInWithPassword('ann@blocked.example', PASSWORD),
    );
    expect(error.status).toBe(403);
    // A wrong password is refused as one, before the check.
    const before = checks.length;
    await failure(users().signInWithPassword('ann@blocked.example', 'wrong!'));
    expect(checks).toHaveLength(before);
  });

  it('checks a sign-in by email code', async () => {
    await admin.collection('users').create({
      email: 'otp@blocked.example',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    const otpId = await users().requestOtp('otp@blocked.example');
    await Promise.all(pending.splice(0));
    const code =
      /(\d{6})/.exec(
        mails.filter((m) => m.to === 'otp@blocked.example').at(-1)?.text ?? '',
      )?.[1] ?? '';
    const error = await failure(users().signInWithOtp(otpId, code));
    expect(error.status).toBe(403);
    expect(last()).toMatchObject({ action: 'sign-in', method: 'emailCode' });
  });

  it('checks a phone sign-up and sign-in', async () => {
    const codeFor = async (phone: string): Promise<string> => {
      await users().requestPhoneCode(phone);
      await Promise.all(pending.splice(0));
      return (
        /(\d{6})/.exec(
          texts.filter((m) => m.to === phone).at(-1)?.text ?? '',
        )?.[1] ?? ''
      );
    };
    const refused = await failure(
      users().signInWithPhoneCode(
        '+255700000009',
        await codeFor('+255700000009'),
      ),
    );
    expect(refused.data).toMatchObject({
      account: { code: 'phone_not_allowed' },
    });
    expect(last()).toMatchObject({ action: 'sign-up', method: 'phoneCode' });
    expect(
      (
        await t.pool.query(
          "SELECT 1 FROM nextbase.users WHERE phone = '+255700000009'",
        )
      ).rows,
    ).toEqual([]);

    await users().signInWithPhoneCode(
      '+255700000001',
      await codeFor('+255700000001'),
    );
    await users().signInWithPhoneCode(
      '+255700000001',
      await codeFor('+255700000001'),
    );
    expect(last()).toMatchObject({
      action: 'sign-in',
      method: 'phoneCode',
      record: { phone: '+255700000001' },
    });
  });

  it('checks accounts created directly or in a batch, but not by superusers', async () => {
    const values = {
      email: 'direct@blocked.example',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    };
    expect((await failure(users().create(values))).status).toBe(403);
    const batch = nextbase.client().createBatch();
    batch.collection('users').create(values);
    const refused = await failure(batch.send());
    // As for any write a batch refuses: per request, and nothing saved.
    expect(refused.data).toMatchObject({
      requests: { 0: { account: { code: 'email_not_allowed' } } },
    });
    expect(await admin.collection('users').create(values)).toMatchObject({
      email: 'direct@blocked.example',
    });
  });

  it('leaves the email unproven when the check refuses an email code', async () => {
    await admin.collection('users').create({
      email: 'late@blocked.example',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    const otpId = await users().requestOtp('late@blocked.example');
    await Promise.all(pending.splice(0));
    const code =
      /(\d{6})/.exec(
        mails.filter((m) => m.to === 'late@blocked.example').at(-1)?.text ?? '',
      )?.[1] ?? '';
    expect((await failure(users().signInWithOtp(otpId, code))).status).toBe(
      403,
    );
    const { rows } = await t.pool.query(
      `SELECT "emailVerified" FROM nextbase.users WHERE email = 'late@blocked.example'`,
    );
    expect(rows).toEqual([{ emailVerified: false }]);
  });

  it('refuses an app check that answers a malformed code', async () => {
    const strict = new NextBase({
      database: t.pool,
      logs: false,
      rateLimits: false,
      validateSignIn: () => ({ error: 'Not A Code' }),
    });
    const reply = await strict.handle(
      new Request(
        'http://localhost:3000/api/nextbase/collections/users/sign-up',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: 'odd@example.com',
            password: PASSWORD,
            passwordConfirm: PASSWORD,
          }),
        },
      ),
    );
    expect(reply.status).toBe(500);
    await strict.flush();
    expect(() => new NextBase({ validateSignIn: 'yes' as never })).toThrow(
      TypeError,
    );
  });
});
