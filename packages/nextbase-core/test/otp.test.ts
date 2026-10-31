import { ClientError, type NextBaseClient } from '@nextbasejs/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MailMessage, NextBase } from '../src/index.ts';
import { createTestDatabase, type TestDatabase } from './postgres.ts';

const PASSWORD = 'password 123 456';

describe('sign-in by email code', () => {
  let t: TestDatabase;
  let nextbase: NextBase;
  let admin: NextBaseClient;
  const sent: MailMessage[] = [];
  const pending: Promise<unknown>[] = [];

  /** The code last emailed to `to`. */
  const codeTo = async (to: string): Promise<string> => {
    await Promise.all(pending.splice(0));
    const message = sent.filter((m) => m.to === to).at(-1);
    return /(\d{6}) is your sign-in code/.exec(message?.text ?? '')?.[1] ?? '';
  };
  const failure = async (promise: Promise<unknown>): Promise<ClientError> => {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClientError);
    return error as ClientError;
  };
  const users = () => nextbase.client().collection('users');
  const account = (email: string) =>
    admin.collection('users').create({
      email,
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });

  beforeAll(async () => {
    t = await createTestDatabase();
    nextbase = new NextBase({
      database: t.pool,
      mail: {
        from: 'app@example.com',
        appUrl: 'https://app.example.com',
        send: async (message) => {
          sent.push(message);
        },
      },
      waitUntil: (promise) => pending.push(promise),
      logs: false,
      rateLimits: false,
    });
    admin = nextbase.client({ superuser: true });
    await admin.collections.create({
      name: 'users',
      type: 'auth',
      viewRule: 'id = @request.auth.id',
      otp: { enabled: true },
    });
  });
  afterAll(async () => {
    await nextbase.flush();
    await t.close();
  });

  it('signs in with the code it emails, and counts the email verified', async () => {
    await account('ann@example.com');
    expect((await users().listAuthMethods()).otp).toEqual({ enabled: true });
    const otpId = await users().requestOtp('ANN@example.com');
    const { record, token, methods } = await users().signInWithOtp(
      otpId,
      await codeTo('ann@example.com'),
    );
    expect(record).toMatchObject({
      email: 'ann@example.com',
      emailVerified: true,
    });
    expect(typeof token).toBe('string');
    expect(methods).toEqual(['emailCode']);
  });

  it('answers an unknown email as a known one, with an id no code matches', async () => {
    const otpId = await users().requestOtp('nobody@example.com');
    expect(otpId).toMatch(/^[\w-]{32}$/);
    const error = await failure(users().signInWithOtp(otpId, '123456'));
    expect(error.status).toBe(400);
    expect(error.data).toMatchObject({
      code: { code: 'validation_invalid_code' },
    });
  });

  it('works once, ends after five wrong codes, and expires', async () => {
    await account('bob@example.com');
    const once = await users().requestOtp('bob@example.com');
    const code = await codeTo('bob@example.com');
    await users().signInWithOtp(once, code);
    expect((await failure(users().signInWithOtp(once, code))).status).toBe(400);

    const guessed = await users().requestOtp('bob@example.com');
    const right = await codeTo('bob@example.com');
    for (let i = 0; i < 5; i++) {
      await failure(
        users().signInWithOtp(
          guessed,
          right === '000000' ? '111111' : '000000',
        ),
      );
    }
    await failure(users().signInWithOtp(guessed, right));

    const late = await users().requestOtp('bob@example.com');
    await t.pool.query(
      "UPDATE nextbase._otps SET expires = now() - interval '1 second'",
    );
    await failure(users().signInWithOtp(late, await codeTo('bob@example.com')));
  });

  it('signs nothing in with a code sent before the email changed', async () => {
    const record = await account('cat@example.com');
    const otpId = await users().requestOtp('cat@example.com');
    const code = await codeTo('cat@example.com');
    await admin
      .collection('users')
      .update(record?.id ?? '', { email: 'cat2@example.com' });
    await failure(users().signInWithOtp(otpId, code));
    const { rows } = await t.pool.query(
      `SELECT "emailVerified" FROM nextbase.users WHERE email = 'cat2@example.com'`,
    );
    expect(rows).toEqual([{ emailVerified: false }]);
  });

  it('is off unless the collection turns it on', async () => {
    await admin.collections.create({ name: 'closed', type: 'auth' });
    const closed = nextbase.client().collection('closed');
    expect((await closed.listAuthMethods()).otp).toEqual({ enabled: false });
    expect((await failure(closed.requestOtp('x@example.com'))).status).toBe(
      400,
    );
  });

  it('counts as the email code step of a sign-in that takes two', async () => {
    await admin.collections.update('users', {
      mfa: { enabled: true, rule: '' },
    });
    try {
      await account('dan@example.com');
      const otpId = await users().requestOtp('dan@example.com');
      const error = await failure(
        users().signInWithOtp(otpId, await codeTo('dan@example.com')),
      );
      expect(error.status).toBe(401);
      expect(error.mfa?.methods).toEqual(['password']);
    } finally {
      await admin.collections.update('users', {
        mfa: { enabled: false, rule: null },
      });
    }
  });
});
