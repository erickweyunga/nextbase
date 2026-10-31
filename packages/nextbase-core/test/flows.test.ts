import { ClientError, type NextBaseClient } from '@nextbasejs/client';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type MailMessage, NextBase } from '../src/index.ts';
import { call } from './http.ts';
import { createTestDatabase, type TestDatabase } from './postgres.ts';

const PASSWORD = 'password 123 456';

describe('email verification, password reset and email change', () => {
  let t: TestDatabase;
  let nextbase: NextBase;
  let admin: NextBaseClient;
  const sent: MailMessage[] = [];
  const pending: Promise<unknown>[] = [];

  /** Waits for the emails sent in the background. */
  const flush = async (): Promise<void> => {
    await Promise.all(pending.splice(0));
  };
  const lastTo = (to: string): MailMessage => {
    const message = sent.filter((m) => m.to === to).at(-1);
    if (!message) throw new Error(`No email to ${to}.`);
    return message;
  };
  const tokenIn = (message: MailMessage): string =>
    /token=([\w.-]+)/.exec(message.text)?.[1] ?? '';
  const failure = async (promise: Promise<unknown>): Promise<ClientError> => {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClientError);
    return error as ClientError;
  };
  const signUp = async (email: string): Promise<NextBaseClient> => {
    const nb = nextbase.client();
    await nb
      .collection('users')
      .signUp({ email, password: PASSWORD, passwordConfirm: PASSWORD });
    return nb;
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    nextbase = new NextBase({
      database: t.pool,
      mail: {
        from: 'app@example.com',
        appUrl: 'https://app.example.com/base/',
        send: async (message) => {
          sent.push(message);
        },
      },
      waitUntil: (promise) => pending.push(promise),
    });
    admin = nextbase.client({ superuser: true });
    await admin.collections.create({
      name: 'users',
      type: 'auth',
      createRule: '',
      viewRule: 'id = @request.auth.id',
    });
  });
  afterAll(async () => {
    // Log entries still waiting would be written to an ended pool.
    await nextbase.flush();
    await t.close();
  });

  it('lists how a collection signs in', async () => {
    expect(
      await nextbase.client().collection('users').listAuthMethods(),
    ).toEqual({
      password: { enabled: true, identityFields: ['email'] },
      oauth2: { enabled: false, providers: [] },
      phone: { enabled: false },
      otp: { enabled: false },
      passkey: { enabled: false },
      mfa: { enabled: false, duration: 300 },
    });
    await admin.collections.create({
      name: 'closed',
      type: 'auth',
      authRule: null,
    });
    expect(
      (await nextbase.client().collection('closed').listAuthMethods()).password
        .enabled,
    ).toBe(false);
    expect(
      (await failure(nextbase.client().collection('nope').listAuthMethods()))
        .status,
    ).toBe(404);
  });

  it('verifies an email through a link built from appUrl, never the Host header', async () => {
    await signUp('ann@example.com');
    const users = nextbase.client().collection('users');
    // A forged Host must not end up in the link.
    const reply = await nextbase.handle(
      new Request(
        'https://evil.example/api/nextbase/collections/users/request-email-verification',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', host: 'evil.example' },
          body: JSON.stringify({ email: 'ANN@example.com' }),
        },
      ),
    );
    expect(reply.status).toBe(204);
    await flush();
    const message = lastTo('ann@example.com');
    expect(message).toMatchObject({
      from: 'app@example.com',
      subject: 'Verify your email',
    });
    expect(message.text).toMatch(
      /https:\/\/app\.example\.com\/base\/verify-email\?token=[\w.-]+/,
    );
    expect(message.text).not.toContain('evil');

    await users.confirmEmailVerification(tokenIn(message));
    expect(
      (
        await admin
          .collection('users')
          .getFirstListItem('email = "ann@example.com"')
      ).emailVerified,
    ).toBe(true);
    // Verified already: the link stays harmless.
    await users.confirmEmailVerification(tokenIn(message));
    await users.requestEmailVerification('ann@example.com');
    await flush();
    expect(sent.filter((m) => m.to === 'ann@example.com')).toHaveLength(1);

    const forged = await failure(users.confirmEmailVerification('not.a.token'));
    expect(forged.data).toMatchObject({
      token: { code: 'validation_invalid_token' },
    });
  });

  it('answers the same for accounts that do not exist', async () => {
    const before = sent.length;
    const users = nextbase.client().collection('users');
    await users.requestEmailVerification('nobody@example.com');
    await users.requestPasswordReset('nobody@example.com');
    await flush();
    expect(sent.length).toBe(before);
    expect(
      (await failure(users.requestPasswordReset('not an email'))).data,
    ).toMatchObject({ email: { code: 'validation_invalid_email' } });
  });

  it('resets a password once, ending every session, a lockout, and telling the owner', async () => {
    const ben = await signUp('ben@example.com');
    const users = nextbase.client().collection('users');
    // Ben is locked out by someone guessing.
    for (let i = 0; i < 11; i++) {
      await call(nextbase, 'POST', '/collections/users/auth-with-password', {
        body: { identity: 'ben@example.com', password: 'wrong guess here' },
      });
    }
    expect(
      (await failure(users.signInWithPassword('ben@example.com', PASSWORD)))
        .status,
    ).toBe(429);

    await users.requestPasswordReset('ben@example.com');
    await flush();
    const message = lastTo('ben@example.com');
    expect(message.text).toContain(
      'https://app.example.com/base/reset-password?token=',
    );
    const token = tokenIn(message);

    const weak = await failure(
      users.confirmPasswordReset(token, 'short', 'short'),
    );
    expect(weak.data).toMatchObject({
      password: { code: 'validation_length_out_of_range' },
    });
    const mismatch = await failure(
      users.confirmPasswordReset(
        token,
        'brand new password',
        'another password!',
      ),
    );
    expect(mismatch.data).toMatchObject({
      passwordConfirm: { code: 'validation_values_mismatch' },
    });

    await users.confirmPasswordReset(
      token,
      'brand new password',
      'brand new password',
    );
    await flush();
    expect(lastTo('ben@example.com').subject).toBe('Your password was changed');
    // The old session ended; the link is spent; no automatic sign-in.
    expect((await failure(ben.getSession())).status).toBe(401);
    expect(
      (
        await failure(
          users.confirmPasswordReset(
            token,
            'another long pw!',
            'another long pw!',
          ),
        )
      ).status,
    ).toBe(400);
    // The lockout ended with the reset, and the email is now verified.
    const signedIn = await users.signInWithPassword(
      'ben@example.com',
      'brand new password',
    );
    expect(signedIn.record.emailVerified).toBe(true);
  });

  it('tells the owner of a password change, once the change is saved', async () => {
    await admin.collections.update('users', {
      updateRule: 'id = @request.auth.id',
    });
    const nb = await signUp('ola@example.com');
    const id = nb.authStore.record?.id as string;
    const change = {
      oldPassword: PASSWORD,
      password: 'a new password 789',
      passwordConfirm: 'a new password 789',
    };
    // A batch that fails saves nothing, so nobody is told.
    const failed = await call(nextbase, 'POST', '/batch', {
      token: nb.authStore.token,
      body: {
        requests: [
          {
            method: 'PATCH',
            url: `/collections/users/records/${id}`,
            body: change,
          },
          { method: 'PATCH', url: '/collections/users/records/nope', body: {} },
        ],
      },
    });
    expect(failed.status).toBe(400);
    await flush();
    expect(sent.filter((m) => m.to === 'ola@example.com')).toEqual([]);

    await nb.collection('users').update(id, change);
    await flush();
    expect(lastTo('ola@example.com').subject).toBe('Your password was changed');
    await admin.collections.update('users', { updateRule: null });
  });

  it('changes an email with a link to the new address and the current password', async () => {
    const cy = await signUp('cy@example.com');
    const users = cy.collection('users');
    expect(
      (
        await failure(
          nextbase
            .client()
            .collection('users')
            .requestEmailChange('x@example.com'),
        )
      ).status,
    ).toBe(401);
    expect(
      (await failure(users.requestEmailChange('CY@example.com'))).data,
    ).toMatchObject({ newEmail: { code: 'validation_same_email' } });

    await users.requestEmailChange('cy.new@example.com');
    await flush();
    const message = lastTo('cy.new@example.com');
    expect(message.text).toContain(
      'https://app.example.com/base/confirm-email-change?token=',
    );
    const token = tokenIn(message);

    const anonymous = nextbase.client().collection('users');
    const wrong = await failure(
      anonymous.confirmEmailChange(token, 'not my password!'),
    );
    expect(wrong.data).toMatchObject({
      password: { code: 'validation_invalid_password' },
    });
    await anonymous.confirmEmailChange(token, PASSWORD);
    await flush();
    expect(lastTo('cy@example.com').subject).toBe('Your email was changed');
    expect((await failure(cy.getSession())).status).toBe(401);
    const moved = await anonymous.signInWithPassword(
      'cy.new@example.com',
      PASSWORD,
    );
    expect(moved.record).toMatchObject({
      email: 'cy.new@example.com',
      emailVerified: true,
    });
    // Spent: the email changed, so the token no longer matches.
    expect(
      (await failure(anonymous.confirmEmailChange(token, PASSWORD))).status,
    ).toBe(400);
  });

  it('refuses an email change to an address someone took meanwhile', async () => {
    const dee = await signUp('dee@example.com');
    await dee.collection('users').requestEmailChange('taken@example.com');
    await flush();
    const token = tokenIn(lastTo('taken@example.com'));
    await signUp('taken@example.com');
    const taken = await failure(
      nextbase.client().collection('users').confirmEmailChange(token, PASSWORD),
    );
    expect(taken.data).toMatchObject({
      email: { code: 'validation_not_unique' },
    });
  });

  it('resets a password only once, however many requests use the link at the same time', async () => {
    await signUp('gil@example.com');
    const users = nextbase.client().collection('users');
    await users.requestPasswordReset('gil@example.com');
    await flush();
    const token = tokenIn(lastTo('gil@example.com'));
    const passwords = ['first new password', 'second new password'];
    const results = await Promise.allSettled(
      passwords.map((p) => users.confirmPasswordReset(token, p, p)),
    );
    const done = results.flatMap((r, i) =>
      r.status === 'fulfilled' ? [passwords[i] as string] : [],
    );
    expect(done).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected');
    expect((refused as PromiseRejectedResult).reason).toMatchObject({
      status: 400,
      data: { token: { code: 'validation_invalid_token' } },
    });
    await users.signInWithPassword('gil@example.com', done[0] as string);
  });

  it('changes an email only once, however many requests use the link at the same time', async () => {
    const hal = await signUp('hal@example.com');
    await hal.collection('users').requestEmailChange('hal.new@example.com');
    await flush();
    const token = tokenIn(lastTo('hal.new@example.com'));
    const users = nextbase.client().collection('users');
    const results = await Promise.allSettled([
      users.confirmEmailChange(token, PASSWORD),
      users.confirmEmailChange(token, PASSWORD),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    await flush();
    expect(
      sent.filter(
        (m) =>
          m.to === 'hal@example.com' && m.subject === 'Your email was changed',
      ),
    ).toHaveLength(1);
  });

  it('refuses a forged token whose claims could not be stored', async () => {
    const { id: collectionId } = await admin.collections.getOne('users');
    const forge = (type: string) =>
      new SignJWT({ type, id: 'abc\u0000', collectionId, email: 'x@y.z' })
        .setProtectedHeader({ alg: 'HS256' })
        .sign(new TextEncoder().encode('any key'));
    const users = nextbase.client().collection('users');
    for (const attempt of [
      async () => users.confirmEmailVerification(await forge('verification')),
      async () =>
        users.confirmPasswordReset(
          await forge('passwordReset'),
          PASSWORD,
          PASSWORD,
        ),
      async () =>
        users.confirmEmailChange(await forge('emailChange'), PASSWORD),
    ]) {
      const error = await failure(attempt());
      expect(error.status).toBe(400);
      expect(error.data).toMatchObject({
        token: { code: 'validation_invalid_token' },
      });
    }
  });

  it('limits emails per address, so no one can flood an inbox', async () => {
    await signUp('eve@example.com');
    const users = nextbase.client().collection('users');
    for (let i = 0; i < 10; i++)
      await users.requestPasswordReset('eve@example.com');
    expect(
      (await failure(users.requestPasswordReset('eve@example.com'))).status,
    ).toBe(429);
    await flush();
  });

  it('needs mail in production, logs emails in development, and wants an HTTPS appUrl', async () => {
    const plain = new NextBase({
      database: t.pool,
      waitUntil: (p) => pending.push(p),
    });
    const users = plain.client().collection('users');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await users.requestPasswordReset('ann@example.com');
      await flush();
      expect(String(info.mock.calls.at(-1)?.[0])).toMatch(
        /passwordReset email to ann@example\.com was not sent[\s\S]*Token: /,
      );
    } finally {
      info.mockRestore();
    }
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const error = await failure(
        users.requestPasswordReset('ann@example.com'),
      );
      expect(error.data).toMatchObject({
        mail: { code: 'mail_not_configured' },
      });
    } finally {
      vi.unstubAllEnvs();
    }
    const mail = { from: 'a@example.com', send: async () => {} };
    expect(
      () =>
        new NextBase({ mail: { ...mail, appUrl: 'http://app.example.com' } }),
    ).toThrow(/HTTPS/);
    expect(
      () =>
        new NextBase({ mail: { ...mail, appUrl: 'http://localhost:3000' } }),
    ).not.toThrow();
  });
});
