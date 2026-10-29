import { randomBytes, scryptSync } from 'node:crypto';
import { DB, hash } from '@nextbasejs/dbx';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findSession } from '../src/auth/sessions.ts';
import { table } from '../src/db/system.ts';
import { TYPES } from '../src/db/types.ts';
import { type CookieStore, hasSessionCookie, NextBase } from '../src/index.ts';
import { SchemaCache } from '../src/schema/cache.ts';
import { call, origin } from './http.ts';
import { createTestDatabase, type TestDatabase } from './postgres.ts';

const WEEK = 7 * 86_400;

describe('sessions', () => {
  let t: TestDatabase;
  let nextbase: NextBase;
  let admin = '';

  /** A raw request, for headers `call` does not set: cookies and origins. */
  const raw = (
    method: string,
    path: string,
    {
      headers = {},
      body,
    }: { headers?: Record<string, string>; body?: unknown } = {},
  ): Promise<Response> =>
    nextbase.handle(
      new Request(`${origin}/api/nextbase${path}`, {
        method,
        headers: {
          ...headers,
          ...(body !== undefined && { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );

  const login = async (
    email: string,
    password = 'password 123 456',
  ): Promise<string> => {
    const reply = await call(
      nextbase,
      'POST',
      '/collections/users/auth-with-password',
      {
        body: { identity: email, password },
      },
    );
    expect(reply.status).toBe(200);
    return reply.body.token as string;
  };

  /** Signs in with a cookie and returns its value. */
  const cookieLogin = async (email: string): Promise<string> => {
    const response = await raw(
      'POST',
      '/collections/users/auth-with-password',
      {
        headers: { origin },
        body: { identity: email, password: 'password 123 456', cookie: true },
      },
    );
    expect(response.status).toBe(200);
    return (
      /nextbase_session=([^;]*)/.exec(
        response.headers.get('set-cookie') ?? '',
      )?.[1] ?? ''
    );
  };

  const signUp = async (email: string): Promise<string> => {
    const reply = await call(nextbase, 'POST', '/collections/users/records', {
      token: admin,
      body: {
        email,
        password: 'password 123 456',
        passwordConfirm: 'password 123 456',
        name: email,
      },
    });
    expect(reply.body).toMatchObject({ email });
    return reply.body.id as string;
  };

  const status = async (token: string): Promise<number> =>
    (await call(nextbase, 'GET', '/session', { token })).status;

  beforeAll(async () => {
    t = await createTestDatabase();
    // Tests sign in to and refresh the same accounts many times a second,
    // past the default `*:auth` limit; rate limits have their own tests.
    nextbase = new NextBase({ database: t.pool, rateLimits: false });
    await nextbase.createSuperuser('admin@example.com', 'admin password!');
    admin = (
      await call(
        nextbase,
        'POST',
        '/collections/_superusers/auth-with-password',
        {
          body: { identity: 'admin@example.com', password: 'admin password!' },
        },
      )
    ).body.token as string;
    const users = await call(nextbase, 'POST', '/collections', {
      token: admin,
      body: {
        name: 'users',
        type: 'auth',
        createRule: '',
        viewRule: 'id = @request.auth.id',
        updateRule: 'id = @request.auth.id',
        fields: [{ name: 'name', type: 'text' }],
      },
    });
    expect(users.status).toBe(200);
  });
  afterAll(async () => {
    // Log entries still waiting would be written to an ended pool.
    await nextbase.flush();
    await t.close();
  });

  it('logs out for real: the token stops working', async () => {
    const id = await signUp('ann@example.com');
    const token = await login('ann@example.com');
    const session = await call(nextbase, 'GET', '/session', { token });
    expect(session.body).toMatchObject({
      current: true,
      userAgent: '',
      record: { id, email: 'ann@example.com' },
    });
    expect(
      Date.parse(session.body.expires as string) - Date.now(),
    ).toBeGreaterThan((WEEK - 60) * 1000);
    expect((await call(nextbase, 'DELETE', '/session', { token })).status).toBe(
      204,
    );
    expect(await status(token)).toBe(401);
    // Anonymous: no session, and logging out again is harmless.
    expect((await call(nextbase, 'GET', '/session')).body).toBeNull();
    expect((await call(nextbase, 'DELETE', '/session')).status).toBe(204);
  });

  it('keeps a cookie session out of the response body and readable by the server', async () => {
    await signUp('bea@example.com');
    const response = await raw(
      'POST',
      '/collections/users/auth-with-password',
      {
        headers: { origin, 'user-agent': 'Firefox' },
        body: {
          identity: 'bea@example.com',
          password: 'password 123 456',
          cookie: true,
        },
      },
    );
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.token).toBeUndefined();
    expect(body.record).toMatchObject({ email: 'bea@example.com' });
    const header = response.headers.get('set-cookie') ?? '';
    expect(header).toMatch(
      /^nextbase_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax$/,
    );
    expect(Number(/Max-Age=(\d+)/.exec(header)?.[1])).toBeGreaterThan(
      WEEK - 60,
    );

    const cookie = header.split(';')[0] as string;
    const session = await raw('GET', '/session', { headers: { cookie } });
    expect(await session.json()).toMatchObject({
      userAgent: 'Firefox',
      record: { email: 'bea@example.com' },
    });
    // Other cookies on the same header do not get in the way.
    const mixed = await raw('GET', '/session', {
      headers: { cookie: `theme=dark; ${cookie}; other=1` },
    });
    expect(await mixed.json()).toMatchObject({
      record: { email: 'bea@example.com' },
    });
  });

  it('rejects cross-site writes through the cookie', async () => {
    const id = await signUp('cal@example.com');
    const cookie = `nextbase_session=${await cookieLogin('cal@example.com')}`;
    const path = `/collections/users/records/${id}`;
    const patch = (headers: Record<string, string>) =>
      raw('PATCH', path, {
        headers: { cookie, ...headers },
        body: { name: 'x' },
      });

    expect((await patch({})).status).toBe(403);
    expect((await patch({ origin: 'https://evil.example' })).status).toBe(403);
    expect((await patch({ origin: 'null' })).status).toBe(403);
    expect((await patch({ origin })).status).toBe(200);
    // X-Forwarded-Host is ignored unless a trusted proxy sets it (trustProxy).
    expect(
      (
        await patch({
          origin: 'https://app.example',
          'x-forwarded-host': 'app.example',
        })
      ).status,
    ).toBe(403);
    // Reads are fine: SameSite keeps cross-site fetches from carrying the cookie.
    expect((await raw('GET', path, { headers: { cookie } })).status).toBe(200);

    // Nor may another site sign the browser in to an account it chooses.
    const forced = await raw('POST', '/collections/users/auth-with-password', {
      headers: { origin: 'https://evil.example' },
      body: {
        identity: 'cal@example.com',
        password: 'password 123 456',
        cookie: true,
      },
    });
    expect(forced.status).toBe(403);
    expect(forced.headers.get('set-cookie')).toBeNull();
  });

  it("trusts a proxy's host and other origins only when configured", async () => {
    const id = await signUp('ray@example.com');
    const cookie = `nextbase_session=${await cookieLogin('ray@example.com')}`;
    const patchVia = (instance: NextBase, headers: Record<string, string>) =>
      instance.handle(
        new Request(`${origin}/api/nextbase/collections/users/records/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', cookie, ...headers },
          body: JSON.stringify({ name: 'x' }),
        }),
      );
    const proxied = new NextBase({ database: t.pool, trustProxy: true });
    expect(
      (
        await patchVia(proxied, {
          origin: 'https://app.example',
          'x-forwarded-host': 'app.example',
        })
      ).status,
    ).toBe(200);

    const trusting = new NextBase({
      database: t.pool,
      trustedOrigins: ['app.example.com', '*.preview.example.com'],
    });
    const from = async (originHeader: string, site?: string) =>
      (
        await patchVia(trusting, {
          origin: originHeader,
          ...(site && { 'sec-fetch-site': site }),
        })
      ).status;
    expect(await from('https://app.example.com', 'same-site')).toBe(200);
    expect(await from('https://APP.example.com')).toBe(200);
    expect(await from('https://pr-1.preview.example.com', 'cross-site')).toBe(
      200,
    );
    // One label for *, and never the bare domain or deeper subdomains.
    expect(await from('https://preview.example.com', 'same-site')).toBe(403);
    expect(await from('https://a.b.preview.example.com', 'same-site')).toBe(
      403,
    );
    expect(await from('https://evil.example', 'cross-site')).toBe(403);
    expect(await from('https://app.example.com.evil.example')).toBe(403);
  });

  it('drops an invalid cookie and continues anonymously', async () => {
    const response = await raw('GET', '/session', {
      headers: { cookie: 'nextbase_session=revoked-or-made-up' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
    expect(response.headers.get('set-cookie')).toMatch(
      /^nextbase_session=; Path=\/; Max-Age=0;/,
    );
    // A Bearer token is different: a client sent it on purpose.
    expect(await status('revoked-or-made-up')).toBe(401);
    expect(
      (
        await raw('GET', '/session', {
          headers: { authorization: 'Token abc' },
        })
      ).status,
    ).toBe(401);
  });

  it("lists and revokes a record's sessions, but never another record's", async () => {
    await signUp('dee@example.com');
    const laptop = await login('dee@example.com');
    const phone = await login('dee@example.com');
    const sessions = await call(nextbase, 'GET', '/sessions', {
      token: laptop,
    });
    const items = sessions.body.items as { id: string; current: boolean }[];
    expect(items).toHaveLength(2);
    const current = items.find((s) => s.current);
    const other = items.find((s) => !s.current);
    expect(current && other).toBeTruthy();

    expect(
      (
        await call(nextbase, 'DELETE', `/sessions/${other?.id}`, {
          token: laptop,
        })
      ).status,
    ).toBe(204);
    expect(await status(phone)).toBe(401);
    expect(await status(laptop)).toBe(200);
    expect(
      (
        await call(nextbase, 'DELETE', `/sessions/${other?.id}`, {
          token: laptop,
        })
      ).status,
    ).toBe(404);

    await signUp('eve@example.com');
    const eve = await login('eve@example.com');
    expect(
      (
        await call(nextbase, 'DELETE', `/sessions/${current?.id}`, {
          token: eve,
        })
      ).status,
    ).toBe(404);
    expect(await status(laptop)).toBe(200);
    expect((await call(nextbase, 'GET', '/sessions')).status).toBe(401);
  });

  it('extends sessions in use and renews their cookie', async () => {
    await signUp('fay@example.com');
    const token = await cookieLogin('fay@example.com');
    const bearer = await login('fay@example.com');
    await t.db
      .newQuery(
        "UPDATE nextbase._sessions SET expires = now() + interval '1 hour' WHERE collection_id <> '_superusers'",
      )
      .execute();

    const response = await raw('GET', '/session', {
      headers: { cookie: `nextbase_session=${token}` },
    });
    const renewed = response.headers.get('set-cookie') ?? '';
    expect(renewed).toContain(`nextbase_session=${token};`);
    expect(Number(/Max-Age=(\d+)/.exec(renewed)?.[1])).toBeGreaterThan(
      WEEK - 60,
    );

    expect(await status(bearer)).toBe(200);
    const left = await t.db
      .newQuery(
        "SELECT extract(epoch FROM min(expires) - now()) FROM nextbase._sessions WHERE record_id = (SELECT id FROM nextbase.users WHERE email = 'fay@example.com')",
      )
      .column<number>();
    expect(Number(left[0])).toBeGreaterThan(WEEK - 60);

    // A fresh session is not written to on every request.
    const again = await raw('GET', '/session', {
      headers: { cookie: `nextbase_session=${token}` },
    });
    expect(again.headers.get('set-cookie')).toBeNull();

    await t.db
      .newQuery(
        "UPDATE nextbase._sessions SET expires = now() - interval '1 second' WHERE collection_id <> '_superusers'",
      )
      .execute();
    expect(await status(bearer)).toBe(401);
  });

  it("refreshes without revealing a cookie session's token", async () => {
    await signUp('gus@example.com');
    const token = await cookieLogin('gus@example.com');
    const viaCookie = await raw('POST', '/collections/users/auth-refresh', {
      headers: { cookie: `nextbase_session=${token}`, origin },
    });
    expect(viaCookie.status).toBe(200);
    const body = (await viaCookie.json()) as Record<string, unknown>;
    expect(body.token).toBeUndefined();
    expect(body.record).toMatchObject({ email: 'gus@example.com' });
    expect(viaCookie.headers.get('set-cookie')).toContain(
      `nextbase_session=${token};`,
    );

    const bearer = await login('gus@example.com');
    const viaBearer = await call(
      nextbase,
      'POST',
      '/collections/users/auth-refresh',
      {
        token: bearer,
      },
    );
    expect(viaBearer.body.token).toBe(bearer);
    expect(
      (
        await call(nextbase, 'POST', '/collections/_superusers/auth-refresh', {
          token: bearer,
        })
      ).status,
      // Signed in, to another collection: refused, but the session stands.
    ).toBe(403);
  });

  it('revokes sessions on email changes, secret rotation and record reuse', async () => {
    const id = await signUp('hal@example.com');
    const before = await login('hal@example.com');
    // A superuser changing the email signs the record out everywhere.
    expect(
      (
        await call(nextbase, 'PATCH', `/collections/users/records/${id}`, {
          token: admin,
          body: { email: 'hal2@example.com' },
        })
      ).status,
    ).toBe(200);
    expect(await status(before)).toBe(401);

    // Rotating the collection's auth secret signs out all of its records.
    const token = await login('hal2@example.com');
    const users = await call(nextbase, 'GET', '/collections/users', {
      token: admin,
    });
    const tokens = users.body.tokens as Record<
      string,
      { secret: string; duration: number }
    >;
    expect(
      (
        await call(nextbase, 'PATCH', '/collections/users', {
          token: admin,
          body: {
            tokens: {
              ...tokens,
              auth: { ...tokens.auth, secret: 's'.repeat(50) },
            },
          },
        })
      ).status,
    ).toBe(200);
    expect(await status(token)).toBe(401);

    // A deleted record's session does not pass to a new record with its id.
    const stale = await login('hal2@example.com');
    expect(
      (
        await call(nextbase, 'DELETE', `/collections/users/records/${id}`, {
          token: admin,
        })
      ).status,
    ).toBe(204);
    await call(nextbase, 'POST', '/collections/users/records', {
      token: admin,
      body: {
        id,
        email: 'new@example.com',
        password: 'password 123 456',
        passwordConfirm: 'password 123 456',
      },
    });
    expect(await status(stale)).toBe(401);
  });

  it('ends a session 30 days after sign-in, however active', async () => {
    await signUp('kim@example.com');
    const token = await login('kim@example.com');
    await t.db
      .newQuery(
        "UPDATE nextbase._sessions SET created = now() - interval '29 days 22 hours', expires = now() + interval '1 hour' WHERE collection_id <> '_superusers'",
      )
      .execute();
    expect(await status(token)).toBe(200);
    const [hours] = await t.db
      .newQuery(
        "SELECT extract(epoch FROM max(expires) - now()) / 3600 FROM nextbase._sessions WHERE collection_id <> '_superusers'",
      )
      .column<number>();
    // Extended to the 30-day mark, not by another week.
    expect(Number(hours)).toBeLessThan(2.1);
    const refreshed = await call(
      nextbase,
      'POST',
      '/collections/users/auth-refresh',
      { token },
    );
    expect(refreshed.status).toBe(200);
    await t.db
      .newQuery(
        "UPDATE nextbase._sessions SET created = now() - interval '30 days 1 second' WHERE collection_id <> '_superusers'",
      )
      .execute();
    await t.db
      .newQuery(
        "UPDATE nextbase._sessions SET expires = created + interval '30 days' WHERE collection_id <> '_superusers'",
      )
      .execute();
    expect(await status(token)).toBe(401);
  });

  it('uses a __Host- prefixed cookie over HTTPS, and only that one', async () => {
    await signUp('lee@example.com');
    const https = (path: string, init: RequestInit = {}) =>
      nextbase.handle(
        new Request(`https://app.example/api/nextbase${path}`, init),
      );
    const response = await https('/collections/users/auth-with-password', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://app.example',
      },
      body: JSON.stringify({
        identity: 'lee@example.com',
        password: 'password 123 456',
        cookie: true,
      }),
    });
    const header = response.headers.get('set-cookie') ?? '';
    expect(header).toMatch(
      /^__Host-nextbase_session=[\w-]{43}; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax; Secure$/,
    );
    const token = /=([^;]*)/.exec(header)?.[1] as string;
    const read = (cookie: string) =>
      https('/session', { headers: { cookie } }).then((r) => r.json());
    expect(await read(`__Host-nextbase_session=${token}`)).toMatchObject({
      record: { email: 'lee@example.com' },
    });
    // The unprefixed name, which a sibling subdomain could set, is ignored.
    expect(await read(`nextbase_session=${token}`)).toBeNull();
  });

  it('checks Sec-Fetch-Site before Origin on cookie writes', async () => {
    const id = await signUp('max@example.com');
    const cookie = `nextbase_session=${await cookieLogin('max@example.com')}`;
    const patch = (headers: Record<string, string>) =>
      raw('PATCH', `/collections/users/records/${id}`, {
        headers: { cookie, ...headers },
        body: { name: 'x' },
      });
    expect((await patch({ 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    // Even with a matching Origin, the browser says it came from elsewhere.
    for (const site of ['cross-site', 'same-site']) {
      expect((await patch({ 'sec-fetch-site': site, origin })).status).toBe(
        403,
      );
    }
  });

  it('ends the session a cookie sign-in replaces', async () => {
    await signUp('ned@example.com');
    const first = await cookieLogin('ned@example.com');
    const again = await raw('POST', '/collections/users/auth-with-password', {
      headers: { origin, cookie: `nextbase_session=${first}` },
      body: {
        identity: 'ned@example.com',
        password: 'password 123 456',
        cookie: true,
      },
    });
    expect(again.status).toBe(200);
    expect(await status(first)).toBe(401);
  });

  it('counts parallel guesses before checking them', async () => {
    await signUp('oz@example.com');
    const replies = await Promise.all(
      Array.from({ length: 25 }, () =>
        raw('POST', '/collections/users/auth-with-password', {
          body: { identity: 'oz@example.com', password: 'wrong guess here' },
        }),
      ),
    );
    const statuses = replies.map((r) => r.status);
    expect(statuses.filter((s) => s === 400).length).toBeLessThanOrEqual(10);
    const limited = replies.find((r) => r.status === 429);
    expect(Number(limited?.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('refuses and counts an identity of any length like any other', async () => {
    // Longer than a Postgres index entry can be, even compressed.
    const identity = `${randomBytes(4096).toString('hex')}@example.com`;
    const attempt = () =>
      raw('POST', '/collections/users/auth-with-password', {
        body: { identity, password: 'wrong guess here' },
      });
    for (let i = 0; i < 10; i++) expect((await attempt()).status).toBe(400);
    expect((await attempt()).status).toBe(429);
  });

  it('throttles oldPassword per account, counting only callers the update rule allows', async () => {
    const victim = await signUp('pat@example.com');
    await signUp('quinn@example.com');
    const attacker = await login('quinn@example.com');
    const change = (token: string, oldPassword: string) =>
      call(nextbase, 'PATCH', `/collections/users/records/${victim}`, {
        token,
        body: {
          oldPassword,
          password: 'brand new password',
          passwordConfirm: 'brand new password',
        },
      });
    // Someone the rule rejects gets 404s and counts nothing.
    for (let i = 0; i < 12; i++) {
      expect((await change(attacker, 'guess guess guess')).status).toBe(404);
    }
    const owner = await login('pat@example.com');
    for (let i = 0; i < 10; i++) {
      const reply = await change(owner, 'not my password!');
      expect(reply.status).toBe(400);
      expect(reply.body.data).toMatchObject({
        oldPassword: { code: 'validation_invalid_old_password' },
      });
    }
    expect((await change(owner, 'not my password!')).status).toBe(429);
    // One count per account: logins are limited too.
    const loginReply = await call(
      nextbase,
      'POST',
      '/collections/users/auth-with-password',
      { body: { identity: 'pat@example.com', password: 'password 123 456' } },
    );
    expect(loginReply.status).toBe(429);
  });

  it("checks a request's session for proxy.ts, without extending it", async () => {
    await signUp('sam@example.com');
    const token = await cookieLogin('sam@example.com');
    const page = (headers: Record<string, string> = {}) =>
      new Request(`${origin}/dashboard`, { headers });

    expect(await nextbase.getSession(page())).toBeNull();
    expect(hasSessionCookie(page())).toBe(false);

    const withCookie = page({
      cookie: `theme=dark; nextbase_session=${token}`,
    });
    expect(hasSessionCookie(withCookie)).toBe(true);
    await t.db
      .newQuery(
        "UPDATE nextbase._sessions SET expires = now() + interval '1 hour' WHERE collection_id <> '_superusers'",
      )
      .execute();
    expect((await nextbase.getSession(withCookie))?.record).toMatchObject({
      email: 'sam@example.com',
    });
    const [hours] = await t.db
      .newQuery(
        "SELECT extract(epoch FROM max(expires) - now()) / 3600 FROM nextbase._sessions WHERE collection_id <> '_superusers'",
      )
      .column<number>();
    expect(Number(hours)).toBeLessThan(1.1);

    // A Bearer token works too; a revoked or made-up one is no session.
    const bearer = await login('sam@example.com');
    expect(
      (await nextbase.getSession(page({ authorization: `Bearer ${bearer}` })))
        ?.record,
    ).toMatchObject({ email: 'sam@example.com' });
    expect(
      await nextbase.getSession(page({ cookie: 'nextbase_session=made-up' })),
    ).toBeNull();
    // The cookie check is only a presence check.
    expect(hasSessionCookie(page({ cookie: 'nextbase_session=made-up' }))).toBe(
      true,
    );
  });

  it('signs out every other device, keeping this one', async () => {
    await signUp('oli@example.com');
    const here = await login('oli@example.com');
    const others = [
      await login('oli@example.com'),
      await login('oli@example.com'),
    ];
    expect(
      (await call(nextbase, 'DELETE', '/sessions', { token: here })).status,
    ).toBe(204);
    expect(await status(here)).toBe(200);
    for (const token of others) expect(await status(token)).toBe(401);
    expect((await call(nextbase, 'DELETE', '/sessions')).status).toBe(401);
  });

  it("deletes a deleted account's sessions with it", async () => {
    const id = await signUp('pam@example.com');
    await login('pam@example.com');
    const sessions = async (): Promise<number> =>
      (
        await t.pool.query(
          'SELECT count(*)::int AS n FROM nextbase._sessions WHERE record_id = $1',
          [id],
        )
      ).rows[0].n;
    expect(await sessions()).toBe(1);
    const deleted = await call(
      nextbase,
      'DELETE',
      `/collections/users/records/${id}`,
      {
        token: admin,
      },
    );
    expect(deleted.status).toBe(204);
    expect(await sessions()).toBe(0);
  });

  it('upgrades a password hash with older parameters on sign-in', async () => {
    const id = await signUp('quin@example.com');
    const salt = randomBytes(16);
    const key = scryptSync('password 123 456', salt, 32, {
      N: 2 ** 13,
      r: 8,
      p: 1,
    });
    const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');
    await t.pool.query(
      'UPDATE nextbase.users SET password = $1 WHERE id = $2',
      [`$scrypt$ln=13,r=8,p=1$${b64(salt)}$${b64(key)}`, id],
    );
    await login('quin@example.com');
    const { rows } = await t.pool.query(
      'SELECT password FROM nextbase.users WHERE id = $1',
      [id],
    );
    expect(rows[0].password).toMatch(/^\$scrypt\$ln=14,r=8,p=5\$/);
    // And the new hash still signs in.
    await login('quin@example.com');
  });

  describe('server-side client with Next.js cookies', () => {
    class Cookies implements CookieStore {
      readonly values = new Map<
        string,
        { value: string; maxAge: number; httpOnly: boolean }
      >();
      get(name: string) {
        const cookie = this.values.get(name);
        return cookie && cookie.maxAge > 0 ? cookie : undefined;
      }
      set(
        name: string,
        value: string,
        options: { maxAge: number; httpOnly: boolean },
      ) {
        this.values.set(name, { value, ...options });
      }
    }

    it('signs in and out from a server action and reads the session in a server component', async () => {
      await signUp('ida@example.com');
      const cookies = new Cookies();
      const action = nextbase.client({ cookies });
      const { token } = await action
        .collection('users')
        .signInWithPassword('ida@example.com', 'password 123 456', {
          cookie: true,
        });
      expect(token).toBeUndefined();
      const stored = cookies.values.get('nextbase_session');
      expect(stored).toMatchObject({ httpOnly: true });
      expect(stored?.maxAge).toBeGreaterThan(WEEK - 60);

      // A server component: its cookie store is read-only.
      const readOnly = { get: (name: string) => cookies.get(name) };
      const page = nextbase.client({ cookies: readOnly });
      expect((await page.getSession())?.record).toMatchObject({
        email: 'ida@example.com',
      });
      expect(page.authStore.record?.email).toBe('ida@example.com');
      // Rules apply as that user: it can read itself.
      const id = page.authStore.record?.id as string;
      expect((await page.collection('users').getOne(id)).email).toBe(
        'ida@example.com',
      );

      await nextbase.client({ cookies }).signOut();
      expect(cookies.values.get('nextbase_session')?.maxAge).toBe(0);
      expect(await nextbase.client({ cookies }).getSession()).toBeNull();
      expect(await status(stored?.value as string)).toBe(401);
    });

    it('uses the secure cookie for pages served over HTTPS, as with next dev --experimental-https', async () => {
      await signUp('kay@example.com');
      const cookies = new Cookies();
      // A server action on an HTTPS page signs in.
      await nextbase
        .client({ cookies, secure: true })
        .collection('users')
        .signInWithPassword('kay@example.com', 'password 123 456', {
          cookie: true,
        });
      expect(cookies.values.has('nextbase_session')).toBe(false);
      const stored = cookies.values.get('__Host-nextbase_session');
      expect(stored?.httpOnly).toBe(true);
      // The browser sends it with its requests over HTTPS.
      const session = await nextbase.handle(
        new Request('https://localhost:3000/api/nextbase/session', {
          headers: { cookie: `__Host-nextbase_session=${stored?.value}` },
        }),
      );
      const body = (await session.json()) as { record: unknown };
      expect(body.record).toMatchObject({ email: 'kay@example.com' });
      // A server component finds it, also without being told the scheme.
      const readOnly = { get: (name: string) => cookies.get(name) };
      expect(
        (await nextbase.client({ cookies: readOnly }).getSession())?.record,
      ).toMatchObject({ email: 'kay@example.com' });
    });

    it('signs up into the session cookie from a server action', async () => {
      const cookies = new Cookies();
      const { token } = (await nextbase
        .client({ cookies })
        .collection('users')
        .signUp(
          {
            email: 'zed@example.com',
            password: 'password 123 456',
            passwordConfirm: 'password 123 456',
          },
          { cookie: true },
        )) ?? { token: 'missing' };
      expect(token).toBeUndefined();
      expect(cookies.values.get('nextbase_session')?.httpOnly).toBe(true);
      expect(
        (await nextbase.client({ cookies }).getSession())?.record,
      ).toMatchObject({ email: 'zed@example.com' });
    });

    it('renews the cookie from server actions, never from server components', async () => {
      await signUp('lu@example.com');
      const cookies = new Cookies();
      await nextbase
        .client({ cookies })
        .collection('users')
        .signInWithPassword('lu@example.com', 'password 123 456', {
          cookie: true,
        });
      const token = cookies.values.get('nextbase_session')?.value;
      const expiresIn = async (): Promise<number> => {
        const [seconds] = await t.db
          .newQuery(
            "SELECT extract(epoch FROM expires - now()) FROM nextbase._sessions s JOIN nextbase.users u ON u.id = s.record_id WHERE u.email = 'lu@example.com'",
          )
          .column<number>();
        return Number(seconds);
      };
      await t.db
        .newQuery(
          "UPDATE nextbase._sessions SET expires = now() + interval '1 hour' WHERE collection_id <> '_superusers'",
        )
        .execute();
      cookies.values.set('nextbase_session', {
        value: token as string,
        maxAge: 3600,
        httpOnly: true,
      });

      // Server components throw on cookie writes, so the session is left
      // as it is: extending it would outlive the cookie the browser keeps.
      const page: CookieStore = {
        get: (name) => cookies.get(name),
        set: () => {
          throw new Error(
            'Cookies can only be modified in a Server Action or Route Handler.',
          );
        },
      };
      expect(
        (await nextbase.client({ cookies: page }).getSession())?.record,
      ).toMatchObject({ email: 'lu@example.com' });
      expect(await expiresIn()).toBeLessThan(3700);

      // A server action or route handler renews both.
      expect(
        (await nextbase.client({ cookies }).getSession())?.record,
      ).toMatchObject({ email: 'lu@example.com' });
      expect(cookies.values.get('nextbase_session')).toMatchObject({
        value: token,
        httpOnly: true,
      });
      expect(cookies.values.get('nextbase_session')?.maxAge).toBeGreaterThan(
        WEEK - 60,
      );
      expect(await expiresIn()).toBeGreaterThan(WEEK - 60);

      // Server components also leave a cookie whose session ended, and
      // server actions remove it.
      await t.db
        .newQuery(
          "UPDATE nextbase._sessions SET expires = now() - interval '1 second' WHERE collection_id <> '_superusers'",
        )
        .execute();
      expect(await nextbase.client({ cookies: page }).getSession()).toBeNull();
      expect(cookies.values.get('nextbase_session')?.maxAge).toBeGreaterThan(0);
      expect(await nextbase.client({ cookies }).getSession()).toBeNull();
      expect(cookies.values.get('nextbase_session')?.maxAge).toBe(0);
    });

    it('never extends sessions from in-process reads, which cannot renew the cookie', async () => {
      await signUp('jo@example.com');
      const cookies = new Cookies();
      await nextbase
        .client({ cookies })
        .collection('users')
        .signInWithPassword('jo@example.com', 'password 123 456', {
          cookie: true,
        });
      await t.db
        .newQuery(
          "UPDATE nextbase._sessions SET expires = now() + interval '1 hour' WHERE collection_id <> '_superusers'",
        )
        .execute();
      // A server component: Next.js forbids setting cookies there.
      const readOnly: CookieStore = {
        get: (name) => cookies.get(name),
        set: () => {
          throw new Error(
            'Cookies can only be modified in a Server Action or Route Handler.',
          );
        },
      };
      expect(
        (await nextbase.client({ cookies: readOnly }).getSession())?.record,
      ).toMatchObject({ email: 'jo@example.com' });
      const [hours] = await t.db
        .newQuery(
          "SELECT extract(epoch FROM max(expires) - now()) / 3600 FROM nextbase._sessions WHERE collection_id <> '_superusers'",
        )
        .column<number>();
      expect(Number(hours)).toBeLessThan(1.1);
    });
  });

  describe('session checks', () => {
    /** A second NextBase, like another server process, that counts the queries it sends. */
    const counted = (): { nextbase: NextBase; queries: () => number } => {
      let count = 0;
      const pool = new Proxy(t.pool, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (typeof value !== 'function') return value;
          if (prop !== 'query') return value.bind(target);
          return (...args: unknown[]) => {
            count++;
            return value.apply(target, args);
          };
        },
      });
      return {
        // Counts the session check's own queries, not the request's rate
        // limit count.
        nextbase: new NextBase({
          database: pool,
          logs: false,
          rateLimits: false,
        }),
        queries: () => {
          const n = count;
          count = 0;
          return n;
        },
      };
    };
    const page = (headers: Record<string, string> = {}) =>
      new Request(`${origin}/dashboard`, { headers });
    const bearer = (token: string) =>
      page({ authorization: `Bearer ${token}` });

    const signUpTo = async (collection: string, email: string) => {
      const reply = await call(
        nextbase,
        'POST',
        `/collections/${collection}/records`,
        {
          token: admin,
          body: {
            email,
            password: 'password 123 456',
            passwordConfirm: 'password 123 456',
          },
        },
      );
      expect(reply.status).toBe(200);
      const signIn = await call(
        nextbase,
        'POST',
        `/collections/${collection}/auth-with-password`,
        { body: { identity: email, password: 'password 123 456' } },
      );
      return {
        id: reply.body.id as string,
        token: signIn.body.token as string,
      };
    };

    it('takes one query, and a second only to renew the session', async () => {
      await signUp('robin@example.com');
      const cookie = await cookieLogin('robin@example.com');
      const token = await login('robin@example.com');
      const { nextbase: other, queries } = counted();
      const withCookie = page({ cookie: `nextbase_session=${cookie}` });
      // The first requests run migrations and load the schema, so they are not counted.
      await other.getSession(withCookie);
      await other.handle(
        new Request(`${origin}/api/nextbase/session`, {
          headers: { cookie: `nextbase_session=${cookie}` },
        }),
      );
      queries();

      expect((await other.getSession(withCookie))?.record).toMatchObject({
        email: 'robin@example.com',
      });
      expect(queries()).toBe(1);
      expect((await other.getSession(bearer(token)))?.record).toMatchObject({
        email: 'robin@example.com',
      });
      expect(queries()).toBe(1);
      expect(await other.getSession(bearer('made-up'))).toBeNull();
      expect(queries()).toBe(1);
      expect((await call(other, 'GET', '/session')).body).toBeNull();
      expect(queries()).toBe(1);

      await t.db
        .newQuery(
          "UPDATE nextbase._sessions SET expires = now() + interval '1 hour' WHERE collection_id <> '_superusers'",
        )
        .execute();
      queries();
      const renewed = await other.handle(
        new Request(`${origin}/api/nextbase/session`, {
          headers: { cookie: `nextbase_session=${cookie}` },
        }),
      );
      expect(renewed.headers.get('set-cookie')).toContain('nextbase_session=');
      expect(queries()).toBe(2);

      // A session signed out through the first instance stops working here at once.
      await call(nextbase, 'DELETE', '/session', { token });
      expect(await other.getSession(bearer(token))).toBeNull();
    });

    it('sees collections renamed and fields added elsewhere on the next check', async () => {
      const created = await call(nextbase, 'POST', '/collections', {
        token: admin,
        body: { name: 'people', type: 'auth', createRule: '' },
      });
      expect(created.status).toBe(200);
      const { token } = await signUpTo('people', 'pat@example.com');
      const { nextbase: other, queries } = counted();
      expect((await other.getSession(bearer(token)))?.record).toMatchObject({
        email: 'pat@example.com',
      });

      // The second instance still has the old collection name cached.
      await call(nextbase, 'PATCH', '/collections/people', {
        token: admin,
        body: { name: 'members' },
      });
      expect((await other.getSession(bearer(token)))?.record).toMatchObject({
        email: 'pat@example.com',
      });

      const fields = (
        await call(nextbase, 'GET', '/collections/members', { token: admin })
      ).body.fields as object[];
      await call(nextbase, 'PATCH', '/collections/members', {
        token: admin,
        body: { fields: [...fields, { name: 'nickname', type: 'text' }] },
      });
      expect((await other.getSession(bearer(token)))?.record).toHaveProperty(
        'nickname',
        '',
      );
      queries();
      await other.getSession(bearer(token));
      expect(queries()).toBe(1);
    });

    it('reads the record exactly as a plain select does', async () => {
      const created = await call(nextbase, 'POST', '/collections', {
        token: admin,
        body: {
          name: 'everything',
          type: 'auth',
          createRule: '',
          fields: [
            { name: 'title', type: 'text' },
            { name: 'score', type: 'number' },
            { name: 'ratio', type: 'number' },
            { name: 'active', type: 'bool' },
            { name: 'site', type: 'url' },
            { name: 'mobile', type: 'phone' },
            { name: 'born', type: 'date' },
            { name: 'ends', type: 'date' },
            { name: 'never', type: 'date' },
            { name: 'tags', type: 'select', values: ['a', 'b'], maxSelect: 2 },
            { name: 'level', type: 'select', values: ['x', 'y'] },
            { name: 'photos', type: 'file', maxSelect: 3 },
            { name: 'friend', type: 'relation', collectionId: '_superusers' },
            { name: 'meta', type: 'json' },
            { name: 'note', type: 'json' },
            { name: 'secret', type: 'text', hidden: true },
          ],
        },
      });
      expect(created.status).toBe(200);
      const { id, token } = await signUpTo('everything', 'eve@example.com');
      // Values that JSON writes differently from a normal select: BC and far-future
      // dates, fractions of a second, and NaN.
      await t.db
        .newQuery(
          `UPDATE nextbase.everything SET title = 'Eve', score = 0.1, ratio = 'NaN',
             active = true, site = 'https://example.com', born = '0044-03-15 12:00:00.123456+00 BC',
             ends = '12000-01-01 00:00:00+05:30', tags = '{a,b}', level = 'y',
             photos = '{one_0123456789.png}', meta = '{"k":[1,"two",null]}', note = '"plain"',
             secret = 's'
           WHERE id = {:id}`,
        )
        .bind({ id })
        .execute();

      const db = new DB(t.pool, { types: TYPES });
      const { active } = await findSession(db, new SchemaCache(), token, {
        extend: false,
      });
      const [selected] = await db
        .select()
        .from(table('everything'))
        .where(hash({ id }))
        .all();
      expect(active?.record).toEqual(selected);
      expect(Object.keys(active?.record ?? {})).toEqual(
        Object.keys(selected ?? {}),
      );
    });
  });
});
