import { randomBytes } from 'node:crypto';
import { ClientError, type NextBaseClient } from '@nextbasejs/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hotp, totpStep } from '../src/auth/totp.ts';
import { type MailMessage, NextBase } from '../src/index.ts';
import { fromBase32 } from './base32.ts';
import { origin } from './http.ts';
import { createTestDatabase, type TestDatabase } from './postgres.ts';

const PASSWORD = 'password 123 456';

describe('deleting your own account', () => {
  let t: TestDatabase;
  let nextbase: NextBase;
  let admin: NextBaseClient;
  const sent: MailMessage[] = [];
  const pending: Promise<unknown>[] = [];

  const flush = async (): Promise<void> => {
    await Promise.all(pending.splice(0));
  };
  const tokenTo = (to: string): string => {
    const message = sent.filter((m) => m.to === to).at(-1);
    if (!message) throw new Error(`No email to ${to}.`);
    return /token=([\w.-]+)/.exec(message.text)?.[1] ?? '';
  };
  const failure = async (promise: Promise<unknown>): Promise<ClientError> => {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClientError);
    return error as ClientError;
  };
  /** Signs up and in; the email is verified unless `verified` is false. */
  const account = async (
    email: string,
    { verified = true } = {},
  ): Promise<{ nb: NextBaseClient; id: string }> => {
    const nb = nextbase.client();
    const users = nb.collection('users');
    await admin.collection('users').create({
      email,
      password: PASSWORD,
      passwordConfirm: PASSWORD,
      emailVerified: verified,
    });
    const { record } = await users.signInWithPassword(email, PASSWORD);
    return { nb, id: record.id };
  };
  /** Makes every session of the record as old as one signed in two days ago. */
  const age = async (id: string): Promise<void> => {
    await t.pool.query(
      "UPDATE nextbase._sessions SET created = now() - interval '2 days' WHERE record_id = $1",
      [id],
    );
  };
  const exists = async (id: string): Promise<boolean> =>
    (await t.pool.query('SELECT 1 FROM nextbase.users WHERE id = $1', [id]))
      .rows.length > 0;

  beforeAll(async () => {
    t = await createTestDatabase();
    nextbase = new NextBase({
      database: t.pool,
      secretKey: randomBytes(32).toString('base64'),
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
      deleteRule: 'id = @request.auth.id',
      mfa: { enabled: true, rule: null, duration: 300 },
    });
  });
  afterAll(async () => {
    await nextbase.flush();
    await t.close();
  });

  it('lets a session signed in within the last day delete its account', async () => {
    const { nb, id } = await account('fresh@example.com');
    await nb.collection('users').delete(id);
    expect(await exists(id)).toBe(false);
    expect(nb.authStore.isValid).toBe(false);
  });

  it('asks an older session for the current password', async () => {
    const { nb, id } = await account('older@example.com');
    await age(id);
    const users = nb.collection('users');
    const missing = await failure(users.delete(id));
    expect(missing.status).toBe(400);
    expect(missing.data).toMatchObject({
      password: { code: 'validation_required' },
    });
    const wrong = await failure(
      users.delete(id, { password: 'not the password!' }),
    );
    expect(wrong.data).toMatchObject({
      password: { code: 'validation_invalid_password' },
    });
    expect(await exists(id)).toBe(true);
    await users.delete(id, { password: PASSWORD });
    expect(await exists(id)).toBe(false);
  });

  it('checks a password that is given even on a recent session', async () => {
    const { nb, id } = await account('given@example.com');
    const error = await failure(
      nb.collection('users').delete(id, { password: 'not the password!' }),
    );
    expect(error.status).toBe(400);
    expect(await exists(id)).toBe(true);
  });

  it('keeps the password out of the request that rules see', async () => {
    await admin.collections.create({
      name: 'members',
      type: 'auth',
      createRule: '',
      // Would match only if the password reached the rule.
      deleteRule: `id = @request.auth.id && @request.body.password = ""`,
    });
    const nb = nextbase.client();
    const members = nb.collection('members');
    await members.signUp({
      email: 'rule@example.com',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    const { record } = await members.signInWithPassword(
      'rule@example.com',
      PASSWORD,
    );
    await members.delete(record.id, { password: PASSWORD });
    expect(
      (
        await t.pool.query(
          "SELECT 1 FROM nextbase.members WHERE email = 'rule@example.com'",
        )
      ).rows,
    ).toEqual([]);
  });

  it('needs a code from the authenticator app as well', async () => {
    const { nb, id } = await account('app@example.com');
    const users = nb.collection('users');
    const setup = await users.startTotp(id, PASSWORD);
    const [code] = await users.confirmTotp(
      id,
      hotp(fromBase32(setup.secret), totpStep(Date.now())),
    );
    const error = await failure(users.delete(id));
    expect(error.data).toMatchObject({
      mfaCode: { code: 'validation_required' },
    });
    expect(await exists(id)).toBe(true);
    await users.delete(id, { mfaCode: code ?? '' });
    expect(await exists(id)).toBe(false);
  });

  it('lets an older session confirm by email instead', async () => {
    const { nb, id } = await account('link@example.com');
    await age(id);
    const users = nb.collection('users');
    await users.requestAccountDeletion();
    await flush();
    const message = sent.filter((m) => m.to === 'link@example.com').at(-1);
    expect(message?.subject).toBe('Confirm the deletion of your account');
    expect(message?.text).toMatch(
      /https:\/\/app\.example\.com\/delete-account\?token=/,
    );
    const token = tokenTo('link@example.com');
    // Without a session: the link alone proves the inbox.
    await nextbase.client().collection('users').confirmAccountDeletion(token);
    expect(await exists(id)).toBe(false);
    const again = await failure(
      nextbase.client().collection('users').confirmAccountDeletion(token),
    );
    expect(again.status).toBe(400);
  });

  it('sends the link only to a verified email, and only for a signed-in account', async () => {
    const { nb } = await account('unverified@example.com', {
      verified: false,
    });
    expect(
      (await failure(nb.collection('users').requestAccountDeletion())).status,
    ).toBe(400);
    expect(
      (
        await failure(
          nextbase.client().collection('users').requestAccountDeletion(),
        )
      ).status,
    ).toBe(401);
  });

  it('refuses a link once the email changed, or a forged one', async () => {
    const { nb, id } = await account('moved@example.com');
    await nb.collection('users').requestAccountDeletion();
    await flush();
    const token = tokenTo('moved@example.com');
    await admin.collection('users').update(id, { email: 'new@example.com' });
    const users = nextbase.client().collection('users');
    expect((await failure(users.confirmAccountDeletion(token))).status).toBe(
      400,
    );
    expect(
      (await failure(users.confirmAccountDeletion('not.a.token'))).status,
    ).toBe(400);
    expect(await exists(id)).toBe(true);
  });

  it('asks the link for the app code too, and the delete rule still decides', async () => {
    const { nb, id } = await account('linkapp@example.com');
    const users = nb.collection('users');
    const setup = await users.startTotp(id, PASSWORD);
    const [code] = await users.confirmTotp(
      id,
      hotp(fromBase32(setup.secret), totpStep(Date.now())),
    );
    await users.requestAccountDeletion();
    await flush();
    const token = tokenTo('linkapp@example.com');
    const anonymous = nextbase.client().collection('users');
    const error = await failure(anonymous.confirmAccountDeletion(token));
    expect(error.data).toMatchObject({
      mfaCode: { code: 'validation_required' },
    });
    // A missing or wrong code leaves the link usable.
    const wrong = await failure(
      anonymous.confirmAccountDeletion(token, { mfaCode: '000000' }),
    );
    expect(wrong.data).toMatchObject({
      mfaCode: { code: 'validation_invalid_code' },
    });
    await anonymous.confirmAccountDeletion(token, { mfaCode: code ?? '' });
    expect(await exists(id)).toBe(false);

    await admin.collections.create({
      name: 'kept',
      type: 'auth',
      createRule: '',
      deleteRule: null,
    });
    const kept = nextbase.client().collection('kept');
    await kept.signUp({
      email: 'kept@example.com',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    await t.pool.query(
      'UPDATE nextbase.kept SET "emailVerified" = true WHERE email = \'kept@example.com\'',
    );
    const signedIn = nextbase.client();
    await signedIn
      .collection('kept')
      .signInWithPassword('kept@example.com', PASSWORD);
    // With a null rule, no link is sent: it could never work.
    const refused = await failure(
      signedIn.collection('kept').requestAccountDeletion(),
    );
    expect(refused.status).toBe(403);
  });

  it('lets superusers and managers delete without it, but never an impersonation', async () => {
    const { id } = await account('managed@example.com');
    await age(id);
    await admin.collection('users').delete(id);
    expect(await exists(id)).toBe(false);

    const target = await account('impersonated@example.com');
    const superuser = nextbase.client();
    await admin.collection('_superusers').create({
      email: 'root@example.com',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    await superuser
      .collection('_superusers')
      .signInWithPassword('root@example.com', PASSWORD);
    const { client } = await superuser
      .collection('users')
      .impersonate(target.id);
    const error = await failure(
      client.collection('users').delete(target.id, { password: PASSWORD }),
    );
    expect(error.status).toBe(403);
    expect(await exists(target.id)).toBe(true);
  });

  it('verifies a password for server code', async () => {
    const { id } = await account('verify@example.com');
    expect(await nextbase.verifyPassword('users', id, PASSWORD)).toBe(true);
    expect(await nextbase.verifyPassword('users', id, 'not it at all!')).toBe(
      false,
    );
    expect(await nextbase.verifyPassword('users', 'nope', PASSWORD)).toBe(
      false,
    );
    await admin.collections.create({ name: 'notes' });
    await expect(
      nextbase.verifyPassword('notes', id, PASSWORD),
    ).rejects.toThrow(TypeError);
  });

  it('asks the same when a cascade from another record reaches the account', async () => {
    const teams = await admin.collections.create({
      name: 'teams',
      deleteRule: '',
    });
    await admin.collections.create({
      name: 'owners',
      type: 'auth',
      viewRule: 'id = @request.auth.id',
      fields: [
        {
          name: 'team',
          type: 'relation',
          collectionId: teams.id,
          cascadeDelete: true,
        },
      ],
    });
    const team = await admin.collection('teams').create({});
    await admin.collection('owners').create({
      email: 'owner@example.com',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
      team: team?.id,
    });
    const nb = nextbase.client();
    const { record } = await nb
      .collection('owners')
      .signInWithPassword('owner@example.com', PASSWORD);
    await age(record.id);
    const refused = await failure(
      nb.collection('teams').delete(team?.id ?? ''),
    );
    expect(refused.status).toBe(400);
    const left = async (): Promise<number> =>
      (await t.pool.query('SELECT 1 FROM nextbase.owners')).rows.length;
    expect(await left()).toBe(1);
    await nb.collection('teams').delete(team?.id ?? '', { password: PASSWORD });
    expect(await left()).toBe(0);
  });

  it('still deletes without a body when a Content-Type is sent anyway', async () => {
    await admin.collections.create({ name: 'scraps', deleteRule: '' });
    for (const type of ['application/json', 'text/plain']) {
      const scrap = await admin.collection('scraps').create({});
      const response = await nextbase.handle(
        new Request(
          `${origin}/api/nextbase/collections/scraps/records/${scrap?.id}`,
          { method: 'DELETE', headers: { 'content-type': type } },
        ),
      );
      expect(response.status).toBe(204);
    }
  });

  it('keeps the link usable when the delete it confirms fails', async () => {
    await admin.collections.create({
      name: 'guarded',
      type: 'auth',
      viewRule: 'id = @request.auth.id',
      deleteRule: 'id = @request.auth.id && ready = true',
      fields: [{ name: 'ready', type: 'bool' }],
    });
    const created = await admin.collection('guarded').create({
      email: 'guarded@example.com',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
      emailVerified: true,
    });
    const nb = nextbase.client();
    await nb
      .collection('guarded')
      .signInWithPassword('guarded@example.com', PASSWORD);
    await nb.collection('guarded').requestAccountDeletion();
    await flush();
    const token = tokenTo('guarded@example.com');
    const anonymous = nextbase.client().collection('guarded');
    expect(
      (await failure(anonymous.confirmAccountDeletion(token))).status,
    ).toBe(404);
    await admin
      .collection('guarded')
      .update(created?.id ?? '', { ready: true });
    await anonymous.confirmAccountDeletion(token);
    expect(
      (await t.pool.query('SELECT 1 FROM nextbase.guarded')).rows.length,
    ).toBe(0);
  });

  it('checks the delete rule before asking for a password', async () => {
    await admin.collections.create({
      name: 'locked',
      type: 'auth',
      viewRule: 'id = @request.auth.id',
      deleteRule: '@request.auth.id != id',
    });
    await admin.collection('locked').create({
      email: 'locked@example.com',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    const nb = nextbase.client();
    const { record } = await nb
      .collection('locked')
      .signInWithPassword('locked@example.com', PASSWORD);
    await age(record.id);
    expect(
      (await failure(nb.collection('locked').delete(record.id))).status,
    ).toBe(404);
    // Nor offered a link that could never work.
    await admin.collections.update('locked', { deleteRule: null });
    expect(
      (await failure(nb.collection('locked').requestAccountDeletion())).status,
    ).toBe(403);
  });

  it('signs the client out when its own account was deleted by link', async () => {
    const { nb, id } = await account('signout@example.com');
    const users = nb.collection('users');
    await users.requestAccountDeletion();
    await flush();
    await users.confirmAccountDeletion(tokenTo('signout@example.com'));
    expect(await exists(id)).toBe(false);
    expect(nb.authStore.isValid).toBe(false);
  });

  it('never links superusers by email', async () => {
    const superusers = await admin.collections.getOne('_superusers');
    expect(superusers).toMatchObject({ implicitLinking: false });
    const updated = await admin.collections.update('_superusers', {
      implicitLinking: true,
    });
    expect(updated).toMatchObject({ implicitLinking: false });
  });

  it('counts each own deletion in a batch the same way', async () => {
    const { nb, id } = await account('batch@example.com');
    await age(id);
    const batch = nb.createBatch();
    batch.collection('users').delete(id);
    expect((await failure(batch.send())).status).toBe(400);
    expect(await exists(id)).toBe(true);
  });
});
