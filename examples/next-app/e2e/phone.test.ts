import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Server, startServer } from './server.ts';
import { firstSuperuser } from './setup.ts';

// Phone sign-in through the built example app: the codes its SMS gateway
// receives, and the session cookie Next.js sets.

let gateway: HttpServer;
let server: Server;
const texts: { to: string; text: string }[] = [];

/** A browser's same-origin request from one of the app's pages. */
function fromPage(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(new URL(path, server.origin), {
    ...init,
    redirect: 'manual',
    headers: {
      ...(init.headers as Record<string, string>),
      origin: server.origin,
      'sec-fetch-site': 'same-origin',
    },
  });
}

const post = (path: string, body: unknown): Promise<Response> =>
  fromPage(`/api/nextbase/collections/users/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function codeFor(phone: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const text = texts.filter((t) => t.to === phone).at(-1)?.text;
    const code = text && /\b(\d{6})\b/.exec(text)?.[1];
    if (code) return code;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`No code texted to ${phone}.`);
}

beforeAll(async () => {
  gateway = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      texts.push(JSON.parse(body));
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => gateway.listen(0, 'localhost', resolve));
  const { port } = gateway.address() as AddressInfo;
  server = await startServer({
    env: () => ({
      SMS_WEBHOOK_URL: `http://localhost:${port}/sms`,
      SMS_COUNTRIES: 'TZ',
    }),
  });
  const admin = await firstSuperuser(server);
  const users = await admin.send('POST', '/collections', {
    name: 'users',
    type: 'auth',
    phoneSignIn: true,
    createRule: '',
    viewRule: 'id = @request.auth.id',
  });
  expect(users.status).toBe(200);
});

afterAll(async () => {
  await server?.stop();
  await new Promise<void>((resolve) => gateway?.close(() => resolve()));
});

describe('phone sign-in in the example app', () => {
  it('signs up with a texted code and opens the protected page', async () => {
    const signInPage = await (await fromPage('/sign-in')).text();
    expect(signInPage).toContain('Text me a code');

    // What the sign-in form sends, step by step.
    expect(
      (await post('request-phone-code', { phone: '+255 712 345 678' })).status,
    ).toBe(204);
    const code = await codeFor('+255712345678');
    const signIn = await post('auth-with-phone-code', {
      phone: '+255712345678',
      code,
      cookie: true,
    });
    expect(signIn.status).toBe(200);
    const body = (await signIn.json()) as {
      token?: string;
      record: Record<string, unknown>;
    };
    expect(body.token).toBeUndefined();
    expect(body.record).toMatchObject({
      phone: '+255712345678',
      phoneVerified: true,
    });
    const cookie = signIn.headers
      .getSetCookie()
      .find((c) => c.startsWith('__Host-nextbase_session='));
    expect(cookie).toMatch(/HttpOnly; SameSite=Lax; Secure/);

    const dashboard = await fromPage('/dashboard', {
      headers: { cookie: (cookie as string).split(';')[0] as string },
    });
    expect(dashboard.status).toBe(200);
    expect((await dashboard.text()).replaceAll('<!-- -->', '')).toContain(
      'Welcome, +255712345678.',
    );
  });

  it('does not let another site sign a browser in with a code', async () => {
    await post('request-phone-code', { phone: '+255754000001' });
    const code = await codeFor('+255754000001');
    const crossSite = await fetch(
      new URL(
        '/api/nextbase/collections/users/auth-with-phone-code',
        server.origin,
      ),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://evil.example',
          'sec-fetch-site': 'cross-site',
        },
        body: JSON.stringify({ phone: '+255754000001', code, cookie: true }),
      },
    );
    expect(crossSite.status).toBe(403);
    expect(crossSite.headers.getSetCookie()).toEqual([]);
  });

  it('only texts the countries the app allows', async () => {
    const kenya = await post('request-phone-code', { phone: '+254712345678' });
    expect(kenya.status).toBe(400);
    expect(texts.some((t) => t.to === '+254712345678')).toBe(false);
  });
});
