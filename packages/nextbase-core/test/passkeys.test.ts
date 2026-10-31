import { randomBytes } from 'node:crypto';
import {
  ClientError,
  isMfaRequired,
  type NextBaseClient,
  type RecordModel,
} from '@nextbasejs/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hotp, totpStep } from '../src/auth/totp.ts';
import { type MailMessage, NextBase, type SignInCheck } from '../src/index.ts';
import { fromBase32 } from './base32.ts';
import { createTestDatabase, type TestDatabase } from './postgres.ts';
import { Authenticator } from './webauthn.ts';

const PASSWORD = 'password 123 456';
const APP = 'https://app.example.com';

describe('passkeys', () => {
  let t: TestDatabase;
  let nextbase: NextBase;
  let admin: NextBaseClient;
  let device: Authenticator;
  let uninstall: () => void;
  const mails: MailMessage[] = [];
  const pending: Promise<unknown>[] = [];
  const checks: SignInCheck[] = [];

  const failure = async (promise: Promise<unknown>): Promise<ClientError> => {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClientError);
    return error as ClientError;
  };
  const codeOf = (error: ClientError, field: string): unknown =>
    (error.data[field] as { code?: unknown } | undefined)?.code;
  const sent = async (to: string): Promise<string[]> => {
    await Promise.all(pending.splice(0));
    return mails.filter((m) => m.to === to).map((m) => m.subject);
  };

  const account = async (email: string): Promise<RecordModel> => {
    const created = await admin.collection('users').create({
      email,
      password: PASSWORD,
      passwordConfirm: PASSWORD,
      emailVerified: true,
    });
    if (!created) throw new Error('A superuser views every record.');
    return created;
  };
  /** A client signed in with the password. */
  const signedIn = async (email: string): Promise<NextBaseClient> => {
    const nb = nextbase.client();
    await nb.collection('users').signInWithPassword(email, PASSWORD);
    return nb;
  };
  /** An account with a passkey on the device. */
  const withPasskey = async (
    email: string,
  ): Promise<{ record: RecordModel; nb: NextBaseClient }> => {
    const record = await account(email);
    const nb = await signedIn(email);
    await nb.collection('users').addPasskey(record.id);
    return { record, nb };
  };
  const passkeySignIn = (id: string, options = {}) => {
    device.behavior.account = id;
    return nextbase.client().collection('users').signInWithPasskey(options);
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    nextbase = new NextBase({
      database: t.pool,
      appUrl: APP,
      secretKey: randomBytes(32).toString('base64'),
      mail: {
        from: 'app@example.com',
        send: async (message) => {
          mails.push(message);
        },
      },
      waitUntil: (promise) => pending.push(promise),
      logs: false,
      rateLimits: false,
      validateSignIn: (check) => {
        checks.push(check);
        if (String(check.record.email).endsWith('@blocked.example')) {
          return { error: 'email_not_allowed' };
        }
        return undefined;
      },
    });
    admin = nextbase.client({ superuser: true });
    await admin.collections.create({
      name: 'users',
      type: 'auth',
      viewRule: 'id = @request.auth.id',
      passkeySignIn: true,
    });
    device = new Authenticator(APP);
    uninstall = device.install();
  });
  afterAll(async () => {
    uninstall();
    await nextbase.flush();
    await t.close();
  });

  it('is off unless the collection turns it on and appUrl is set', async () => {
    expect(
      (await nextbase.client().collection('users').listAuthMethods()).passkey,
    ).toEqual({ enabled: true });
    await admin.collections.create({ name: 'closed', type: 'auth' });
    const closed = nextbase.client().collection('closed');
    expect((await closed.listAuthMethods()).passkey).toEqual({
      enabled: false,
    });
    expect((await failure(closed.signInWithPasskey())).status).toBe(400);
    const unbound = new NextBase({ database: t.pool, logs: false });
    expect(
      (await unbound.client().collection('users').listAuthMethods()).passkey,
    ).toEqual({ enabled: false });
    await unbound.flush();
  });

  it('adds a passkey to a fresh session, signs in with it, and tells the owner', async () => {
    const record = await account('ann@example.com');
    const nb = await signedIn('ann@example.com');
    const added = await nb
      .collection('users')
      .addPasskey(record.id, { name: 'Laptop' });
    expect(added).toMatchObject({
      name: 'Laptop',
      backedUp: true,
      lastUsed: '',
    });
    expect(device.lastOptions).toMatchObject({
      rp: { id: 'app.example.com' },
      user: { name: 'ann@example.com' },
      attestation: 'none',
      authenticatorSelection: { residentKey: 'required' },
    });
    expect(await sent('ann@example.com')).toContain('A passkey was added');

    const signIn = await passkeySignIn(record.id);
    expect(signIn.record.id).toBe(record.id);
    expect(signIn.methods).toEqual(['passkey']);
    expect(device.lastMediation).toBeUndefined();
    // Any passkey of the collection may answer.
    expect(device.lastOptions).not.toHaveProperty('allowCredentials');
    expect(checks.at(-1)).toMatchObject({
      action: 'sign-in',
      method: 'passkey',
    });

    await passkeySignIn(record.id, { autofill: true });
    expect(device.lastMediation).toBe('conditional');
    const [listed] = await nb.collection('users').listPasskeys(record.id);
    expect(listed?.lastUsed).not.toBe('');
  });

  it('offers the passkeys the record has to the device, so it does not add one twice', async () => {
    const { record, nb } = await withPasskey('bea@example.com');
    const twice = await failure(nb.collection('users').addPasskey(record.id));
    expect((twice.cause as DOMException).name).toBe('InvalidStateError');
    expect(device.lastOptions?.excludeCredentials).toHaveLength(1);
  });

  it('needs a verified email or phone, so a sign-up with another address cannot keep a way in', async () => {
    const created = await admin.collection('users').create({
      email: 'pat@example.com',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    const nb = await signedIn('pat@example.com');
    const unverified = await failure(
      nb.collection('users').addPasskey(created?.id ?? ''),
    );
    expect(codeOf(unverified, 'passkey')).toBe('validation_not_verified');
  });

  it('needs the password once the session is a day old', async () => {
    const record = await account('cal@example.com');
    const nb = await signedIn('cal@example.com');
    await t.pool.query(
      `UPDATE nextbase._sessions SET created = now() - interval '2 days' WHERE record_id = $1`,
      [record.id],
    );
    const users = nb.collection('users');
    const stale = await failure(users.addPasskey(record.id));
    expect(codeOf(stale, 'password')).toBe('validation_required');
    const wrong = await failure(
      users.addPasskey(record.id, { password: 'not it at all' }),
    );
    expect(codeOf(wrong, 'password')).toBe('validation_invalid_password');
    await users.addPasskey(record.id, { password: PASSWORD });
  });

  it('works only for the session that asked, and once', async () => {
    const record = await account('dee@example.com');
    const nb = await signedIn('dee@example.com');
    const other = await signedIn('dee@example.com');
    const path = `/collections/users/records/${record.id}/passkeys`;
    const asked = await nb.send<{ challengeId: string; options: never }>(
      `${path}/options`,
      { method: 'POST', body: {} },
    );
    const credential = device.create(asked.options);
    const elsewhere = await failure(
      other.send(path, {
        method: 'POST',
        body: { challengeId: asked.challengeId, credential },
      }),
    );
    expect(codeOf(elsewhere, 'challengeId')).toBe(
      'validation_invalid_challenge',
    );
    // Taken by the try above, the challenge works for no one.
    const again = await failure(
      nb.send(path, {
        method: 'POST',
        body: { challengeId: asked.challengeId, credential },
      }),
    );
    expect(codeOf(again, 'challengeId')).toBe('validation_invalid_challenge');
  });

  it('refuses another origin, a used challenge and a counter going back', async () => {
    const { record } = await withPasskey('eve@example.com');
    device.behavior.origin = 'https://evil.example';
    try {
      const phished = await failure(passkeySignIn(record.id));
      expect(codeOf(phished, 'credential')).toBe('passkey_invalid');
    } finally {
      device.behavior.origin = undefined;
    }

    const nb = nextbase.client();
    const asked = await nb.send<{ challengeId: string; options: never }>(
      '/collections/users/passkey-options',
      { method: 'POST' },
    );
    device.behavior.account = record.id;
    const credential = device.get(asked.options);
    const body = { challengeId: asked.challengeId, credential };
    await nb.send('/collections/users/auth-with-passkey', {
      method: 'POST',
      body,
    });
    const replayed = await failure(
      nb.send('/collections/users/auth-with-passkey', { method: 'POST', body }),
    );
    expect(codeOf(replayed, 'challengeId')).toBe(
      'validation_invalid_challenge',
    );

    await passkeySignIn(record.id);
    device.behavior.counter = 1;
    try {
      const cloned = await failure(passkeySignIn(record.id));
      expect(codeOf(cloned, 'credential')).toBe('passkey_invalid');
    } finally {
      device.behavior.counter = undefined;
    }
  });

  it('asks the device to forget a passkey that is gone', async () => {
    const { record } = await withPasskey('fay@example.com');
    await t.pool.query('DELETE FROM nextbase._passkeys WHERE record_id = $1', [
      record.id,
    ]);
    const gone = await failure(passkeySignIn(record.id));
    expect(codeOf(gone, 'credential')).toBe('passkey_not_found');
    expect(device.forgotten).toHaveLength(1);
  });

  it("keeps another collection's passkey on the device", async () => {
    const { record } = await withPasskey('mo@example.com');
    await admin.collections.create({
      name: 'members',
      type: 'auth',
      passkeySignIn: true,
    });
    device.behavior.account = record.id;
    const forgotten = device.forgotten.length;
    const other = await failure(
      nextbase.client().collection('members').signInWithPasskey(),
    );
    expect(codeOf(other, 'credential')).toBe('passkey_other_collection');
    expect(device.forgotten).toHaveLength(forgotten);
  });

  it('waits again when autofill outlasts its challenge', async () => {
    const { record } = await withPasskey('ned@example.com');
    device.behavior.beforeGet = async () => {
      await t.pool.query(
        "UPDATE nextbase._webauthn_challenges SET expires = now() - interval '1 second'",
      );
    };
    const signIn = await passkeySignIn(record.id, { autofill: true });
    expect(signIn.record.id).toBe(record.id);
  });

  it('sends nothing without WebAuthn, and reports a cancelled dialog as a ClientError', async () => {
    const record = await account('ola@example.com');
    const nb = await signedIn('ola@example.com');
    uninstall();
    try {
      await expect(
        nb.collection('users').addPasskey(record.id, { password: 'wrong!' }),
      ).rejects.toThrow(/WebAuthn/);
      await expect(
        nextbase.client().collection('users').signInWithPasskey(),
      ).rejects.toThrow(/WebAuthn/);
    } finally {
      uninstall = device.install();
    }
    const { rows } = await t.pool.query(
      'SELECT 1 FROM nextbase._webauthn_challenges WHERE record_id = $1',
      [record.id],
    );
    expect(rows).toEqual([]);
    device.behavior.fail = new DOMException('Cancelled.', 'NotAllowedError');
    try {
      const cancelled = await failure(
        nb.collection('users').addPasskey(record.id),
      );
      expect(cancelled.status).toBe(0);
      expect((cancelled.cause as DOMException).name).toBe('NotAllowedError');
    } finally {
      device.behavior.fail = undefined;
    }
  });

  it("checks the app's rule, as any sign-in", async () => {
    const { record } = await withPasskey('gus@example.com');
    await admin
      .collection('users')
      .update(record.id, { email: 'gus@blocked.example' });
    const refused = await failure(passkeySignIn(record.id));
    expect(refused.status).toBe(403);
    expect(refused.data).toMatchObject({
      account: { code: 'email_not_allowed' },
    });
  });

  it('counts as both steps when the device checked the user, and as one step otherwise', async () => {
    const { record } = await withPasskey('hal@example.com');
    await admin.collections.update('users', {
      mfa: { enabled: true, rule: '' },
    });
    try {
      expect((await passkeySignIn(record.id)).methods).toEqual(['passkey']);

      device.behavior.userVerified = false;
      let first: ClientError;
      try {
        first = await failure(passkeySignIn(record.id));
      } finally {
        device.behavior.userVerified = undefined;
      }
      expect(first.status).toBe(401);
      expect(first.mfa?.methods).not.toContain('passkey');

      // A passkey is a second step after the password.
      const password = await failure(
        nextbase
          .client()
          .collection('users')
          .signInWithPassword('hal@example.com', PASSWORD),
      );
      expect(isMfaRequired(password)?.methods).toContain('passkey');
      const finished = await passkeySignIn(record.id, {
        mfaId: password.mfa?.mfaId,
      });
      expect(finished.methods).toEqual(['password', 'passkey']);
      expect(device.lastOptions?.allowCredentials).toHaveLength(1);
    } finally {
      await admin.collections.update('users', {
        mfa: { enabled: false, rule: null },
      });
    }
  });

  it('asks for an app code too, once the record has an app', async () => {
    await admin.collections.update('users', {
      mfa: { enabled: true, rule: null },
    });
    try {
      const record = await account('ivy@example.com');
      const nb = await signedIn('ivy@example.com');
      const users = nb.collection('users');
      const { secret } = await users.startTotp(record.id, PASSWORD);
      const code = (offset: number) =>
        hotp(fromBase32(secret), totpStep(Date.now()) + offset);
      await users.confirmTotp(record.id, code(0));
      const without = await failure(users.addPasskey(record.id));
      expect(codeOf(without, 'mfaCode')).toBe('validation_required');
      await users.addPasskey(record.id, { mfaCode: code(1) });
      // Verified by the device, it signs in without the app's code.
      expect((await passkeySignIn(record.id)).methods).toEqual(['passkey']);
    } finally {
      await admin.collections.update('users', {
        mfa: { enabled: false, rule: null },
      });
    }
  });

  it('renames and removes with the same proof, and tells the owner', async () => {
    const { record, nb } = await withPasskey('jo@example.com');
    const users = nb.collection('users');
    const [passkey] = await users.listPasskeys(record.id);
    const id = passkey?.id ?? '';
    expect(await users.renamePasskey(record.id, id, ' Phone ')).toMatchObject({
      name: 'Phone',
    });
    await t.pool.query(
      `UPDATE nextbase._sessions SET created = now() - interval '2 days' WHERE record_id = $1`,
      [record.id],
    );
    expect(
      codeOf(await failure(users.deletePasskey(record.id, id)), 'password'),
    ).toBe('validation_required');
    await users.deletePasskey(record.id, id, { password: PASSWORD });
    expect(await users.listPasskeys(record.id)).toEqual([]);
    expect(await sent('jo@example.com')).toContain('A passkey was removed');
    // Another record's passkeys are not listed or changed.
    const stranger = await withPasskey('kit@example.com');
    const [theirs] = await stranger.nb
      .collection('users')
      .listPasskeys(stranger.record.id);
    expect((await failure(users.listPasskeys(stranger.record.id))).status).toBe(
      404,
    );
    expect(
      (await failure(users.renamePasskey(record.id, theirs?.id ?? '', 'x')))
        .status,
    ).toBe(404);
  });

  it('lets only one of parallel uses with the same count through', async () => {
    const { record } = await withPasskey('quin@example.com');
    await passkeySignIn(record.id);
    const key = device.keys.at(-1);
    if (!key) throw new Error('The passkey was added.');
    const nb = nextbase.client();
    const tries = await Promise.allSettled(
      [0, 1].map(async () => {
        const asked = await nb.send<{ challengeId: string; options: never }>(
          '/collections/users/passkey-options',
          { method: 'POST' },
        );
        device.behavior.counter = 7;
        const credential = device.assert(
          key,
          (asked.options as { challenge: string }).challenge,
        );
        return nb.send('/collections/users/auth-with-passkey', {
          method: 'POST',
          body: { challengeId: asked.challengeId, credential },
        });
      }),
    );
    device.behavior.counter = undefined;
    expect(tries.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
  });

  it('offers no passkey step where passkeys are off, and refuses text it cannot store', async () => {
    const { record, nb } = await withPasskey('rex@example.com');
    const users = nb.collection('users');
    expect(
      (await failure(users.renamePasskey(record.id, 'nope', 'x'))).status,
    ).toBe(404);
    const [passkey] = await users.listPasskeys(record.id);
    const nul = await failure(
      users.renamePasskey(record.id, passkey?.id ?? '', 'a\u0000b'),
    );
    expect(codeOf(nul, 'name')).toBe('validation_invalid_name');

    await admin.collections.update('users', {
      passkeySignIn: false,
      mfa: { enabled: true, rule: '' },
    });
    try {
      const step = await failure(
        nextbase
          .client()
          .collection('users')
          .signInWithPassword('rex@example.com', PASSWORD),
      );
      expect(step.mfa?.methods).not.toContain('passkey');
    } finally {
      await admin.collections.update('users', {
        passkeySignIn: true,
        mfa: { enabled: false, rule: null },
      });
    }
  });

  it('removes the passkeys of a deleted record', async () => {
    const { record } = await withPasskey('lou@example.com');
    await admin.collection('users').delete(record.id);
    const { rows } = await t.pool.query(
      'SELECT 1 FROM nextbase._passkeys WHERE record_id = $1',
      [record.id],
    );
    expect(rows).toEqual([]);
  });
});
