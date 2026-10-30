import { createHash, randomBytes } from 'node:crypto';
import type { NextBaseClient } from '@nextbasejs/client';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type MailMessage, NextBase } from '../src/index.ts';
import { call, origin } from './http.ts';
import { createTestDatabase, type TestDatabase } from './postgres.ts';

const ISSUER = 'https://idp.example.com';
/** Where a provider sends the browser back. */
const callbackOf = (provider: string): string =>
  `${origin}/api/nextbase/callback/${provider}`;
const PASSWORD = 'password 123 456';

/** The account a fake provider signs in, and how it answers. */
interface Account {
  sub: string;
  email?: string;
  /** Whether the provider verified `email`; it did unless this says no. */
  emailVerified?: boolean;
  /** Overrides the nonce in the ID token. */
  nonce?: string;
  /** More claims for the ID token, such as `name`. */
  claims?: Record<string, unknown>;
}

interface Grant {
  challenge: string;
  redirectUri: string;
  nonce: string | null;
  account: Account;
}

describe('OAuth2 sign-in', () => {
  let t: TestDatabase;
  let nextbase: NextBase;
  let admin: NextBaseClient;
  const sent: MailMessage[] = [];
  const pending: Promise<unknown>[] = [];
  const grants = new Map<string, Grant>();
  /** The record hooks that ran for `users`, with their source. */
  const hooked: string[] = [];
  /** Refresh grants the fake provider answered. */
  let refreshes = 0;
  /** Makes the next refresh answer a token type NextBase refuses. */
  let badRefresh = false;
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;

  /** A fake OpenID Connect provider and GitHub, behind fetch. */
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
    const tokenEndpoint =
      url.href === `${ISSUER}/token` ||
      url.href === 'https://github.com/login/oauth/access_token';
    if (tokenEndpoint && request.method === 'POST') {
      const body = new URLSearchParams(await request.text());
      if (body.get('grant_type') === 'refresh_token') {
        const refresh = body.get('refresh_token') ?? '';
        if (
          !refresh.startsWith('rt-') ||
          body.get('client_secret') !== 'secret'
        ) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        }
        refreshes++;
        if (badRefresh) {
          badRefresh = false;
          return Response.json({
            access_token: 'at-leaked',
            token_type: 'mac',
            refresh_token: `rt-rotated-${refresh.slice(3)}`,
          });
        }
        return Response.json({
          access_token: `at${refreshes}-${refresh.slice(3)}`,
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      const grant = grants.get(body.get('code') ?? '');
      grants.delete(body.get('code') ?? '');
      const verifier = createHash('sha256')
        .update(body.get('code_verifier') ?? '')
        .digest('base64url');
      if (
        !grant ||
        verifier !== grant.challenge ||
        body.get('redirect_uri') !== grant.redirectUri ||
        body.get('client_secret') !== 'secret'
      ) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      const accessToken = `at-${grant.account.sub}`;
      if (url.hostname === 'github.com') {
        return Response.json({
          access_token: accessToken,
          token_type: 'bearer',
          scope: 'read:user,user:email',
        });
      }
      const idToken = await new SignJWT({
        ...grant.account.claims,
        ...(grant.account.email !== undefined && {
          email: grant.account.email,
          email_verified: grant.account.emailVerified ?? true,
        }),
        nonce: grant.account.nonce ?? grant.nonce,
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(ISSUER)
        .setSubject(grant.account.sub)
        .setAudience('client')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(keys.privateKey);
      return Response.json({
        access_token: accessToken,
        token_type: 'Bearer',
        id_token: idToken,
        expires_in: 3600,
        refresh_token: `rt-${grant.account.sub}`,
      });
    }
    if (url.hostname === 'api.github.com') {
      const sub = (request.headers.get('authorization') ?? '').replace(
        'Bearer at-',
        '',
      );
      if (url.pathname === '/user') return Response.json({ id: Number(sub) });
      if (url.pathname === '/user/emails') {
        return Response.json([
          { email: `old${sub}@example.com`, primary: false, verified: true },
          { email: `gh${sub}@example.com`, primary: true, verified: true },
        ]);
      }
    }
    return new Response('not found', { status: 404 });
  };

  const raw = (
    method: string,
    path: string,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    nextbase.handle(
      new Request(
        path.startsWith('http') ? path : `${origin}/api/nextbase${path}`,
        {
          method,
          headers,
        },
      ),
    );

  const cookieOf = (response: Response, name: string): string | undefined =>
    response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0] as string)
      .find((c) => c.startsWith(`${name}=`) && c !== `${name}=`);

  /**
   * Starts a sign-in, lets the fake provider approve `account`, and returns
   * the callback's response.
   */
  const signIn = async (
    providerName: string,
    account: Account,
    {
      query = '',
      cookie,
      tamper,
      signedOut = false,
    }: {
      query?: string;
      /** The session cookie to start with. */
      cookie?: string;
      tamper?: (callback: URL, stateCookie: string) => [URL, string];
      /** Return from the provider without the session cookie. */
      signedOut?: boolean;
    } = {},
  ): Promise<Response> => {
    // A link starts with the password, by a POST that answers the URL.
    const params = new URLSearchParams(query.replace(/^\?/, ''));
    const linking = params.get('link') === 'true';
    const start = linking
      ? await nextbase.handle(
          new Request(
            `${origin}/api/nextbase/collections/users/link-oauth2/${providerName}`,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...(cookie && { cookie }),
                'sec-fetch-site': 'same-origin',
              },
              body: JSON.stringify({
                password: PASSWORD,
                ...(params.has('redirect') && {
                  redirect: params.get('redirect'),
                }),
              }),
            },
          ),
        )
      : await raw(
          'GET',
          `/collections/users/auth-with-oauth2/${providerName}${query}`,
          {
            ...(cookie && { cookie, 'sec-fetch-site': 'same-origin' }),
          },
        );
    expect(start.status).toBe(linking ? 200 : 302);
    const authorize = new URL(
      linking
        ? ((await start.json()) as { url: string }).url
        : (start.headers.get('location') ?? ''),
    );
    const redirectUri = authorize.searchParams.get('redirect_uri') ?? '';
    expect(redirectUri).toBe(callbackOf(providerName));
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    const code = randomBytes(16).toString('hex');
    grants.set(code, {
      challenge: authorize.searchParams.get('code_challenge') ?? '',
      redirectUri,
      nonce: authorize.searchParams.get('nonce'),
      account,
    });
    let callback = new URL(redirectUri);
    callback.searchParams.set('code', code);
    callback.searchParams.set(
      'state',
      authorize.searchParams.get('state') ?? '',
    );
    let stateCookie = cookieOf(start, 'nextbase_oauth2') ?? '';
    if (tamper) [callback, stateCookie] = tamper(callback, stateCookie);
    return raw('GET', callback.href, {
      cookie: [stateCookie, signedOut ? undefined : cookie]
        .filter(Boolean)
        .join('; '),
    });
  };

  const errorOf = (response: Response): string | null =>
    new URL(response.headers.get('location') ?? '').searchParams.get('error');

  /** The session a successful sign-in set, as a cookie header. */
  const sessionOf = (response: Response): string => {
    expect(response.status).toBe(302);
    expect(errorOf(response)).toBeNull();
    const cookie = cookieOf(response, 'nextbase_session');
    expect(cookie).toBeDefined();
    return cookie as string;
  };

  const whoami = async (cookie: string): Promise<Record<string, unknown>> => {
    const response = await raw('GET', '/session', { cookie });
    expect(response.status).toBe(200);
    return ((await response.json()) as { record: Record<string, unknown> })
      .record;
  };

  /**
   * Creates an account with a password, its email verified unless `verified`
   * says no, and signs it in with a token.
   */
  const passwordAccount = async (email: string, verified = true) => {
    const users = nextbase.client().collection('users');
    await users.create({
      email,
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    const { record } = await users.signInWithPassword(email, PASSWORD);
    if (verified) {
      await admin
        .collection('users')
        .update(record.id, { emailVerified: true });
    }
    return users.signInWithPassword(email, PASSWORD);
  };

  /** Signs in with a cookie, as a browser would, and returns the cookie. */
  const cookieSignIn = async (email: string): Promise<string> => {
    const response = await nextbase.handle(
      new Request(
        `${origin}/api/nextbase/collections/users/auth-with-password`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin },
          body: JSON.stringify({
            identity: email,
            password: PASSWORD,
            cookie: true,
          }),
        },
      ),
    );
    return cookieOf(response, 'nextbase_session') as string;
  };

  const findUser = async (email: string) =>
    admin
      .collection('users')
      .getFirstListItem(`email = "${email}"`)
      .catch(() => undefined);

  beforeAll(async () => {
    keys = await generateKeyPair('RS256');
    vi.stubGlobal('fetch', provider);
    t = await createTestDatabase();
    nextbase = new NextBase({
      database: t.pool,
      appUrl: origin,
      secretKey: randomBytes(32).toString('base64'),
      oauth2: {
        idp: { issuer: ISSUER, clientId: 'client', clientSecret: 'secret' },
        github: { clientId: 'client', clientSecret: 'secret' },
        shop: {
          issuer: ISSUER,
          clientId: 'client',
          clientSecret: 'secret',
          scopes: ['offline_access', 'email'],
          prompt: 'select_account',
          params: { hd: 'example.com' },
          mapProfile: (profile, { data }) => ({
            name: `${String(profile.name)} via ${String(data?.ref ?? 'none')}`,
            // Never taken from a profile.
            email: 'someone@else.example',
            emailVerified: false,
          }),
        },
        closed: {
          issuer: ISSUER,
          clientId: 'client',
          clientSecret: 'secret',
          disableSignUp: true,
        },
        mobile: {
          issuer: ISSUER,
          clientId: ['web', 'ios', 'android'],
          clientSecret: 'secret',
        },
        vault: {
          issuer: ISSUER,
          clientId: 'client',
          clientSecret: 'secret',
          scopes: ['offline_access'],
          storeTokens: true,
        },
      },
      mail: {
        from: 'app@example.com',
        send: async (message) => {
          sent.push(message);
        },
      },
      waitUntil: (promise) => pending.push(promise),
      hooks: {
        users: {
          onCreate: (e) => void hooked.push(`onCreate ${e.source}`),
          onUpdate: (e) => {
            hooked.push(`onUpdate ${e.source}`);
            if (e.record.email === 'refused@example.com') {
              throw new Error('Refused by a hook.');
            }
          },
          afterCreate: (e) => void hooked.push(`afterCreate ${e.source}`),
          afterUpdate: (e) => void hooked.push(`afterUpdate ${e.source}`),
        },
      },
    });
    admin = nextbase.client({ superuser: true });
    await admin.collections.create({
      name: 'users',
      type: 'auth',
      createRule: '',
      viewRule: 'id = @request.auth.id',
      fields: [{ name: 'name', type: 'text' }],
    });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await nextbase.flush();
    await t.close();
  });

  it('lists the providers a sign-in page can offer', async () => {
    const methods = await nextbase
      .client()
      .collection('users')
      .listAuthMethods();
    expect(methods.oauth2).toEqual({
      enabled: true,
      providers: [
        { name: 'idp', displayName: 'idp' },
        { name: 'github', displayName: 'GitHub' },
        { name: 'shop', displayName: 'shop' },
        { name: 'closed', displayName: 'closed' },
        { name: 'mobile', displayName: 'mobile' },
        { name: 'vault', displayName: 'vault' },
      ],
    });
    const superusers = await nextbase
      .client()
      .collection('_superusers')
      .listAuthMethods();
    expect(superusers.oauth2).toEqual({ enabled: false, providers: [] });
  });

  it('asks the provider for its scopes, prompt and parameters', async () => {
    const start = await raw(
      'GET',
      `/collections/users/auth-with-oauth2/shop?params=${encodeURIComponent(
        JSON.stringify({ login_hint: 'pat@example.com', hd: 'other.com' }),
      )}`,
    );
    const authorize = new URL(start.headers.get('location') ?? '');
    expect(authorize.searchParams.get('scope')).toBe(
      'openid email offline_access',
    );
    expect(authorize.searchParams.get('prompt')).toBe('select_account');
    // A sign-in's own parameters win over the provider's.
    expect(authorize.searchParams.get('hd')).toBe('other.com');
    expect(authorize.searchParams.get('login_hint')).toBe('pat@example.com');

    for (const params of [
      { state: 'x' },
      { redirect_uri: 'x' },
      { Redirect_URI: 'x' },
      { response_mode: 'form_post' },
      { request_uri: 'https://evil.example/r' },
      { 'bad name': 'x' },
      { n: 1 },
    ]) {
      const refused = await raw(
        'GET',
        `/collections/users/auth-with-oauth2/shop?params=${encodeURIComponent(
          JSON.stringify(params),
        )}`,
      );
      expect(refused.status).toBe(400);
    }
    expect(
      (await raw('GET', '/collections/users/auth-with-oauth2/shop?data=nope'))
        .status,
    ).toBe(400);
    expect(
      () =>
        new NextBase({
          appUrl: origin,
          oauth2: {
            bad: {
              issuer: ISSUER,
              clientId: 'a',
              clientSecret: 'b',
              params: { client_id: 'c' },
            },
          },
        }),
    ).toThrow(/client_id/);
  });

  it('fills a new account from the profile and the data the app passed', async () => {
    const response = await signIn(
      'shop',
      { sub: 'pat', email: 'pat@example.com', claims: { name: 'Pat' } },
      {
        query: `?data=${encodeURIComponent(JSON.stringify({ ref: 'spring' }))}`,
      },
    );
    expect(errorOf(response)).toBeNull();
    const { rows } = await t.pool.query(
      `SELECT name, email, "emailVerified" FROM nextbase.users WHERE email = 'pat@example.com'`,
    );
    expect(rows).toEqual([
      { name: 'Pat via spring', email: 'pat@example.com', emailVerified: true },
    ]);
  });

  it('signs in existing accounts only, with a provider that creates none', async () => {
    const response = await signIn('closed', {
      sub: 'nobody',
      email: 'nobody@example.com',
    });
    expect(errorOf(response)).toBe('sign_up_disabled');
    expect(
      (
        await t.pool.query(
          "SELECT 1 FROM nextbase.users WHERE email = 'nobody@example.com'",
        )
      ).rows,
    ).toEqual([]);
  });

  describe('stored provider tokens', () => {
    /** Makes the account's tokens a minute old, so a forced refresh runs. */
    const settle = async (sub: string): Promise<void> => {
      await t.pool.query(
        "UPDATE nextbase._linked_accounts SET tokens_saved = now() - interval '1 minute' WHERE provider_id = $1",
        [sub],
      );
    };
    const tokenOf = async (
      cookie: string,
      id: string,
      provider = 'vault',
      query = '',
    ) => {
      const response = await raw(
        'GET',
        `/collections/users/records/${id}/linked-accounts/${provider}/token${query}`,
        { cookie },
      );
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    };

    it('keeps the tokens sealed, and hands out the access token to its owner', async () => {
      const cookie = sessionOf(
        await signIn('vault', { sub: 'v1', email: 'vera@example.com' }),
      );
      const { id } = (await whoami(cookie)) as { id: string };
      const { rows } = await t.pool.query(
        "SELECT access_token, refresh_token FROM nextbase._linked_accounts WHERE provider = 'vault' AND provider_id = 'v1'",
      );
      expect(rows[0].access_token).not.toContain('at-v1');
      expect(rows[0].refresh_token).not.toContain('rt-v1');
      const token = await tokenOf(cookie, id);
      expect(token.status).toBe(200);
      expect(token.body).toMatchObject({
        accessToken: 'at-v1',
        scopes: ['openid', 'email', 'offline_access'],
      });
      expect(typeof token.body.expiresAt).toBe('string');

      // Other accounts, and providers that keep no tokens, get none.
      const other = sessionOf(
        await signIn('vault', { sub: 'v2', email: 'walt@example.com' }),
      );
      expect((await tokenOf(other, id)).status).toBe(404);
      expect((await tokenOf(cookie, id, 'idp')).status).toBe(400);
      expect((await tokenOf(cookie, id, 'nope')).status).toBe(404);
    });

    it('refreshes a token that is due, once for requests that come together', async () => {
      const cookie = sessionOf(
        await signIn('vault', { sub: 'v3', email: 'xena@example.com' }),
      );
      const { id } = (await whoami(cookie)) as { id: string };
      await t.pool.query(
        "UPDATE nextbase._linked_accounts SET token_expires = now() - interval '1 minute' WHERE provider_id = 'v3'",
      );
      const before = refreshes;
      const tokens = await Promise.all(
        Array.from({ length: 5 }, () => tokenOf(cookie, id)),
      );
      expect(refreshes).toBe(before + 1);
      const fresh = `at${before + 1}-v3`;
      for (const token of tokens) {
        expect(token.body.accessToken).toBe(fresh);
      }
      // `refresh` forces one, once the last is a few seconds old; the
      // refresh token is kept for the next.
      await settle('v3');
      const forced = await tokenOf(cookie, id, 'vault', '?refresh=true');
      expect(forced.body.accessToken).toBe(`at${before + 2}-v3`);
    });

    it('never logs tokens, keeps a rotated refresh token, and forces one refresh at a time', async () => {
      const cookie = sessionOf(
        await signIn('vault', { sub: 'v4', email: 'yan@example.com' }),
      );
      const { id } = (await whoami(cookie)) as { id: string };
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      await settle('v4');
      badRefresh = true;
      const refused = await tokenOf(cookie, id, 'vault', '?refresh=true');
      expect(refused.status).toBe(400);
      const logged = JSON.stringify(errors.mock.calls);
      errors.mockRestore();
      expect(logged).not.toContain('at-leaked');
      expect(logged).not.toContain('rt-rotated');
      // The next refresh spends the rotated refresh token.
      await settle('v4');
      const next = await tokenOf(cookie, id, 'vault', '?refresh=true');
      expect(next.body.accessToken).toMatch(/-rotated-v4$/);
      // Forced again right after: answered without another refresh.
      const before = refreshes;
      const again = await tokenOf(cookie, id, 'vault', '?refresh=true');
      expect(refreshes).toBe(before);
      expect(again.body.accessToken).toBe(next.body.accessToken);
    });

    it('keeps the scopes the sign-in asked for when the provider names none', async () => {
      const cookie = sessionOf(
        await signIn(
          'vault',
          { sub: 'v5', email: 'zed@example.com' },
          { query: '?scopes=drive.file' },
        ),
      );
      const { id } = (await whoami(cookie)) as { id: string };
      expect((await tokenOf(cookie, id)).body.scopes).toEqual([
        'openid',
        'email',
        'offline_access',
        'drive.file',
      ]);
    });

    it('drops tokens it can no longer use', async () => {
      const cookie = sessionOf(
        await signIn('vault', { sub: 'v6', email: 'amy@example.com' }),
      );
      const { id } = (await whoami(cookie)) as { id: string };
      // Sealed with a key no longer configured.
      await t.pool.query(
        "UPDATE nextbase._linked_accounts SET access_token = 'v1.unknown.x.y.z' WHERE provider_id = 'v6'",
      );
      expect((await tokenOf(cookie, id)).status).toBe(404);
      const { rows } = await t.pool.query(
        "SELECT access_token FROM nextbase._linked_accounts WHERE provider_id = 'v6'",
      );
      expect(rows[0].access_token).toBeNull();
      // Kept by a provider whose storeTokens was turned off since.
      sessionOf(
        await signIn('idp', { sub: 'idp-drop', email: 'drop@example.com' }),
      );
      await t.pool.query(
        "UPDATE nextbase._linked_accounts SET access_token = 'sealed' WHERE provider_id = 'idp-drop'",
      );
      sessionOf(
        await signIn('idp', { sub: 'idp-drop', email: 'drop@example.com' }),
      );
      const idp = await t.pool.query(
        "SELECT access_token FROM nextbase._linked_accounts WHERE provider_id = 'idp-drop'",
      );
      expect(idp.rows[0]?.access_token ?? null).toBeNull();
    });

    it('asks for more scopes on a new link, and keeps the scopes granted', async () => {
      const start = await raw(
        'GET',
        `/collections/users/auth-with-oauth2/vault?scopes=${encodeURIComponent(
          'drive.file calendar',
        )}`,
      );
      expect(
        new URL(start.headers.get('location') ?? '').searchParams.get('scope'),
      ).toBe('openid email offline_access drive.file calendar');
      const refused = await raw(
        'GET',
        '/collections/users/auth-with-oauth2/vault?scopes=%22quoted%22',
      );
      expect(refused.status).toBe(400);
    });

    it('needs the secret key to store tokens', () => {
      expect(
        () =>
          new NextBase({
            appUrl: origin,
            oauth2: {
              vault: {
                issuer: ISSUER,
                clientId: 'a',
                clientSecret: 'b',
                storeTokens: true,
              },
            },
          }),
      ).toThrow(/secretKey/);
    });
  });

  describe('ID tokens from native apps', () => {
    /** An ID token as the fake provider's native SDK would issue it. */
    const idToken = async (
      claims: Record<string, unknown>,
      {
        audience = 'ios',
        key = keys.privateKey,
        expires = '5m',
      }: {
        audience?: string;
        key?: typeof keys.privateKey;
        expires?: string | number;
      } = {},
    ): Promise<string> =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(ISSUER)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime(expires)
        .sign(key);
    const signInWith = (
      provider: string,
      body: Record<string, unknown>,
    ): ReturnType<typeof call> =>
      call(
        nextbase,
        'POST',
        `/collections/users/auth-with-id-token/${provider}`,
        {
          body,
        },
      );

    it('signs up and in with a token issued to any of the client ids, once', async () => {
      const token = await idToken({
        sub: 'native-1',
        email: 'native@example.com',
        // As Apple sends it.
        email_verified: 'true',
        name: 'Nat',
      });
      const reply = await signInWith('mobile', { token });
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({
        record: { email: 'native@example.com', emailVerified: true },
        methods: ['oauth2'],
      });
      expect(typeof reply.body.token).toBe('string');
      const again = await signInWith('mobile', { token });
      expect(again.status).toBe(400);
      expect(again.body.message).toBe('The ID token was already used.');
      // Nor another spelling of its signature's spare bits.
      const last = token.at(-1) as string;
      const respelled = `${token.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
      expect((await signInWith('mobile', { token: respelled })).status).toBe(
        400,
      );
      // The same account, with a new token from another of the apps.
      const android = await signInWith('mobile', {
        token: await idToken(
          {
            sub: 'native-1',
            email: 'native@example.com',
            email_verified: true,
          },
          { audience: 'android' },
        ),
      });
      expect(android.body.record).toMatchObject({
        id: (reply.body.record as { id: string }).id,
      });
    });

    it('refuses a token of another app, expired, or not signed by the provider', async () => {
      const other = await generateKeyPair('RS256');
      for (const token of [
        await idToken({ sub: 'x1' }, { audience: 'someone-else' }),
        await idToken(
          { sub: 'x2' },
          { expires: Math.floor(Date.now() / 1000) - 120 },
        ),
        await idToken({ sub: 'x3' }, { key: other.privateKey }),
        'not.a.token',
      ]) {
        const reply = await signInWith('mobile', { token });
        expect(reply.status).toBe(400);
        expect(reply.body.data).toMatchObject({
          token: { code: 'validation_invalid_token' },
        });
      }
      expect((await signInWith('mobile', {})).status).toBe(400);
      expect((await signInWith('github', { token: 'x' })).status).toBe(400);
    });

    it('checks the nonce, as is or hashed', async () => {
      const nonce = 'n-123';
      const hashed = createHash('sha256').update(nonce).digest('hex');
      const ok = await signInWith('mobile', {
        nonce,
        token: await idToken({
          sub: 'nonce-1',
          email: 'nonce@example.com',
          email_verified: true,
          nonce: hashed,
        }),
      });
      expect(ok.status).toBe(200);
      const wrong = await signInWith('mobile', {
        nonce: 'other',
        token: await idToken({ sub: 'nonce-1', nonce }),
      });
      expect(wrong.status).toBe(400);
    });

    it('answers the browser sign-in errors as JSON', async () => {
      const closed = await signInWith('closed', {
        token: await idToken(
          { sub: 'closed-1', email: 'shut@example.com', email_verified: true },
          { audience: 'client' },
        ),
      });
      expect(closed.status).toBe(400);
      expect(closed.body.data).toMatchObject({
        token: { code: 'sign_up_disabled' },
      });
      const unverified = await signInWith('mobile', {
        token: await idToken({
          sub: 'unverified-1',
          email: 'unverified@example.com',
          email_verified: false,
        }),
      });
      expect(unverified.body.data).toMatchObject({
        token: { code: 'email_not_verified' },
      });
    });
  });

  it('signs up a new account with the email the provider verified', async () => {
    const response = await signIn(
      'idp',
      { sub: 'u1', email: 'ada@example.com', emailVerified: true },
      { query: '?redirect=/home' },
    );
    expect(response.headers.get('location')).toBe(`${origin}/home`);
    const record = await whoami(sessionOf(response));
    expect(record).toMatchObject({
      email: 'ada@example.com',
      emailVerified: true,
    });
  });

  it("runs record hooks for a sign-up as NextBase's own writes", async () => {
    hooked.length = 0;
    sessionOf(
      await signIn('idp', { sub: 'u-hooks', email: 'hook@example.com' }),
    );
    await Promise.all(pending.splice(0));
    expect(hooked).toEqual([
      'onCreate system',
      'onUpdate system',
      'afterCreate system',
      'afterUpdate system',
    ]);

    // A sign-up that fails after its first write keeps nothing: the record
    // is gone, and the after hook of its create never runs.
    hooked.length = 0;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = await signIn('idp', {
      sub: 'u-hooks-2',
      email: 'refused@example.com',
    });
    expect(errorOf(failed)).toBe('oauth2_failed');
    expect(log).toHaveBeenCalled();
    log.mockRestore();
    await Promise.all(pending.splice(0));
    expect(hooked).toEqual(['onCreate system', 'onUpdate system']);
    expect(await findUser('refused@example.com')).toBeUndefined();
  });

  it('signs the same provider account in to the same record, even after an email change there', async () => {
    const first = await whoami(
      sessionOf(await signIn('idp', { sub: 'u2', email: 'bo@example.com' })),
    );
    const again = await whoami(
      sessionOf(
        await signIn('idp', { sub: 'u2', email: 'bo.new@example.com' }),
      ),
    );
    expect(again.id).toBe(first.id);
    expect(again.email).toBe('bo@example.com');
  });

  it('signs in with GitHub through its API and primary email', async () => {
    const record = await whoami(
      sessionOf(await signIn('github', { sub: '42' })),
    );
    expect(record).toMatchObject({
      email: 'gh42@example.com',
      emailVerified: true,
    });
  });

  it("rejects a callback without this browser's state cookie, or a second time", async () => {
    const stolen = await signIn(
      'idp',
      { sub: 'u3', email: 'cy@example.com' },
      { tamper: (callback) => [callback, ''] },
    );
    expect(errorOf(stolen)).toBe('oauth2_failed');
    expect(cookieOf(stolen, 'nextbase_session')).toBeUndefined();

    let replay: [URL, string] | undefined;
    const used = await signIn(
      'idp',
      { sub: 'u3', email: 'cy@example.com' },
      {
        tamper: (callback, cookie) => {
          replay = [callback, cookie];
          return [callback, cookie];
        },
      },
    );
    sessionOf(used);
    const [callback, cookie] = replay as [URL, string];
    const again = await raw('GET', callback.href, { cookie });
    expect(errorOf(again)).toBe('oauth2_failed');
  });

  it("rejects a sign-in returning to another provider's callback", async () => {
    const response = await signIn(
      'idp',
      { sub: 'u14', email: 'max@example.com' },
      {
        tamper: (callback, cookie) => [
          new URL(`${callbackOf('github')}${callback.search}`),
          cookie,
        ],
      },
    );
    expect(errorOf(response)).toBe('oauth2_failed');
    expect(await findUser('max@example.com')).toBeUndefined();
  });

  it('rejects an ID token issued for another sign-in', async () => {
    // Logged, as any unexpected failure of a provider is.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await signIn('idp', {
      sub: 'u4',
      email: 'di@example.com',
      nonce: 'another',
    });
    expect(errorOf(response)).toBe('oauth2_failed');
    expect(await findUser('di@example.com')).toBeUndefined();
    expect(String(logged.mock.calls[0]?.[1])).toMatch(/nonce/);
    logged.mockRestore();
  });

  it('reports a sign-in the user cancelled at the provider', async () => {
    const response = await signIn(
      'idp',
      { sub: 'u5' },
      {
        query: '?redirect=/home&errorRedirect=%2Fsign-in%3Fnext%3D%2Fhome',
        tamper: (callback, cookie) => {
          const denied = new URL(callback);
          denied.searchParams.delete('code');
          denied.searchParams.set('error', 'access_denied');
          return [denied, cookie];
        },
      },
    );
    expect(response.headers.get('location')).toBe(
      `${origin}/sign-in?next=%2Fhome&error=oauth2_denied`,
    );
    expect(errorOf(response)).toBe('oauth2_denied');
  });

  it('links an existing account by email only when both sides verified it', async () => {
    const users = admin.collection('users');
    const existing = await users.create({
      email: 'eve@example.com',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    if (!existing) throw new Error('A superuser views every record.');
    // NextBase never verified the address: whoever owns the provider account
    // may not own this one.
    expect(
      errorOf(
        await signIn('idp', {
          sub: 'u6',
          email: 'EVE@example.com',
          emailVerified: true,
        }),
      ),
    ).toBe('account_exists');

    await users.update(existing.id, { emailVerified: true });
    // The provider did not verify it.
    expect(
      errorOf(
        await signIn('idp', {
          sub: 'u6',
          email: 'eve@example.com',
          emailVerified: false,
        }),
      ),
    ).toBe('email_not_verified');

    const record = await whoami(
      sessionOf(
        await signIn('idp', {
          sub: 'u6',
          email: 'eve@example.com',
          emailVerified: true,
        }),
      ),
    );
    expect(record.id).toBe(existing.id);
    await Promise.all(pending.splice(0));
    expect(sent.at(-1)).toMatchObject({
      to: 'eve@example.com',
      subject: 'A new way to sign in was added',
    });
  });

  it('links by email neither when the collection says not to, nor for an account with a second step', async () => {
    const users = admin.collection('users');
    await users.create({
      email: 'nolink@example.com',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
      emailVerified: true,
    });
    const provider = {
      sub: 'u-nolink',
      email: 'nolink@example.com',
      emailVerified: true,
    };
    const linked = async (): Promise<number> =>
      (
        await t.pool.query(
          "SELECT 1 FROM nextbase._linked_accounts WHERE provider_id = 'u-nolink'",
        )
      ).rows.length;

    await admin.collections.update('users', { implicitLinking: false });
    try {
      expect(errorOf(await signIn('idp', provider))).toBe('account_exists');
      expect(await linked()).toBe(0);
    } finally {
      await admin.collections.update('users', { implicitLinking: true });
    }

    // Whoever holds the inbox could otherwise link a provider and count it
    // as a second step alongside an email code.
    await admin.collections.update('users', {
      mfa: {
        enabled: true,
        rule: 'email = "nolink@example.com"',
        duration: 300,
      },
    });
    try {
      expect(errorOf(await signIn('idp', provider))).toBe('account_exists');
      expect(await linked()).toBe(0);
    } finally {
      await admin.collections.update('users', {
        mfa: { enabled: false, rule: null, duration: 300 },
      });
    }
    // With neither, the same sign-in links as before.
    expect(errorOf(await signIn('idp', provider))).toBeNull();
    expect(await linked()).toBe(1);
  });

  it('links and unlinks a provider for the signed-in account', async () => {
    const { token, record } = await passwordAccount('fay@example.com');
    const linked = await signIn(
      'github',
      { sub: '77' },
      {
        query: '?link=true&redirect=/settings',
        cookie: await cookieSignIn('fay@example.com'),
      },
    );
    expect(linked.headers.get('location')).toBe(`${origin}/settings`);
    // Linking keeps the current session.
    expect(cookieOf(linked, 'nextbase_session')).toBeUndefined();

    const path = `/collections/users/records/${record.id}/linked-accounts`;
    const list = await call(nextbase, 'GET', path, { token });
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([
      expect.objectContaining({ provider: 'github' }),
    ]);
    // GitHub now signs in to this account, though its email is another.
    const viaGithub = await whoami(
      sessionOf(await signIn('github', { sub: '77' })),
    );
    expect(viaGithub.id).toBe(record.id);

    // Someone else may neither see nor remove the link.
    const { token: other } = await passwordAccount('gus@example.com');
    expect((await call(nextbase, 'GET', path, { token: other })).status).toBe(
      404,
    );
    const unlink = `${path}/github`;
    expect(
      (await call(nextbase, 'DELETE', unlink, { token: other })).status,
    ).toBe(404);
    // The owner needs the password: a stolen session cannot remove it.
    expect(
      (await call(nextbase, 'DELETE', unlink, { token, body: {} })).status,
    ).toBe(400);
    expect(
      (
        await call(nextbase, 'DELETE', unlink, {
          token,
          body: { password: PASSWORD },
        })
      ).status,
    ).toBe(204);
    await Promise.all(pending.splice(0));
    expect(sent.at(-1)).toMatchObject({
      to: 'fay@example.com',
      subject: 'A way to sign in was removed',
    });
    expect(sent.at(-1)?.text).toContain('GitHub');
    expect(
      (
        await call(nextbase, 'DELETE', unlink, {
          token,
          body: { password: PASSWORD },
        })
      ).status,
    ).toBe(404);
  });

  it('refuses to link a provider account another record already has', async () => {
    await signIn('idp', { sub: 'u8', email: 'hal@example.com' });
    await passwordAccount('ivy@example.com');
    const response = await signIn(
      'idp',
      { sub: 'u8' },
      { query: '?link=true', cookie: await cookieSignIn('ivy@example.com') },
    );
    expect(errorOf(response)).toBe('already_linked');
  });

  it('links only to the account still signed in on the browser', async () => {
    await passwordAccount('joy@example.com');
    const cookie = await cookieSignIn('joy@example.com');
    const response = await signIn(
      'idp',
      { sub: 'u13' },
      {
        query: '?link=true',
        cookie,
        // Signed out between starting and finishing.
        signedOut: true,
      },
    );
    expect(errorOf(response)).toBe('oauth2_failed');
  });

  it('does not start a link for a signed-out caller, from another site, or without the password', async () => {
    const link = (
      headers: Record<string, string>,
      body: Record<string, unknown> = { password: PASSWORD },
    ) =>
      nextbase.handle(
        new Request(
          `${origin}/api/nextbase/collections/users/link-oauth2/idp`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify(body),
          },
        ),
      );
    expect((await link({ 'sec-fetch-site': 'same-origin' })).status).toBe(401);
    expect((await link({ 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    // A stolen session, without the password, cannot add a way in.
    await passwordAccount('kit@example.com');
    const cookie = await cookieSignIn('kit@example.com');
    const noPassword = await link(
      { cookie, 'sec-fetch-site': 'same-origin' },
      {},
    );
    expect(noPassword.status).toBe(400);
    const wrong = await link(
      { cookie, 'sec-fetch-site': 'same-origin' },
      { password: 'not the password!' },
    );
    expect(wrong.status).toBe(400);
    // A link is never started by a URL.
    const byUrl = await raw(
      'GET',
      '/collections/users/auth-with-oauth2/idp?link=true',
      { 'sec-fetch-site': 'same-origin' },
    );
    expect(byUrl.status).toBe(400);
  });

  it('only returns to paths on the app', async () => {
    for (const redirect of [
      '//evil.example',
      'https://evil.example/',
      '/\\evil.example',
      'evil',
    ]) {
      const response = await raw(
        'GET',
        `/collections/users/auth-with-oauth2/idp?redirect=${encodeURIComponent(redirect)}`,
      );
      expect(response.status).toBe(400);
    }
  });

  it('lets an account created through a provider set a password by resetting it', async () => {
    const created = await whoami(
      sessionOf(
        await signIn('idp', {
          sub: 'u15',
          email: 'ned@example.com',
          emailVerified: true,
        }),
      ),
    );
    const users = nextbase.client().collection('users');
    await users.requestPasswordReset('ned@example.com');
    await Promise.all(pending.splice(0));
    const message = sent.filter((m) => m.to === 'ned@example.com').at(-1);
    const token = /token=([\w.-]+)/.exec(message?.text ?? '')?.[1] ?? '';
    await users.confirmPasswordReset(token, PASSWORD, PASSWORD);
    const { record } = await users.signInWithPassword(
      'ned@example.com',
      PASSWORD,
    );
    expect(record.id).toBe(created.id);
  });

  it("lets a deleted account's provider account sign up again", async () => {
    const first = await whoami(
      sessionOf(await signIn('idp', { sub: 'u9', email: 'jo@example.com' })),
    );
    await admin.collection('users').delete(first.id as string);
    const again = await whoami(
      sessionOf(await signIn('idp', { sub: 'u9', email: 'jo@example.com' })),
    );
    expect(again.id).not.toBe(first.id);
  });

  it('follows the create rule and the auth rule', async () => {
    await admin.collections.update('users', { createRule: null });
    expect(
      errorOf(await signIn('idp', { sub: 'u10', email: 'kim@example.com' })),
    ).toBe('sign_up_disabled');
    await admin.collections.update('users', {
      createRule: '',
      authRule: 'email != "lee@example.com"',
    });
    expect(
      errorOf(await signIn('idp', { sub: 'u11', email: 'lee@example.com' })),
    ).toBe('sign_in_forbidden');
    await admin.collections.update('users', { authRule: '' });
  });

  it('needs a provider that shares an email to sign up', async () => {
    expect(errorOf(await signIn('idp', { sub: 'u12' }))).toBe('email_required');
  });

  it('creates no account from an email the provider did not verify', async () => {
    // Otherwise someone could claim your email at a provider that does not
    // check it, and hold the account before you sign up.
    const response = await signIn('idp', {
      sub: 'u16',
      email: 'pam@example.com',
      emailVerified: false,
    });
    expect(errorOf(response)).toBe('email_not_verified');
    expect(cookieOf(response, 'nextbase_session')).toBeUndefined();
    expect(await findUser('pam@example.com')).toBeUndefined();
  });

  it('links no provider to an account whose email nobody verified', async () => {
    // Someone signed up with your email: they must not add a way in that
    // survives you resetting the password.
    const { record } = await passwordAccount('quin@example.com', false);
    const response = await signIn(
      'idp',
      { sub: 'u17', email: 'attacker@example.com' },
      { query: '?link=true', cookie: await cookieSignIn('quin@example.com') },
    );
    expect(errorOf(response)).toBe('email_not_verified');
    const path = `/collections/users/records/${record.id}/linked-accounts`;
    const { token } = await nextbase
      .client()
      .collection('users')
      .signInWithPassword('quin@example.com', PASSWORD);
    expect((await call(nextbase, 'GET', path, { token })).body.items).toEqual(
      [],
    );
  });

  it('drops the providers linked before the owner first proved the email', async () => {
    const users = nextbase.client().collection('users');
    const tokenTo = async (email: string): Promise<string> => {
      await Promise.all(pending.splice(0));
      const message = sent.filter((m) => m.to === email).at(-1);
      return /token=([\w.-]+)/.exec(message?.text ?? '')?.[1] ?? '';
    };
    /**
     * An account someone set up under another's email, with their provider
     * linked, as linking allowed before it needed a verified email.
     */
    const preHijacked = async (email: string, sub: string) => {
      const { record } = await passwordAccount(email);
      const linked = await signIn(
        'idp',
        { sub },
        { query: '?link=true', cookie: await cookieSignIn(email) },
      );
      expect(errorOf(linked)).toBeNull();
      await admin.collection('users').update(record.id, {
        emailVerified: false,
      });
      return record.id;
    };
    const linkedTo = async (id: string): Promise<unknown[]> =>
      (
        await t.db
          .newQuery(
            'SELECT id FROM nextbase._linked_accounts WHERE record_id = {:id}',
          )
          .bind({ id })
          .all()
      ).map((row) => row.id);

    // The owner resets the password.
    const reset = await preHijacked('rae@example.com', 'u18');
    await users.requestPasswordReset('rae@example.com');
    await users.confirmPasswordReset(
      await tokenTo('rae@example.com'),
      "the owner's password",
      "the owner's password",
    );
    expect(await linkedTo(reset)).toEqual([]);
    // The provider account no longer signs in to it, and cannot sign up
    // without an email.
    expect(errorOf(await signIn('idp', { sub: 'u18' }))).toBe('email_required');

    // The owner verifies the email.
    const verified = await preHijacked('sol@example.com', 'u19');
    await users.requestEmailVerification('sol@example.com');
    await users.confirmEmailVerification(await tokenTo('sol@example.com'));
    expect(await linkedTo(verified)).toEqual([]);

    // Once the email is proven, a reset keeps the owner's own providers.
    const { record } = await passwordAccount('tia@example.com');
    await signIn(
      'idp',
      { sub: 'u20', email: 'tia@example.com' },
      { query: '?link=true', cookie: await cookieSignIn('tia@example.com') },
    );
    await users.requestPasswordReset('tia@example.com');
    await users.confirmPasswordReset(
      await tokenTo('tia@example.com'),
      "tia's new password",
      "tia's new password",
    );
    expect(await linkedTo(record.id)).toHaveLength(1);
  });

  it('is not offered to superusers or for unknown providers', async () => {
    expect(
      (await raw('GET', '/collections/_superusers/auth-with-oauth2/idp'))
        .status,
    ).toBe(400);
    expect(
      (await raw('GET', '/collections/users/auth-with-oauth2/nope')).status,
    ).toBe(404);
  });

  it('needs the app URL to build redirects', () => {
    expect(
      () =>
        new NextBase({
          oauth2: { google: { clientId: 'a', clientSecret: 'b' } },
        }),
    ).toThrow(/appUrl/);
    expect(
      () =>
        new NextBase({
          appUrl: origin,
          oauth2: { custom: { clientId: 'a', clientSecret: 'b' } },
        }),
    ).toThrow(/issuer/);
  });
});
