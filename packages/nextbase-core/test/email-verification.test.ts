import { ClientError, type NextBaseClient } from '@nextbasejs/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MailMessage, NextBase } from '../src/index.ts';
import { call } from './http.ts';
import { createTestDatabase, type TestDatabase } from './postgres.ts';

const PASSWORD = 'password 123 456';

describe('email verification options', () => {
  let t: TestDatabase;
  let nextbase: NextBase;
  let admin: NextBaseClient;
  const sent: MailMessage[] = [];
  const pending: Promise<unknown>[] = [];

  const flush = async (): Promise<void> => {
    await Promise.all(pending.splice(0));
  };
  const to = (address: string): MailMessage[] =>
    sent.filter((m) => m.to === address);
  const failure = async (promise: Promise<unknown>): Promise<ClientError> => {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClientError);
    return error as ClientError;
  };
  const signUp = (collection: string, email: string) =>
    call(nextbase, 'POST', `/collections/${collection}/sign-up`, {
      body: { email, password: PASSWORD, passwordConfirm: PASSWORD },
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
      name: 'members',
      type: 'auth',
      createRule: '',
      emailVerification: {
        required: true,
        sendOnSignUp: true,
        sendOnSignIn: true,
      },
    });
  });
  afterAll(async () => {
    await nextbase.flush();
    await t.close();
  });

  it('defaults every option to off, and checks their types', async () => {
    const plain = await admin.collections.create({
      name: 'plain',
      type: 'auth',
    });
    expect(plain).toMatchObject({
      emailVerification: {
        required: false,
        sendOnSignUp: false,
        sendOnSignIn: false,
      },
    });
    const kept = await admin.collections.update('plain', {
      emailVerification: { required: true },
    });
    expect(kept).toMatchObject({
      emailVerification: { required: true, sendOnSignUp: false },
    });
    const invalid = await failure(
      admin.collections.update('plain', {
        // Checked on the server, whatever the types say.
        emailVerification: 'yes' as never,
      }),
    );
    expect(invalid.data).toMatchObject({
      emailVerification: { code: 'validation_invalid_type' },
    });
    const superusers = await admin.collections.getOne('_superusers');
    expect(superusers).toMatchObject({
      emailVerification: { required: false },
    });
  });

  it('sends the link on sign-up, and refuses sign-in until it is opened', async () => {
    const reply = await signUp('members', 'ann@example.com');
    expect(reply.status).toBe(202);
    await flush();
    const [link] = to('ann@example.com');
    expect(link?.subject).toBe('Verify your email');

    const members = nextbase.client().collection('members');
    const refused = await failure(
      members.signInWithPassword('ann@example.com', PASSWORD),
    );
    expect(refused.status).toBe(403);
    expect(refused.message).toBe('Verify your email to sign in.');

    const token = /token=([\w.-]+)/.exec(link?.text ?? '')?.[1] ?? '';
    await members.confirmEmailVerification(token);
    const { record } = await members.signInWithPassword(
      'ann@example.com',
      PASSWORD,
    );
    expect(record.email).toBe('ann@example.com');
  });

  it('sends the link again on a sign-in with the right password only', async () => {
    await signUp('members', 'bob@example.com');
    await flush();
    const before = to('bob@example.com').length;
    const members = nextbase.client().collection('members');
    await failure(members.signInWithPassword('bob@example.com', 'wrong one!!'));
    await flush();
    expect(to('bob@example.com')).toHaveLength(before);

    // Throttled per address: the one on sign-up was just sent, so a refused
    // second one does not turn the 403 into anything else.
    await t.pool.query('DELETE FROM nextbase._auth_attempts');
    const refused = await failure(
      members.signInWithPassword('bob@example.com', PASSWORD),
    );
    expect(refused.status).toBe(403);
    await flush();
    expect(to('bob@example.com').length).toBeGreaterThan(before);
  });

  it('answers a sign-up with a registered email as a new one, and tells the owner', async () => {
    const first = await signUp('members', 'cat@example.com');
    await flush();
    await t.pool.query('DELETE FROM nextbase._auth_attempts');
    const again = await signUp('members', 'CAT@example.com');
    expect(again.status).toBe(first.status);
    expect(again.body).toEqual(first.body);
    await flush();
    expect(to('cat@example.com').at(-1)?.subject).toBe(
      'Someone tried to sign up with your email',
    );
    expect(
      (
        await t.pool.query(
          "SELECT 1 FROM nextbase.members WHERE lower(email) = 'cat@example.com'",
        )
      ).rows,
    ).toHaveLength(1);
    // Other invalid input still fails as it would for a new email.
    const invalid = await call(
      nextbase,
      'POST',
      '/collections/members/sign-up',
      { body: { email: 'cat@example.com', password: 'short' } },
    );
    expect(invalid.status).toBe(400);
  });

  it('answers another taken field the same whether or not the email is registered', async () => {
    await admin.collections.create({
      name: 'handles',
      type: 'auth',
      createRule: '',
      emailVerification: { required: true },
      fields: [{ id: 'username00', name: 'username', type: 'text' }],
      indexes: [
        { name: 'handles_username', unique: true, fields: ['username00'] },
      ],
    });
    const join = (email: string, username: string) =>
      call(nextbase, 'POST', '/collections/handles/sign-up', {
        body: {
          email,
          username,
          password: PASSWORD,
          passwordConfirm: PASSWORD,
        },
      });
    expect((await join('gil@example.com', 'gil')).status).toBe(202);
    expect((await join('mine@example.com', 'mine')).status).toBe(202);
    const fresh = await join('new@example.com', 'mine');
    const registered = await join('gil@example.com', 'mine');
    expect(fresh.status).toBe(400);
    expect(registered.status).toBe(fresh.status);
    expect(registered.body).toEqual(fresh.body);
    // A clean duplicate leaves no record and no stored file behind.
    const again = await join('gil@example.com', 'other');
    expect(again.status).toBe(202);
    expect(
      (await t.pool.query('SELECT username FROM nextbase.handles ORDER BY 1'))
        .rows,
    ).toEqual([{ username: 'gil' }, { username: 'mine' }]);
  });

  it('ends sessions from before verification was required', async () => {
    await admin.collections.create({
      name: 'later',
      type: 'auth',
      createRule: '',
    });
    const reply = await signUp('later', 'hal@example.com');
    const token = reply.body.token as string;
    const before = await call(nextbase, 'GET', '/session', { token });
    expect(before.status).toBe(200);
    await admin.collections.update('later', {
      emailVerification: { required: true },
    });
    const after = await call(nextbase, 'GET', '/session', { token });
    expect(after.status).toBe(401);
  });

  it('keeps every option off for superusers', async () => {
    const updated = await admin.collections.update('_superusers', {
      emailVerification: { required: true, sendOnSignUp: true },
    });
    expect(updated).toMatchObject({
      emailVerification: { required: false, sendOnSignUp: false },
    });
  });

  it('keeps the duplicate error where an account signs in at once', async () => {
    await admin.collections.create({
      name: 'open',
      type: 'auth',
      createRule: '',
    });
    expect((await signUp('open', 'dan@example.com')).status).toBe(200);
    const again = await signUp('open', 'dan@example.com');
    expect(again.status).toBe(400);
    expect(again.body).toMatchObject({
      data: { email: { code: 'validation_not_unique' } },
    });
  });

  it('still signs up when the link cannot be sent', async () => {
    const quiet = new NextBase({ database: t.pool, logs: false });
    await quiet.client({ superuser: true }).collections.create({
      name: 'unmailed',
      type: 'auth',
      createRule: '',
      emailVerification: { sendOnSignUp: true },
    });
    const reply = await call(quiet, 'POST', '/collections/unmailed/sign-up', {
      body: {
        email: 'eve@example.com',
        password: PASSWORD,
        passwordConfirm: PASSWORD,
      },
    });
    expect(reply.status).toBe(200);
    await quiet.flush();
  });
});
