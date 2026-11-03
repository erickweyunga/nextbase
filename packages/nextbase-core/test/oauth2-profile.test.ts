import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NextBaseClient } from '@nextbasejs/client';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { photoTimings } from '../src/auth/profile.ts';
import { NextBase, remoteFile } from '../src/index.ts';
import { origin } from './http.ts';
import { createTestDatabase, type TestDatabase } from './postgres.ts';

const ISSUER = 'https://idp.example.com';
const PHOTOS = 'https://photos.example';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

interface Grant {
  challenge: string;
  redirectUri: string;
  nonce: string | null;
  sub: string;
  claims: Record<string, unknown>;
}

describe('OAuth2 profiles', () => {
  let t: TestDatabase;
  let dir: string;
  let nextbase: NextBase;
  let admin: NextBaseClient;
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  const grants = new Map<string, Grant>();
  const pending: Promise<unknown>[] = [];
  const photoRequests: string[] = [];

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
      const verifier = createHash('sha256')
        .update(body.get('code_verifier') ?? '')
        .digest('base64url');
      if (!grant || verifier !== grant.challenge) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      const idToken = await new SignJWT({
        ...grant.claims,
        email: `${grant.sub}@example.com`,
        email_verified: true,
        nonce: grant.nonce,
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(ISSUER)
        .setSubject(grant.sub)
        .setAudience('client')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(keys.privateKey);
      return Response.json({
        access_token: `at-${grant.sub}`,
        token_type: 'Bearer',
        id_token: idToken,
      });
    }
    if (url.origin === PHOTOS || url.hostname === 'evil.example') {
      photoRequests.push(url.href);
      if (url.pathname === '/me.png') {
        return new Response(PNG, { headers: { 'content-type': 'image/png' } });
      }
      if (url.pathname === '/large.png') {
        return new Response(new Uint8Array(4096), {
          headers: { 'content-type': 'image/png' },
        });
      }
      if (url.pathname === '/page.html') {
        return new Response('<html></html>', {
          headers: { 'content-type': 'text/html' },
        });
      }
      if (url.pathname === '/away.png') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example/me.png' },
        });
      }
      if (url.pathname === '/slow.png') {
        return new Promise((_, reject) => {
          request.signal.addEventListener('abort', () =>
            reject(request.signal.reason),
          );
        });
      }
    }
    return new Response('not found', { status: 404 });
  };

  const cookieOf = (response: Response, name: string): string | undefined =>
    response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0] as string)
      .find((c) => c.startsWith(`${name}=`) && c !== `${name}=`);

  const signIn = async (
    providerName: string,
    sub: string,
    claims: Record<string, unknown> = {},
  ): Promise<URL> => {
    const start = await nextbase.handle(
      new Request(
        `${origin}/api/nextbase/collections/members/auth-with-oauth2/${providerName}`,
      ),
    );
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.get('location') ?? '');
    const code = randomBytes(16).toString('hex');
    grants.set(code, {
      challenge: authorize.searchParams.get('code_challenge') ?? '',
      redirectUri: authorize.searchParams.get('redirect_uri') ?? '',
      nonce: authorize.searchParams.get('nonce'),
      sub,
      claims,
    });
    const callback = new URL(authorize.searchParams.get('redirect_uri') ?? '');
    callback.searchParams.set('code', code);
    callback.searchParams.set(
      'state',
      authorize.searchParams.get('state') ?? '',
    );
    const done = await nextbase.handle(
      new Request(callback, {
        headers: { cookie: cookieOf(start, 'nextbase_oauth2') ?? '' },
      }),
    );
    expect(done.status).toBe(302);
    return new URL(done.headers.get('location') ?? '');
  };

  const member = (sub: string) =>
    admin
      .collection('members')
      .getFirstListItem(`email = "${sub}@example.com"`)
      .catch(() => undefined);

  const stored = async (collectionId: string, recordId: string) => {
    await Promise.all(pending.splice(0));
    return readdir(join(dir, collectionId, recordId)).catch(
      () => [] as string[],
    );
  };

  const warnings = async (): Promise<string[]> => {
    await nextbase.flush();
    const { rows } = await t.pool.query<{ message: string }>(
      "SELECT message FROM nextbase._logs WHERE level = 4 AND data->>'type' = 'oauth2' ORDER BY created",
    );
    return rows.map((row) => row.message);
  };

  beforeAll(async () => {
    keys = await generateKeyPair('RS256');
    vi.stubGlobal('fetch', provider);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    photoTimings.timeoutMs = 200;
    dir = await mkdtemp(join(tmpdir(), 'nextbase-oauth2-profile-'));
    t = await createTestDatabase();
    const base = { issuer: ISSUER, clientId: 'client', clientSecret: 'secret' };
    nextbase = new NextBase({
      database: t.pool,
      appUrl: origin,
      storage: { dir },
      waitUntil: (promise) => pending.push(promise),
      oauth2: {
        plain: base,
        standard: {
          ...base,
          profileFields: true,
          photoHosts: [PHOTOS.slice(8)],
        },
        named: {
          ...base,
          profileFields: { name: 'nickname' },
          mapProfile: (profile) => ({
            givenName: `${String(profile.nickname)}!`,
          }),
        },
        mapped: {
          ...base,
          photoHosts: ['*.example'],
          mapProfile: (profile) => ({
            name: 'From the app',
            avatar: remoteFile(String(profile.photo)),
          }),
        },
        refreshing: {
          ...base,
          profileFields: true,
          refreshProfile: ['givenName'],
        },
      },
    });
    admin = nextbase.client({ superuser: true });
    await admin.collections.create({
      name: 'members',
      type: 'auth',
      createRule: '',
      fields: [
        { name: 'name', type: 'text', required: true },
        { name: 'givenName', type: 'text' },
        {
          name: 'avatar',
          type: 'file',
          maxSize: 1024,
          mimeTypes: ['image/png'],
        },
      ],
    });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    photoTimings.timeoutMs = 5000;
    await nextbase.flush();
    await t.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('names the missing field of a refused sign-up, and logs why', async () => {
    const back = await signIn('plain', 'nameless');
    expect(back.searchParams.get('error')).toBe('sign_up_failed');
    expect(back.searchParams.get('field')).toBe('name');
    expect(await member('nameless')).toBeUndefined();
    expect(await warnings()).toContainEqual(
      expect.stringMatching(/^OAuth2 sign-up refused: name: /),
    );
  });

  it('asks for the profile scope when it maps profile fields', async () => {
    const start = await nextbase.handle(
      new Request(
        `${origin}/api/nextbase/collections/members/auth-with-oauth2/standard`,
      ),
    );
    const scope = new URL(start.headers.get('location') ?? '').searchParams.get(
      'scope',
    );
    expect(scope?.split(' ')).toEqual(['openid', 'email', 'profile']);
  });

  it('fills the fields the collection has from the standard claims, with the photo', async () => {
    const back = await signIn('standard', 'ada', {
      given_name: 'Ada',
      family_name: 'Lovelace',
      picture: `${PHOTOS}/me.png`,
      locale: 'en',
    });
    expect(back.searchParams.get('error')).toBeNull();
    const record = await member('ada');
    expect(record).toMatchObject({ name: 'Ada Lovelace', givenName: 'Ada' });
    expect(record?.familyName).toBeUndefined();
    expect(record?.avatar).toMatch(/\.png$/);
    const collection = await admin.collections.getOne('members');
    expect(await stored(collection.id, record?.id as string)).toHaveLength(1);
  });

  it('lets mapProfile win, and maps claims to the fields it names', async () => {
    const back = await signIn('named', 'nick', {
      nickname: 'Nick',
      name: 'Nicholas',
    });
    expect(back.searchParams.get('error')).toBeNull();
    expect(await member('nick')).toMatchObject({
      name: 'Nick',
      givenName: 'Nick!',
    });
  });

  it('creates the account without a photo it cannot take', async () => {
    const before = photoRequests.length;
    for (const [sub, photo] of [
      ['large', `${PHOTOS}/large.png`],
      ['page', `${PHOTOS}/page.html`],
      ['slow', `${PHOTOS}/slow.png`],
      ['plaintext', 'http://photos.example/me.png'],
      ['elsewhere', 'https://other.test/me.png'],
    ] as const) {
      const back = await signIn('mapped', sub, { photo });
      expect(back.searchParams.get('error')).toBeNull();
      const record = await member(sub);
      expect(record).toMatchObject({ name: 'From the app', avatar: '' });
    }
    expect(photoRequests.slice(before)).toEqual([
      `${PHOTOS}/large.png`,
      `${PHOTOS}/page.html`,
      `${PHOTOS}/slow.png`,
    ]);
    expect(
      (await warnings()).filter((w) => w.includes('profile photo')),
    ).toHaveLength(5);
  });

  it('follows a redirect only to a photo host', async () => {
    const strict = new NextBase({
      database: t.pool,
      appUrl: origin,
      storage: { dir },
      oauth2: {
        mapped: {
          issuer: ISSUER,
          clientId: 'client',
          clientSecret: 'secret',
          photoHosts: ['photos.example'],
          mapProfile: (profile) => ({
            name: 'Redirected',
            avatar: remoteFile(String(profile.photo)),
          }),
        },
      },
    });
    const previous = nextbase;
    nextbase = strict;
    try {
      const before = photoRequests.length;
      const back = await signIn('mapped', 'redirected', {
        photo: `${PHOTOS}/away.png`,
      });
      expect(back.searchParams.get('error')).toBeNull();
      expect(photoRequests.slice(before)).toEqual([`${PHOTOS}/away.png`]);
      expect(await member('redirected')).toMatchObject({ avatar: '' });
    } finally {
      nextbase = previous;
      await strict.flush();
    }
  });

  it('refreshes only the listed fields on a later sign-in', async () => {
    await signIn('refreshing', 'grace', {
      name: 'Grace Hopper',
      given_name: 'Grace',
    });
    const back = await signIn('refreshing', 'grace', {
      name: 'Admiral Hopper',
      given_name: 'Amazing Grace',
    });
    expect(back.searchParams.get('error')).toBeNull();
    expect(await member('grace')).toMatchObject({
      name: 'Grace Hopper',
      givenName: 'Amazing Grace',
    });
  });
});
