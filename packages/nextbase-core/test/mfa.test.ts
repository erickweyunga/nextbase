import { randomBytes } from 'node:crypto';
import {
  AuthStore,
  ClientError,
  isMfaRequired,
  type MfaRequired,
  type NextBaseClient,
  type RecordModel,
} from '@nextbasejs/client';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ROUTES } from '../src/api/routes.ts';
import { SecretKeys } from '../src/auth/secret-keys.ts';
import {
  base32,
  hotp,
  matchTotp,
  normalizeRecoveryCode,
  totpStep,
} from '../src/auth/totp.ts';
import { type Io, run } from '../src/cli/run.ts';
import { type MailMessage, NextBase, type SmsMessage } from '../src/index.ts';
import { timings } from '../src/realtime/timings.ts';
import { origin } from './http.ts';
import { createTestDatabase, type TestDatabase } from './postgres.ts';
import { waitFor } from './wait.ts';

const PASSWORD = 'password 123 456';
const ISSUER = 'https://idp.example.com';
const KEY = randomBytes(32).toString('base64');
const OTHER_KEY = randomBytes(32).toString('base64');

// RFC 6238, Appendix B: the SHA-1 secret and times, with the last six
// digits of each 8-digit code.
const RFC_SECRET = Buffer.from('12345678901234567890');
const RFC_VECTORS: [number, string][] = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

function fromBase32(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

describe('TOTP and secret keys', () => {
  it('matches the RFC 6238 SHA-1 test vectors', () => {
    for (const [seconds, code] of RFC_VECTORS) {
      expect(hotp(RFC_SECRET, totpStep(seconds * 1000))).toBe(code);
      expect(matchTotp(RFC_SECRET, code, seconds * 1000)).toBe(
        totpStep(seconds * 1000),
      );
    }
  });

  it('accepts one step either side of now, and refuses two', () => {
    const now = 1_700_000_015_000;
    const step = totpStep(now);
    for (const offset of [-1, 0, 1]) {
      expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step + offset), now)).toBe(
        step + offset,
      );
    }
    for (const offset of [-2, 2]) {
      expect(
        matchTotp(RFC_SECRET, hotp(RFC_SECRET, step + offset), now),
      ).toBeUndefined();
    }
    expect(matchTotp(RFC_SECRET, 'abcdef', now)).toBeUndefined();
    expect(matchTotp(RFC_SECRET, '1234567', now)).toBeUndefined();
  });

  it('encodes secrets in base32, as authenticator apps read them', () => {
    expect(base32(Buffer.from('12345678901234567890'))).toBe(
      'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    );
    expect(fromBase32('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')).toEqual(RFC_SECRET);
  });

  it('reads recovery codes however they are typed', () => {
    expect(normalizeRecoveryCode('abcd-efgh-jkmn-pqrs')).toBe(
      'ABCDEFGHJKMNPQRS',
    );
    // O reads as 0, I and L as 1.
    expect(normalizeRecoveryCode('o0il 2345 6789 abcd')).toBe(
      '001123456789ABCD',
    );
    expect(normalizeRecoveryCode('ABCD-EFGH-JKMN-PQR')).toBeUndefined();
    expect(normalizeRecoveryCode('ABCD-EFGH-JKMN-PQRU')).toBeUndefined();
  });

  it('opens a secret only on the row it was encrypted for', () => {
    const keys = new SecretKeys(KEY);
    const stored = keys.encrypt(Buffer.from('secret'), 'users:a');
    expect(stored).toMatch(/^v1\.[\w-]{8}\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(keys.decrypt(stored, 'users:a')?.toString()).toBe('secret');
    expect(keys.decrypt(stored, 'users:b')).toBeUndefined();
    // A changed byte fails the tag.
    const parts = stored.split('.');
    const ciphertext = Buffer.from(parts[3] as string, 'base64url');
    ciphertext[0] = (ciphertext[0] as number) ^ 1;
    parts[3] = ciphertext.toString('base64url');
    expect(keys.decrypt(parts.join('.'), 'users:a')).toBeUndefined();
  });

  it('rotates keys: the first encrypts, every one decrypts', () => {
    const old = new SecretKeys(KEY);
    const stored = old.encrypt(Buffer.from('secret'), 'aad');
    const rotated = new SecretKeys([OTHER_KEY, KEY]);
    expect(rotated.decrypt(stored, 'aad')?.toString()).toBe('secret');
    const fresh = rotated.encrypt(Buffer.from('new'), 'aad');
    expect(old.decrypt(fresh, 'aad')).toBeUndefined();
    expect(new SecretKeys(OTHER_KEY).decrypt(fresh, 'aad')?.toString()).toBe(
      'new',
    );
  });

  it('refuses an invalid secret key when NextBase is made', () => {
    for (const secretKey of [
      'short',
      randomBytes(16).toString('base64'),
      [KEY, 'nope'],
    ]) {
      expect(() => new NextBase({ secretKey })).toThrow(TypeError);
    }
    expect(() => new NextBase({ secretKey: [KEY, OTHER_KEY] })).not.toThrow();
  });

  it('tags every sign-in step and MFA setting route for auth rate limits', () => {
    const mfaRoutes = ROUTES.filter((r) =>
      /totp|recovery|email-code|\/mfa\$|phone-code|auth-with-password/.test(
        r.pattern.source,
      ),
    );
    expect(mfaRoutes.length).toBe(14);
    for (const route of mfaRoutes) expect(route.tags).toEqual(['auth']);
  });
});

/** The account a fake provider signs in. */
interface Account {
  sub: string;
  email: string;
}

describe('multi-factor sign-in', () => {
  let t: TestDatabase;
  let nextbase: NextBase;
  let admin: NextBaseClient;
  const mails: MailMessage[] = [];
  const texts: SmsMessage[] = [];
  const pending: Promise<unknown>[] = [];
  const grants = new Map<string, { account: Account; nonce: string | null }>();
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  /** The methods of the sessions that created secrets, as hooks saw them. */
  const hookMethods: unknown[] = [];
  /** The last TOTP step each record used, so each code is fresh. */
  const lastStep = new Map<string, number>();

  const flush = async (): Promise<void> => {
    await Promise.all(pending.splice(0));
  };
  const mailsTo = async (to: string): Promise<MailMessage[]> => {
    await flush();
    return mails.filter((m) => m.to === to);
  };
  const lastCode = async (list: { text: string }[]): Promise<string> => {
    const code = /\b(\d{6})\b/.exec(list.at(-1)?.text ?? '')?.[1];
    if (!code) throw new Error('No code was sent.');
    return code;
  };
  const textedCode = async (phone: string): Promise<string> => {
    await flush();
    return lastCode(texts.filter((m) => m.to === phone));
  };
  const failure = async (promise: Promise<unknown>): Promise<ClientError> => {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClientError);
    return error as ClientError;
  };
  /** The second step a first step asked for. */
  const challenged = async (
    promise: Promise<unknown>,
  ): Promise<MfaRequired> => {
    const error = await failure(promise);
    expect(error.status).toBe(401);
    const mfa = isMfaRequired(error);
    expect(mfa).toBeDefined();
    return mfa as MfaRequired;
  };
  const query = async <R extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<R[]> => (await t.pool.query<R>(sql, params)).rows;

  const users = (nb?: NextBaseClient) =>
    (nb ?? nextbase.client()).collection('users');

  /** An account with a password and a verified email. */
  const account = async (
    email: string,
    extra: Record<string, unknown> = {},
    collection = 'users',
  ): Promise<RecordModel> => {
    const created = await admin.collection(collection).create({
      email,
      password: PASSWORD,
      passwordConfirm: PASSWORD,
      emailVerified: true,
      ...extra,
    });
    if (!created) throw new Error('A superuser views every record.');
    return created;
  };

  const signIn = async (email: string, collection = 'users') => {
    const nb = nextbase.client();
    const auth = await nb
      .collection(collection)
      .signInWithPassword(email, PASSWORD);
    return { nb, ...auth };
  };

  /** A code for the record's next unused step, never one before it. */
  const totp = async (
    id: string,
    secret: string,
    offset = 0,
  ): Promise<string> => {
    let step = Math.max(totpStep(Date.now()), (lastStep.get(id) ?? 0) + 1);
    // A step more than one ahead of now is refused, so wait for it.
    while (step > totpStep(Date.now()) + 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    step += offset;
    lastStep.set(id, step);
    return hotp(fromBase32(secret), step);
  };

  /** Signs in and turns on an authenticator app; returns its secret and recovery codes. */
  const enroll = async (email: string, collection = 'users') => {
    const signedIn = await signIn(email, collection);
    const service = signedIn.nb.collection(collection);
    const setup = await service.startTotp(signedIn.record.id, PASSWORD);
    const recoveryCodes = await service.confirmTotp(
      signedIn.record.id,
      await totp(signedIn.record.id, setup.secret),
    );
    return { ...signedIn, secret: setup.secret, uri: setup.uri, recoveryCodes };
  };

  const raw = (
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: unknown,
  ): Promise<Response> =>
    nextbase.handle(
      new Request(
        path.startsWith('http') ? path : `${origin}/api/nextbase${path}`,
        {
          method,
          headers: {
            ...(body !== undefined && { 'content-type': 'application/json' }),
            ...headers,
          },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        },
      ),
    );

  const cookieOf = (response: Response, name: string): string | undefined =>
    response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0] as string)
      .find((c) => c.startsWith(`${name}=`) && c !== `${name}=`);

  /** A realtime stream of `secrets` over HTTP, once it is subscribed. */
  const stream = async (token: string) => {
    const controller = new AbortController();
    const response = await nextbase.handle(
      new Request(`${origin}/api/nextbase/realtime`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ topics: [{ collection: 'secrets' }] }),
        signal: controller.signal,
      }),
    );
    expect(response.status).toBe(200);
    const titles: string[] = [];
    let messages = 0;
    const reader = (response.body as ReadableStream<Uint8Array>)
      .pipeThrough(new TextDecoderStream())
      .getReader();
    const reading = (async () => {
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += value;
        let end = buffer.indexOf('\n\n');
        while (end !== -1) {
          messages++;
          for (const line of buffer.slice(0, end).split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const data = JSON.parse(line.slice(6)) as {
              topics?: Record<string, { title?: string }>;
            };
            const title = data.topics?.['0']?.title;
            if (title !== undefined) titles.push(title);
          }
          buffer = buffer.slice(end + 2);
          end = buffer.indexOf('\n\n');
        }
      }
    })().catch(() => {});
    // Subscribed once the first message, the cursor, arrives.
    await waitFor(() => messages > 0, 'the stream to start');
    return {
      titles,
      close: async () => {
        controller.abort();
        await reading;
      },
    };
  };

  /** A fake OpenID Connect provider, behind fetch. */
  const provider = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.href === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url.href === `${ISSUER}/jwks`) {
      return Response.json({ keys: [await exportJWK(keys.publicKey)] });
    }
    if (url.href === `${ISSUER}/token` && request.method === 'POST') {
      const body = new URLSearchParams(await request.text());
      const grant = grants.get(body.get('code') ?? '');
      if (!grant)
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      const idToken = await new SignJWT({
        email: grant.account.email,
        email_verified: true,
        nonce: grant.nonce,
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(ISSUER)
        .setSubject(grant.account.sub)
        .setAudience('client')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(keys.privateKey);
      return Response.json({
        access_token: 'at',
        token_type: 'Bearer',
        id_token: idToken,
      });
    }
    return new Response('not found', { status: 404 });
  };

  /** Starts an OAuth2 sign-in at the fake provider and returns the callback's response. */
  const oauth2 = async (
    collection: string,
    account: Account,
    query = '',
    redirect = '/home',
  ): Promise<Response> => {
    const start = await raw(
      'GET',
      `/collections/${collection}/auth-with-oauth2/idp?redirect=${encodeURIComponent(redirect)}${query}`,
    );
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.get('location') ?? '');
    const code = randomBytes(16).toString('hex');
    grants.set(code, { account, nonce: authorize.searchParams.get('nonce') });
    const callback = new URL(authorize.searchParams.get('redirect_uri') ?? '');
    callback.searchParams.set('code', code);
    callback.searchParams.set(
      'state',
      authorize.searchParams.get('state') ?? '',
    );
    return raw('GET', callback.href, {
      cookie: cookieOf(start, 'nextbase_oauth2') ?? '',
    });
  };

  beforeAll(async () => {
    keys = await generateKeyPair('RS256');
    vi.stubGlobal('fetch', provider);
    t = await createTestDatabase();
    nextbase = new NextBase({
      database: t.pool,
      appUrl: origin,
      secretKey: KEY,
      rateLimits: false,
      oauth2: {
        idp: { issuer: ISSUER, clientId: 'client', clientSecret: 'secret' },
      },
      mail: {
        from: 'app@example.com',
        send: async (message) => {
          mails.push(message);
        },
      },
      sms: {
        send: async (message) => {
          texts.push(message);
        },
      },
      realtime: { collections: ['secrets'], listenUrl: t.url },
      waitUntil: (promise) => pending.push(promise),
      hooks: {
        secrets: {
          onCreate: (e) => void hookMethods.push(e.principal.methods),
        },
      },
    });
    admin = nextbase.client({ superuser: true });
    await admin.collections.create({
      name: 'users',
      type: 'auth',
      phoneSignIn: true,
      identityFields: ['email', 'phone'],
      createRule: '',
      viewRule: '',
      updateRule: 'id = @request.auth.id',
      mfa: { enabled: true },
    });
    // Every account takes a second step.
    await admin.collections.create({
      name: 'strict',
      type: 'auth',
      createRule: '',
      mfa: { enabled: true, rule: '', duration: 120 },
    });
    // Only admins, and accounts with an app.
    await admin.collections.create({
      name: 'staff',
      type: 'auth',
      fields: [{ name: 'role', type: 'text' }],
      mfa: { enabled: true, rule: 'role = "admin"' },
    });
    await admin.collections.create({
      name: 'secrets',
      type: 'base',
      fields: [{ name: 'title', type: 'text' }],
      listRule: '@request.mfa = true',
      viewRule: '@request.mfa = true',
      createRule: '',
    });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await nextbase.flush();
    await t.close();
  });

  it('defaults to off, and validates the settings', async () => {
    const plain = await admin.collections.create({
      name: 'plain',
      type: 'auth',
    });
    expect(plain).toMatchObject({
      mfa: { enabled: false, rule: null, duration: 300 },
    });
    const superusers = await admin.collections.getOne('_superusers');
    expect(superusers).toMatchObject({ mfa: { enabled: false } });
    for (const mfa of [
      { duration: 59 },
      { duration: 3601 },
      { rule: 'nope = 1' },
      { enabled: 'yes' },
    ]) {
      const error = await failure(
        admin.collections.update('plain', { mfa } as never),
      );
      expect(error.status).toBe(400);
      expect(error.data.mfa).toBeDefined();
    }
    // `@request.mfa` names no field, so any collection may have one named so.
    await admin.collections.update('plain', {
      fields: [...plain.fields, { name: 'mfa', type: 'bool' }],
    });
    expect(
      (await nextbase.client().collection('users').listAuthMethods()).mfa,
    ).toEqual({ enabled: true, duration: 300 });
  });

  it('signs in with one step until the account sets up an app (rule null)', async () => {
    await account('nina@example.com');
    const { methods, token } = await signIn('nina@example.com');
    expect(methods).toEqual(['password']);
    expect(token).toBeTruthy();
  });

  it('sets up an app, then asks for its code at sign-in, recording both methods', async () => {
    const user = await account('ann@example.com');
    const { nb, secret, uri, recoveryCodes } = await enroll('ann@example.com');
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(uri).toBe(
      `otpauth://totp/localhost:ann%40example.com?secret=${secret}&issuer=localhost&algorithm=SHA1&digits=6&period=30`,
    );
    expect(recoveryCodes).toHaveLength(10);
    for (const code of recoveryCodes) {
      expect(code).toMatch(
        /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/,
      );
    }
    expect(await users(nb).getMfa(user.id)).toEqual({
      totp: true,
      recoveryCodesLeft: 10,
    });
    // The secret is stored encrypted.
    const [row] = await query<{ secret: string }>(
      'SELECT secret FROM nextbase._totp WHERE record_id = $1',
      [user.id],
    );
    expect(row?.secret).toMatch(/^v1\./);
    expect(row?.secret).not.toContain(secret);
    const [sent] = (await mailsTo('ann@example.com')).filter((m) =>
      m.subject.includes('turned on'),
    );
    expect(sent).toBeDefined();

    const step = await challenged(
      users().signInWithPassword('ann@example.com', PASSWORD),
    );
    expect(step.methods).toEqual(['totp', 'recoveryCode']);
    expect(step.mfaId).toMatch(/^[\w-]{43}$/);
    // No session exists until the second step.
    const [sessions] = await query<{ count: number }>(
      'SELECT count(*)::int AS count FROM nextbase._sessions WHERE record_id = $1',
      [user.id],
    );
    expect(sessions?.count).toBe(1);
    const nb2 = nextbase.client();
    const auth = await users(nb2).signInWithTotp(await totp(user.id, secret), {
      mfaId: step.mfaId,
    });
    expect(auth.methods).toEqual(['password', 'totp']);
    expect(auth.record.id).toBe(user.id);
    expect(nb2.authStore.token).toBe(auth.token);
    const current = await nb2.getSession();
    expect(current?.methods).toEqual(['password', 'totp']);
    const listed = await nb2.listSessions();
    expect(listed.find((s) => s.current)?.methods).toEqual([
      'password',
      'totp',
    ]);
    // An mfaId is single use.
    const reused = await failure(
      users().signInWithTotp('123456', { mfaId: step.mfaId }),
    );
    expect(reused.status).toBe(400);
    expect(reused.data.mfaId).toMatchObject({ code: 'validation_invalid_mfa' });
  });

  it('accepts each TOTP step once, even from two requests at the same time', async () => {
    const user = await account('ben@example.com');
    const { secret } = await enroll('ben@example.com');
    const first = await challenged(
      users().signInWithPassword('ben@example.com', PASSWORD),
    );
    const second = await challenged(
      users().signInWithPassword('ben@example.com', PASSWORD),
    );
    const code = await totp(user.id, secret);
    const results = await Promise.allSettled([
      users().signInWithTotp(code, { mfaId: first.mfaId }),
      users().signInWithTotp(code, { mfaId: second.mfaId }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [refused] = results.filter((r) => r.status === 'rejected');
    expect(
      ((refused as PromiseRejectedResult).reason as ClientError).status,
    ).toBe(400);
    // The code of a step before one used is refused too.
    const third = await challenged(
      users().signInWithPassword('ben@example.com', PASSWORD),
    );
    const earlier = hotp(
      fromBase32(secret),
      (lastStep.get(user.id) as number) - 1,
    );
    expect(
      (await failure(users().signInWithTotp(earlier, { mfaId: third.mfaId })))
        .status,
    ).toBe(400);
    // Three steps ahead is outside the window.
    const ahead = hotp(fromBase32(secret), totpStep(Date.now()) + 3);
    expect(
      (await failure(users().signInWithTotp(ahead, { mfaId: third.mfaId })))
        .status,
    ).toBe(400);
  });

  it('refuses the same method twice, and other methods once an app is set up', async () => {
    await account('cora@example.com', {
      phone: '+255712000001',
      phoneVerified: true,
    });
    await enroll('cora@example.com');
    const step = await challenged(
      users().signInWithPassword('cora@example.com', PASSWORD),
    );
    const twice = await failure(
      users().signInWithPassword('cora@example.com', PASSWORD, {
        mfaId: step.mfaId,
      }),
    );
    expect(twice.status).toBe(400);
    expect(twice.data.mfaId).toMatchObject({ code: 'validation_mfa_method' });
    // An email or phone code would be weaker than the app.
    expect(
      (await failure(users().requestEmailCode({ mfaId: step.mfaId }))).status,
    ).toBe(400);
    expect(
      (await failure(users().requestMfaPhoneCode({ mfaId: step.mfaId })))
        .status,
    ).toBe(400);
    expect(
      (
        await failure(
          users().signInWithEmailCode('123456', { mfaId: step.mfaId }),
        )
      ).status,
    ).toBe(400);
    expect(await mailsTo('cora@example.com')).toHaveLength(1);
  });

  it('refuses an expired mfaId, one of another record, and one a password reset ended', async () => {
    const dora = await account('dora@example.com');
    const { secret } = await enroll('dora@example.com');
    await account('emil@example.com');
    const expired = await challenged(
      users().signInWithPassword('dora@example.com', PASSWORD),
    );
    await query(
      "UPDATE nextbase._mfas SET expires = now() - interval '1 second'",
    );
    expect(
      (
        await failure(
          users().signInWithTotp(await totp(dora.id, secret), {
            mfaId: expired.mfaId,
          }),
        )
      ).data.mfaId,
    ).toMatchObject({ code: 'validation_invalid_mfa' });
    lastStep.set(dora.id, (lastStep.get(dora.id) as number) - 1);

    // Dora's first step cannot finish Emil's sign-in.
    const doras = await challenged(
      users().signInWithPassword('dora@example.com', PASSWORD),
    );
    const crossed = await failure(
      users().signInWithPassword('emil@example.com', PASSWORD, {
        mfaId: doras.mfaId,
      }),
    );
    expect(crossed.status).toBe(400);
    // Nor of another collection.
    expect(
      (
        await failure(
          nextbase
            .client()
            .collection('strict')
            .signInWithTotp('123456', { mfaId: doras.mfaId }),
        )
      ).data.mfaId,
    ).toMatchObject({ code: 'validation_invalid_mfa' });

    // A password reset gives the record a new key, which ends the sign-in.
    await users().requestPasswordReset('dora@example.com');
    const link = (await mailsTo('dora@example.com')).at(-1)?.text ?? '';
    const token = /token=([\w.-]+)/.exec(link)?.[1] as string;
    await users().confirmPasswordReset(token, `${PASSWORD}!`, `${PASSWORD}!`);
    const ended = await failure(
      users().signInWithTotp(await totp(dora.id, secret), {
        mfaId: doras.mfaId,
      }),
    );
    expect(ended.data.mfaId).toMatchObject({ code: 'validation_invalid_mfa' });
  });

  it('ends an mfaId after five wrong codes, and limits wrong codes per account', async () => {
    const user = await account('fred@example.com');
    const { secret } = await enroll('fred@example.com');
    const wrong = (mfaId: string) =>
      failure(users().signInWithTotp('000000', { mfaId }));
    const first = await challenged(
      users().signInWithPassword('fred@example.com', PASSWORD),
    );
    for (let i = 0; i < 4; i++)
      expect((await wrong(first.mfaId)).status).toBe(400);
    const fifth = await wrong(first.mfaId);
    expect(fifth.message).toContain('sign in again');
    // Gone, even with the right code.
    const gone = await failure(
      users().signInWithTotp(await totp(user.id, secret), {
        mfaId: first.mfaId,
      }),
    );
    expect(gone.data.mfaId).toMatchObject({ code: 'validation_invalid_mfa' });
    lastStep.set(user.id, (lastStep.get(user.id) as number) - 1);
    // Five more wrong codes reach the account's limit of ten.
    const second = await challenged(
      users().signInWithPassword('fred@example.com', PASSWORD),
    );
    for (let i = 0; i < 4; i++) await wrong(second.mfaId);
    const third = await challenged(
      users().signInWithPassword('fred@example.com', PASSWORD),
    );
    await wrong(third.mfaId);
    const limited = await failure(
      users().signInWithTotp(await totp(user.id, secret), {
        mfaId: third.mfaId,
      }),
    );
    expect(limited.status).toBe(429);
  });

  it('spends each recovery code once, tells the owner, and regenerates them', async () => {
    const user = await account('gail@example.com');
    const { nb, secret, recoveryCodes } = await enroll('gail@example.com');
    const [code, other] = recoveryCodes as [string, string];
    const step = await challenged(
      users().signInWithPassword('gail@example.com', PASSWORD),
    );
    // Typed in lower case, without dashes.
    const auth = await users().signInWithRecoveryCode(
      code.toLowerCase().replaceAll('-', ''),
      { mfaId: step.mfaId },
    );
    expect(auth.methods).toEqual(['password', 'recoveryCode']);
    const notice = (await mailsTo('gail@example.com')).at(-1);
    expect(notice?.subject).toBe('A recovery code was used');
    expect(notice?.text).toContain('You have 9 left.');
    const again = await challenged(
      users().signInWithPassword('gail@example.com', PASSWORD),
    );
    expect(
      (
        await failure(
          users().signInWithRecoveryCode(code, { mfaId: again.mfaId }),
        )
      ).status,
    ).toBe(400);
    expect(await users(nb).getMfa(user.id)).toEqual({
      totp: true,
      recoveryCodesLeft: 9,
    });
    // Regenerating needs a code, and replaces every old one.
    expect(
      (await failure(users(nb).regenerateRecoveryCodes(user.id, ''))).status,
    ).toBe(400);
    const fresh = await users(nb).regenerateRecoveryCodes(
      user.id,
      await totp(user.id, secret),
    );
    expect(fresh).toHaveLength(10);
    expect(
      (
        await failure(
          users().signInWithRecoveryCode(other, { mfaId: again.mfaId }),
        )
      ).status,
    ).toBe(400);
    await users().signInWithRecoveryCode(fresh[0] as string, {
      mfaId: again.mfaId,
    });
  });

  it('refuses setup to a stale session without the password, an unverified email, or an off collection', async () => {
    const user = await account('hank@example.com');
    const { nb, record } = await signIn('hank@example.com');
    const session = await nb.getSession();
    await query(
      "UPDATE nextbase._sessions SET created = now() - interval '11 minutes' WHERE id = $1",
      [session?.id],
    );
    // Even a fresh session needs the password: a stolen one would lock the
    // owner out with an app of its own.
    const stale = await failure(users(nb).startTotp(record.id, ''));
    expect(stale.status).toBe(400);
    expect(stale.data.password).toMatchObject({ code: 'validation_required' });
    const wrong = await failure(
      users(nb).startTotp(record.id, 'wrong password!!'),
    );
    expect(wrong.data.password).toMatchObject({
      code: 'validation_invalid_password',
    });
    const setup = await users(nb).startTotp(record.id, PASSWORD);
    expect(setup.secret).toBeTruthy();
    // The setup expires after 15 minutes.
    await query(
      "UPDATE nextbase._totp SET created = now() - interval '16 minutes' WHERE record_id = $1",
      [user.id],
    );
    expect(
      (
        await failure(
          users(nb).confirmTotp(user.id, await totp(user.id, setup.secret)),
        )
      ).status,
    ).toBe(400);

    await admin.collection('users').create({
      email: 'ivy@example.com',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    const ivy = await signIn('ivy@example.com');
    const unverified = await failure(
      users(ivy.nb).startTotp(ivy.record.id, PASSWORD),
    );
    expect(unverified.data.totp).toMatchObject({
      code: 'validation_not_verified',
    });

    await account('jill@example.com', {}, 'plain');
    const jill = await signIn('jill@example.com', 'plain');
    const off = await failure(
      jill.nb.collection('plain').startTotp(jill.record.id, PASSWORD),
    );
    expect(off.status).toBe(400);
    // Only the record itself.
    expect(
      (await failure(users(ivy.nb).startTotp(user.id, PASSWORD))).status,
    ).toBe(404);
    expect((await failure(users().getMfa(user.id))).status).toBe(401);
  });

  it('needs a secret key to set up an app, but not for other methods', async () => {
    vi.stubEnv('NEXTBASE_SECRET_KEY', '');
    try {
      const keyless = new NextBase({ database: t.pool, rateLimits: false });
      await account('kyle@example.com', {}, 'strict');
      const nb = keyless.client();
      const step = await challenged(
        nb
          .collection('strict')
          .signInWithPassword('kyle@example.com', PASSWORD),
      );
      expect(step.methods).toEqual(['emailCode']);
      await account('kara@example.com');
      const kara = await keyless
        .client()
        .collection('users')
        .signInWithPassword('kara@example.com', PASSWORD);
      const error = await failure(
        keyless
          .client()
          .withAuthStore(
            (() => {
              const store = new AuthStore({ storage: null });
              store.save(kara.token as string, kara.record);
              return store;
            })(),
          )
          .collection('users')
          .startTotp(kara.record.id, PASSWORD),
      );
      expect(error.status).toBe(400);
      expect(error.message).toContain('secretKey');
      expect(error.data.secretKey).toMatchObject({
        code: 'secret_key_not_configured',
      });
      await keyless.flush();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('signs out other sessions when an app is confirmed, keeping this one', async () => {
    await account('lena@example.com');
    const other = await signIn('lena@example.com');
    const { nb } = await enroll('lena@example.com');
    expect((await failure(other.nb.getSession())).status).toBe(401);
    const current = await nb.getSession();
    expect(current?.methods).toEqual(['password', 'totp']);
    // The session counts the app, so rules see two methods.
    await admin.collection('secrets').create({ title: 'for lena' });
    expect(
      (await nb.collection('secrets').getFullList()).map((r) => r.title),
    ).toContain('for lena');
  });

  it('removes the app with a code, keeping sessions, and tells the owner', async () => {
    const user = await account('milo@example.com');
    const { nb, secret } = await enroll('milo@example.com');
    expect(
      (await failure(users(nb).removeTotp(user.id, ''))).data.mfaCode,
    ).toMatchObject({ code: 'validation_required' });
    expect(
      (await failure(users(nb).removeTotp(user.id, '000000'))).data.mfaCode,
    ).toMatchObject({ code: 'validation_invalid_code' });
    await users(nb).removeTotp(user.id, await totp(user.id, secret));
    expect(await users(nb).getMfa(user.id)).toEqual({
      totp: false,
      recoveryCodesLeft: 0,
    });
    expect(await nb.getSession()).not.toBeNull();
    expect((await mailsTo('milo@example.com')).at(-1)?.subject).toBe(
      'Two-step sign-in was turned off',
    );
    expect((await signIn('milo@example.com')).methods).toEqual(['password']);
    expect(
      (await failure(users(nb).removeTotp(user.id, '123456'))).status,
    ).toBe(400);
  });

  it('needs a code to change the password or the email once an app is set up', async () => {
    const user = await account('nora@example.com');
    const { nb, secret, recoveryCodes } = await enroll('nora@example.com');
    const change = {
      password: `${PASSWORD} new`,
      passwordConfirm: `${PASSWORD} new`,
      oldPassword: PASSWORD,
    };
    const refused = await failure(users(nb).update(user.id, change));
    expect(refused.data.mfaCode).toMatchObject({ code: 'validation_required' });
    await users(nb).update(user.id, {
      ...change,
      mfaCode: recoveryCodes[0],
    });

    const after = await challenged(
      users().signInWithPassword('nora@example.com', change.password),
    );
    const fresh = nextbase.client();
    await users(fresh).signInWithTotp(await totp(user.id, secret), {
      mfaId: after.mfaId,
    });
    await users(fresh).requestEmailChange('nora2@example.com');
    // The verified inbox approves it first.
    const approval = (await mailsTo('nora@example.com')).at(-1)?.text ?? '';
    await users().approveEmailChange(
      /token=([\w.-]+)/.exec(approval)?.[1] as string,
    );
    const link = (await mailsTo('nora2@example.com')).at(-1)?.text ?? '';
    const token = /token=([\w.-]+)/.exec(link)?.[1] as string;
    const noCode = await failure(
      users().confirmEmailChange(token, change.password),
    );
    expect(noCode.data.mfaCode).toMatchObject({ code: 'validation_required' });
    await users().confirmEmailChange(token, change.password, {
      mfaCode: recoveryCodes[1],
    });
    expect((await admin.collection('users').getOne(user.id)).email).toBe(
      'nora2@example.com',
    );
  });

  it('takes an email code as the second step', async () => {
    const user = await account('olga@example.com', {}, 'strict');
    const strict = nextbase.client().collection('strict');
    const step = await challenged(
      strict.signInWithPassword('olga@example.com', PASSWORD),
    );
    expect(step.methods).toEqual(['emailCode']);
    await strict.requestEmailCode({ mfaId: step.mfaId });
    const sent = (await mailsTo('olga@example.com')).at(-1) as MailMessage;
    expect(sent.subject).toBe('Your sign-in code');
    const code = await lastCode([sent]);
    expect(
      (
        await failure(
          strict.signInWithEmailCode(code === '000000' ? '111111' : '000000', {
            mfaId: step.mfaId,
          }),
        )
      ).status,
    ).toBe(400);
    const auth = await strict.signInWithEmailCode(code, { mfaId: step.mfaId });
    expect(auth.methods).toEqual(['password', 'emailCode']);
    expect(auth.record.id).toBe(user.id);
  });

  it('takes a phone code as the second step, texted to the verified phone', async () => {
    await account('pia@example.com', {
      phone: '+255712000002',
      phoneVerified: true,
    });
    await admin.collections.update('users', { mfa: { rule: '' } });
    try {
      const step = await challenged(
        users().signInWithPassword('pia@example.com', PASSWORD),
      );
      expect(step.methods).toEqual(['emailCode', 'phoneCode']);
      await users().requestMfaPhoneCode({ mfaId: step.mfaId });
      const code = await textedCode('+255712000002');
      const auth = await users().signInWithMfaPhoneCode(code, {
        mfaId: step.mfaId,
      });
      expect(auth.methods).toEqual(['password', 'phoneCode']);
      // Signing in with a phone code, the password is the second step.
      await users().requestPhoneCode('+255712000002');
      const first = await challenged(
        users().signInWithPhoneCode(
          '+255712000002',
          await textedCode('+255712000002'),
        ),
      );
      expect(first.methods).toEqual(['password', 'emailCode']);
      const second = await users().signInWithPassword(
        'pia@example.com',
        PASSWORD,
        { mfaId: first.mfaId },
      );
      expect(second.methods).toEqual(['phoneCode', 'password']);
    } finally {
      await admin.collections.update('users', { mfa: { rule: null } });
    }
  });

  it('challenges by the rule: every account, or the matching ones', async () => {
    await account('quin@example.com', {}, 'strict');
    await challenged(
      nextbase
        .client()
        .collection('strict')
        .signInWithPassword('quin@example.com', PASSWORD),
    );
    // A sign-up starts no session either: with no verified email yet, the
    // account has no second step to take, so it cannot sign in yet.
    const signedUp = await nextbase.client().collection('strict').signUp({
      email: 'rex@example.com',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    // Unlike an authRule refusal, the app learns why.
    expect(signedUp).toEqual({ mfa: 'verify' });
    const refused = await failure(
      nextbase
        .client()
        .collection('strict')
        .signInWithPassword('rex@example.com', PASSWORD),
    );
    expect(refused.status).toBe(403);
  });

  it('challenges by a filter rule only the matching accounts', async () => {
    await account('sam@example.com', { role: 'admin' }, 'staff');
    await account('tia@example.com', { role: 'member' }, 'staff');
    const staff = nextbase.client().collection('staff');
    const step = await challenged(
      staff.signInWithPassword('sam@example.com', PASSWORD),
    );
    expect(step.methods).toEqual(['emailCode']);
    expect(
      (await staff.signInWithPassword('tia@example.com', PASSWORD)).methods,
    ).toEqual(['password']);
    // Changing the rule leaves sessions as they are.
    const tia = await signIn('tia@example.com', 'staff');
    await admin.collections.update('staff', { mfa: { rule: '' } });
    try {
      expect(await tia.nb.getSession()).not.toBeNull();
      await challenged(staff.signInWithPassword('tia@example.com', PASSWORD));
    } finally {
      await admin.collections.update('staff', {
        mfa: { rule: 'role = "admin"' },
      });
    }
  });

  it('keeps the auth store on a 401 that asks for a second step', async () => {
    await account('uma@example.com');
    await enroll('uma@example.com');
    await account('vic@example.com');
    const nb = nextbase.client();
    const vic = await users(nb).signInWithPassword('vic@example.com', PASSWORD);
    await challenged(users(nb).signInWithPassword('uma@example.com', PASSWORD));
    expect(nb.authStore.token).toBe(vic.token);
    expect(nb.authStore.record?.id).toBe(vic.record.id);
    expect(isMfaRequired(new Error('other'))).toBeUndefined();
  });

  it('reads @request.mfa in rules and realtime', async () => {
    await account('wes@example.com');
    const plain = await signIn('wes@example.com');
    await account('xia@example.com');
    const strong = await enroll('xia@example.com');
    const created = await admin.collection('secrets').create({ title: 'x' });
    if (!created) throw new Error('A superuser views every record.');
    expect(await plain.nb.collection('secrets').getFullList()).toEqual([]);
    expect(
      (await failure(plain.nb.collection('secrets').getOne(created.id))).status,
    ).toBe(404);
    expect(
      (await strong.nb.collection('secrets').getOne(created.id)).title,
    ).toBe('x');
    // Hooks see how the caller signed in.
    hookMethods.length = 0;
    await strong.nb.collection('secrets').create({ title: 'by xia' });
    await plain.nb.collection('secrets').create({ title: 'by wes' });
    expect(hookMethods).toEqual([['password', 'totp'], ['password']]);

    const plainStream = await stream(plain.token as string);
    const strongStream = await stream(strong.token as string);
    try {
      await admin.collection('secrets').create({ title: 'live' });
      await waitFor(() => strongStream.titles.includes('live'), 'the event');
      // Both streams are told of writes in the same order.
      await admin.collection('secrets').create({ title: 'public' });
      await waitFor(
        () => strongStream.titles.includes('public'),
        'the second event',
      );
      expect(plainStream.titles).toEqual([]);
    } finally {
      await plainStream.close();
      await strongStream.close();
    }
  });

  it('lets an impersonation skip the second step, and keeps it out of the settings', async () => {
    const user = await account('yan@example.com');
    const { secret } = await enroll('yan@example.com');
    await nextbase.createSuperuser('root@example.com', PASSWORD);
    const root = nextbase.client();
    await root
      .collection('_superusers')
      .signInWithPassword('root@example.com', PASSWORD);
    const { client: acting, methods } = await root
      .collection('users')
      .impersonate(user.id);
    expect(methods).toEqual(['impersonation']);
    expect((await acting.getSession())?.methods).toEqual(['impersonation']);
    // One method only, so rules see no second step.
    expect(await acting.collection('secrets').getFullList()).toEqual([]);
    const service = acting.collection('users');
    for (const attempt of [
      () => service.getMfa(user.id),
      () => service.startTotp(user.id, PASSWORD),
      () => service.confirmTotp(user.id, '123456'),
      () => service.removeTotp(user.id, '123456'),
      () => service.regenerateRecoveryCodes(user.id, '123456'),
    ]) {
      const error = await failure(attempt());
      expect(error.status).toBe(403);
      expect(error.message).toBe(
        'Impersonation sessions cannot manage multi-factor sign-in.',
      );
    }
    // The app is untouched.
    const step = await challenged(
      users().signInWithPassword('yan@example.com', PASSWORD),
    );
    await users().signInWithTotp(await totp(user.id, secret), {
      mfaId: step.mfaId,
    });
  });

  it('takes the second step after an OAuth2 sign-in, through an HttpOnly cookie', async () => {
    const response = await oauth2(
      'strict',
      { sub: 'zoe', email: 'zoe@example.com' },
      '',
      '/home?tab=a&mfa=mine',
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.pathname).toBe('/home');
    // Added after the app's own parameters, which stay. Nothing secret goes
    // in the URL, not even the methods, and no session starts.
    expect([...location.searchParams.entries()]).toEqual([
      ['tab', 'a'],
      ['mfa', 'mine'],
      ['mfa', 'required'],
    ]);
    expect(cookieOf(response, 'nextbase_session')).toBeUndefined();
    const cookie = cookieOf(response, 'nextbase_mfa') as string;
    const header = response.headers
      .getSetCookie()
      .find((c) => c.startsWith('nextbase_mfa='));
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Max-Age=120');

    // The page reads the methods with the cookie, which only it sends.
    const pendingMethods = await raw('GET', '/collections/strict/mfa', {
      cookie,
    });
    // Its password was made up at sign-up, so it is no step.
    expect(await pendingMethods.json()).toEqual({ methods: ['emailCode'] });
    expect((await raw('GET', '/collections/strict/mfa')).status).toBe(400);
    // Another site cannot use it.
    const crossSite = await raw(
      'POST',
      '/collections/strict/request-email-code',
      { cookie, origin: 'https://evil.example' },
      {},
    );
    expect(crossSite.status).toBe(403);
    const sent = await raw(
      'POST',
      '/collections/strict/request-email-code',
      { cookie, origin },
      {},
    );
    expect(sent.status).toBe(204);
    const code = await lastCode(await mailsTo('zoe@example.com'));
    const done = await raw(
      'POST',
      '/collections/strict/auth-with-email-code',
      { cookie, origin },
      { code },
    );
    expect(done.status).toBe(200);
    const body = (await done.json()) as Record<string, unknown>;
    expect(body.token).toBeUndefined();
    expect(body.methods).toEqual(['oauth2', 'emailCode']);
    const session = cookieOf(done, 'nextbase_session') as string;
    expect(session).toBeDefined();
    // The cookie is removed.
    expect(
      done.headers.getSetCookie().some((c) => c.startsWith('nextbase_mfa=;')),
    ).toBe(true);
    const me = await raw('GET', '/session', { cookie: session });
    expect(((await me.json()) as { methods: string[] }).methods).toEqual([
      'oauth2',
      'emailCode',
    ]);
  });

  it('takes OAuth2 as the second step, with a provider linked to the account', async () => {
    // Signs up through the provider, then gets a password.
    const first = await oauth2('strict', {
      sub: 'amy',
      email: 'amy@example.com',
    });
    expect(
      new URL(first.headers.get('location') ?? '').searchParams.get('mfa'),
    ).toBe('required');
    const amy = await admin
      .collection('strict')
      .getFirstListItem('email = "amy@example.com"');
    await admin.collection('strict').update(amy.id, {
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    const step = await challenged(
      nextbase
        .client()
        .collection('strict')
        .signInWithPassword('amy@example.com', PASSWORD),
    );
    expect(step.methods).toEqual(['emailCode', 'oauth2']);
    // A provider account linked to no one, or to another record, proves nothing.
    const stranger = await oauth2(
      'strict',
      { sub: 'stranger', email: 'stranger@example.com' },
      `&mfaId=${step.mfaId}`,
    );
    expect(
      new URL(stranger.headers.get('location') ?? '').searchParams.get('error'),
    ).toBe('mfa_failed');
    expect(
      (
        await query(
          'SELECT 1 FROM nextbase._linked_accounts WHERE provider_id = $1',
          ['stranger'],
        )
      ).length,
    ).toBe(0);
    const done = await oauth2(
      'strict',
      { sub: 'amy', email: 'amy@example.com' },
      `&mfaId=${step.mfaId}`,
    );
    const location = new URL(done.headers.get('location') ?? '');
    expect(location.searchParams.get('error')).toBeNull();
    const session = cookieOf(done, 'nextbase_session') as string;
    const me = await raw('GET', '/session', { cookie: session });
    expect(((await me.json()) as { methods: string[] }).methods).toEqual([
      'password',
      'oauth2',
    ]);
    // Single use.
    const again = await raw(
      'GET',
      `/collections/strict/auth-with-oauth2/idp?mfaId=${step.mfaId}`,
    );
    expect(again.status).toBe(400);
  });

  it('opens a secret only on its own row, and with rotated keys', async () => {
    const one = await account('dan@example.com');
    const { secret } = await enroll('dan@example.com');
    const two = await account('eve@example.com');
    await enroll('eve@example.com');
    // Dan's encrypted secret, moved to Eve's row, does not open there.
    await query(
      `UPDATE nextbase._totp SET secret =
         (SELECT secret FROM nextbase._totp WHERE record_id = $1)
       WHERE record_id = $2`,
      [one.id, two.id],
    );
    const eves = await challenged(
      users().signInWithPassword('eve@example.com', PASSWORD),
    );
    // A step after the one Eve's row last used, so only the key can refuse it.
    const next = Math.max(
      lastStep.get(one.id) as number,
      lastStep.get(two.id) as number,
    );
    const moved = await failure(
      users().signInWithTotp(hotp(fromBase32(secret), next + 1), {
        mfaId: eves.mfaId,
      }),
    );
    expect(moved.data.code).toMatchObject({ code: 'validation_invalid_code' });

    // A new key first, the old one kept: secrets made before still open.
    const rotated = new NextBase({
      database: t.pool,
      secretKey: [OTHER_KEY, KEY],
      rateLimits: false,
    });
    try {
      const dans = rotated.client().collection('users');
      const step = await challenged(
        dans.signInWithPassword('dan@example.com', PASSWORD),
      );
      const auth = await dans.signInWithTotp(await totp(one.id, secret), {
        mfaId: step.mfaId,
      });
      expect(auth.methods).toEqual(['password', 'totp']);
    } finally {
      await rotated.flush();
    }
  });

  it('removes MFA rows with their record and their collection', async () => {
    const count = async (id: string): Promise<number[]> =>
      Promise.all(
        ['_totp', '_recovery_codes', '_mfas'].map(
          async (name) =>
            (
              await query<{ n: number }>(
                `SELECT count(*)::int AS n FROM nextbase.${name} WHERE record_id = $1`,
                [id],
              )
            )[0]?.n as number,
        ),
      );
    const user = await account('bea@example.com');
    await enroll('bea@example.com');
    await challenged(users().signInWithPassword('bea@example.com', PASSWORD));
    expect(await count(user.id)).toEqual([1, 10, 1]);
    await admin.collection('users').delete(user.id);
    expect(await count(user.id)).toEqual([0, 0, 0]);

    await admin.collections.create({
      name: 'temp',
      type: 'auth',
      mfa: { enabled: true },
    });
    const temp = await account('cal@example.com', {}, 'temp');
    await enroll('cal@example.com', 'temp');
    await challenged(
      nextbase
        .client()
        .collection('temp')
        .signInWithPassword('cal@example.com', PASSWORD),
    );
    expect(await count(temp.id)).toEqual([1, 10, 1]);
    await admin.collections.delete('temp');
    expect(await count(temp.id)).toEqual([0, 0, 0]);
  });

  it('works for superusers, whose app the CLI can reset', async () => {
    await admin.collections.update('_superusers', { mfa: { enabled: true } });
    await nextbase.createSuperuser('ops@example.com', PASSWORD);
    const { secret, record } = await enroll('ops@example.com', '_superusers');
    const supers = () => nextbase.client().collection('_superusers');
    const step = await challenged(
      supers().signInWithPassword('ops@example.com', PASSWORD),
    );
    expect(step.methods).toEqual(['totp', 'recoveryCode']);
    const auth = await supers().signInWithTotp(await totp(record.id, secret), {
      mfaId: step.mfaId,
    });
    expect(auth.methods).toEqual(['password', 'totp']);

    const out: string[] = [];
    const err: string[] = [];
    const io: Io = {
      env: { DATABASE_URL: t.url },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      prompt: async () => '',
    };
    expect(
      await run(['superuser', 'mfa-reset', 'nobody@example.com'], io),
    ).toBe(1);
    expect(err).toEqual(['No superuser has the email nobody@example.com.']);
    expect(await run(['superuser', 'mfa-reset', 'OPS@example.com'], io)).toBe(
      0,
    );
    expect(out).toEqual([
      'Removed the authenticator app and recovery codes of the superuser OPS@example.com.',
    ]);
    expect(
      (await supers().signInWithPassword('ops@example.com', PASSWORD)).methods,
    ).toEqual(['password']);
  });

  it('makes superusers take their second step with an app, and the CLI set one up', async () => {
    await admin.collections.update('_superusers', {
      mfa: { enabled: true, rule: '' },
    });
    vi.stubEnv('NEXTBASE_SECRET_KEY', KEY);
    try {
      await nextbase.createSuperuser('new@example.com', PASSWORD);
      const supers = () => nextbase.client().collection('_superusers');
      // A verified email is no second step for a superuser.
      const none = await failure(
        supers().signInWithPassword('new@example.com', PASSWORD),
      );
      expect(none.status).toBe(403);
      expect(none.message).toContain('nextbase superuser mfa-setup');

      const out: string[] = [];
      const io: Io = {
        env: { DATABASE_URL: t.url },
        out: (line) => out.push(line),
        err: (line) => out.push(line),
        // Reads the secret it printed, as an authenticator app would.
        prompt: async () => {
          const secret = out
            .find((line) => line.startsWith('Secret: '))
            ?.slice(8) as string;
          return hotp(fromBase32(secret), totpStep(Date.now()));
        },
      };
      expect(await run(['superuser', 'mfa-setup', 'new@example.com'], io)).toBe(
        0,
      );
      expect(out[1]).toMatch(/^otpauth:\/\/totp\//);
      const secret = out[2]?.slice(8) as string;
      const record = await admin
        .collection('_superusers')
        .getFirstListItem('email = "new@example.com"');
      lastStep.set(record.id, totpStep(Date.now()));
      expect(
        out.slice(-10).every((c) => /^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/.test(c)),
      ).toBe(true);
      const step = await challenged(
        supers().signInWithPassword('new@example.com', PASSWORD),
      );
      expect(step.methods).toEqual(['totp', 'recoveryCode']);
      expect(
        (await failure(supers().requestEmailCode({ mfaId: step.mfaId })))
          .status,
      ).toBe(400);
      await supers().signInWithTotp(await totp(record.id, secret), {
        mfaId: step.mfaId,
      });
    } finally {
      vi.unstubAllEnvs();
      await admin.collections.update('_superusers', {
        mfa: { enabled: false, rule: null },
      });
    }
  });

  it("lets a superuser clear another account's app, and tells the owner", async () => {
    const user = await account('ida@example.com');
    const { nb } = await enroll('ida@example.com');
    // Not the owner, nor any other non-superuser.
    expect((await failure(users(nb).clearMfa(user.id))).status).toBe(403);
    await admin.collection('users').clearMfa(user.id);
    expect(await users(nb).getMfa(user.id)).toEqual({
      totp: false,
      recoveryCodesLeft: 0,
    });
    expect((await mailsTo('ida@example.com')).at(-1)?.subject).toBe(
      'Two-step sign-in was reset',
    );
    expect((await signIn('ida@example.com')).methods).toEqual(['password']);
    expect(
      (await failure(admin.collection('users').clearMfa('nosuchrecord12')))
        .status,
    ).toBe(404);
    // A superuser removes their own app with a code, as anyone does.
    await nextbase.createSuperuser('self@example.com', PASSWORD);
    const root = nextbase.client();
    const me = await root
      .collection('_superusers')
      .signInWithPassword('self@example.com', PASSWORD);
    expect(
      (await failure(root.collection('_superusers').clearMfa(me.record.id)))
        .status,
    ).toBe(400);
    // Nor through an impersonation session.
    const { client: acting } = await root
      .collection('users')
      .impersonate(user.id);
    expect(
      (await failure(acting.collection('users').clearMfa(user.id))).status,
    ).toBe(403);
  });

  it('pairs no reset by email with an email code, for a day, and says so', async () => {
    const user = await account('jo@example.com', {}, 'strict');
    const strict = () => nextbase.client().collection('strict');
    await strict().requestPasswordReset('jo@example.com');
    const link = (await mailsTo('jo@example.com')).at(-1)?.text ?? '';
    const token = /token=([\w.-]+)/.exec(link)?.[1] as string;
    await strict().confirmPasswordReset(token, `${PASSWORD}!`, `${PASSWORD}!`);
    const notice = (await mailsTo('jo@example.com')).find((m) =>
      m.subject.startsWith('Sign-in codes paused'),
    );
    expect(notice?.text).toContain('codes sent to your email will not count');
    // The inbox that reset the password cannot also be its second step.
    const held = await failure(
      strict().signInWithPassword('jo@example.com', `${PASSWORD}!`),
    );
    expect(held.status).toBe(403);
    await query(
      "UPDATE nextbase._password_origins SET set_at = now() - interval '25 hours' WHERE record_id = $1",
      [user.id],
    );
    const later = await challenged(
      strict().signInWithPassword('jo@example.com', `${PASSWORD}!`),
    );
    expect(later.methods).toEqual(['emailCode']);
  });

  it('pairs no reset by text with a phone code, whichever step comes first', async () => {
    const user = await account('kim@example.com', {
      phone: '+255712000009',
      phoneVerified: true,
    });
    await admin.collections.update('users', { mfa: { rule: '' } });
    try {
      await users().requestPasswordResetByPhone('+255712000009');
      await users().confirmPasswordResetByPhone(
        '+255712000009',
        await textedCode('+255712000009'),
        `${PASSWORD}!`,
        `${PASSWORD}!`,
      );
      const first = await challenged(
        users().signInWithPassword('kim@example.com', `${PASSWORD}!`),
      );
      expect(first.methods).toEqual(['emailCode']);
      await users().requestPhoneCode('+255712000009');
      const byPhone = await challenged(
        users().signInWithPhoneCode(
          '+255712000009',
          await textedCode('+255712000009'),
        ),
      );
      expect(byPhone.methods).toEqual(['emailCode']);
      expect(
        (
          await failure(
            users().signInWithPassword('kim@example.com', `${PASSWORD}!`, {
              mfaId: byPhone.mfaId,
            }),
          )
        ).data.mfaId,
      ).toMatchObject({ code: 'validation_mfa_method' });
      // A password the owner chose again pairs with anything.
      await admin.collection('users').update(user.id, {
        password: PASSWORD,
        passwordConfirm: PASSWORD,
      });
      const chosen = await challenged(
        users().signInWithPassword('kim@example.com', PASSWORD),
      );
      expect(chosen.methods).toEqual(['emailCode', 'phoneCode']);
    } finally {
      await admin.collections.update('users', { mfa: { rule: null } });
    }
  });

  it('never offers a password nobody chose', async () => {
    await admin.collections.update('users', { mfa: { rule: '' } });
    try {
      await users().requestPhoneCode('+255712000010');
      const signUp = await failure(
        users().signInWithPhoneCode(
          '+255712000010',
          await textedCode('+255712000010'),
        ),
      );
      // Its only other step would be its made-up password.
      expect(signUp.status).toBe(403);
    } finally {
      await admin.collections.update('users', { mfa: { rule: null } });
    }
  });

  it('moves an account to a new email only once its verified inbox approves', async () => {
    await account('lou@example.com');
    const stolen = await signIn('lou@example.com');
    await users(stolen.nb).requestEmailChange('thief@example.com');
    // Nothing goes to the new address yet; the owner's inbox is asked.
    expect(await mailsTo('thief@example.com')).toEqual([]);
    const approval = (await mailsTo('lou@example.com')).at(-1) as MailMessage;
    expect(approval.subject).toBe('Approve the change of your email');
    expect(approval.text).toContain('/approve-email-change?token=');
    const token = /token=([\w.-]+)/.exec(approval.text)?.[1] as string;
    // Only for the address it names, and once.
    const other = await raw(
      'POST',
      '/collections/users/approve-email-change',
      {},
      { token, newEmail: 'else@example.com' },
    );
    expect(other.status).toBe(400);
    expect(await mailsTo('else@example.com')).toEqual([]);
    await users().approveEmailChange(token);
    expect((await mailsTo('thief@example.com')).at(-1)?.subject).toBe(
      'Confirm your new email',
    );
    expect(
      (await failure(users().approveEmailChange(token))).data.token,
    ).toMatchObject({ code: 'validation_invalid_token' });
  });

  it('keeps the one-link email change for an unverified email', async () => {
    await admin.collection('users').create({
      email: 'max@example.com',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    const max = await signIn('max@example.com');
    await users(max.nb).requestEmailChange('max2@example.com');
    const link = (await mailsTo('max2@example.com')).at(-1)?.text ?? '';
    const token = /token=([\w.-]+)/.exec(link)?.[1] as string;
    await users().confirmEmailChange(token, PASSWORD);
    expect(
      (
        await admin
          .collection('users')
          .getFirstListItem('email = "max2@example.com"')
      ).email,
    ).toBe('max2@example.com');
  });

  it('shows an open stream the records @request.mfa allows once its session confirms an app', async () => {
    const before = timings.sessionMs;
    timings.sessionMs = 50;
    try {
      const user = await account('ned@example.com');
      const { nb, token } = await signIn('ned@example.com');
      const live = await stream(token as string);
      try {
        const setup = await users(nb).startTotp(user.id, PASSWORD);
        await users(nb).confirmTotp(user.id, await totp(user.id, setup.secret));
        // Once the stream has read the session again, records flow.
        await waitFor(async () => {
          await admin.collection('secrets').create({ title: 'ned' });
          await new Promise((resolve) => setTimeout(resolve, 100));
          return live.titles.includes('ned');
        }, 'the record');
      } finally {
        await live.close();
      }
    } finally {
      timings.sessionMs = before;
    }
  });
});
