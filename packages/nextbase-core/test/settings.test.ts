import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { clientIpSettings } from '../src/client-ip.ts';
import { NextBase, type NextBaseOptions } from '../src/index.ts';
import { createTestDatabase, type TestDatabase } from './postgres.ts';

describe('application settings', () => {
  let t: TestDatabase;
  const instances: NextBase[] = [];
  const settings = async (options: NextBaseOptions = {}) => {
    const nextbase = new NextBase({
      database: t.pool,
      logs: false,
      ...options,
    });
    instances.push(nextbase);
    return (await nextbase.client({ superuser: true }).settings.get())
      .application;
  };

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    for (const nextbase of instances) await nextbase.flush();
    await t.close();
  });

  it('answers the defaults', async () => {
    expect(await settings()).toEqual({
      appUrl: '',
      basePath: '/api/nextbase',
      trustedOrigins: [],
      trustProxy: false,
      clientIp: { source: 'unknown' },
      statementTimeout: 8000,
      rateLimits: {
        rules: [
          { label: '*:auth', audience: null, max: 2, window: 3 },
          { label: '*:create', audience: null, max: 20, window: 5 },
          { label: 'POST /batch', audience: null, max: 3, window: 1 },
          { label: '/', audience: null, max: 300, window: 10 },
        ],
        excludedIps: [],
      },
      realtime: null,
    });
  });

  it('answers what the options set, without the listen URL', async () => {
    const application = await settings({
      appUrl: 'https://app.example.com',
      trustedOrigins: ['*.example.com'],
      trustProxy: true,
      clientIp: { header: 'X-Forwarded-For', trustedHops: 1 },
      statementTimeout: 0,
      rateLimits: {
        rules: [{ label: 'users:auth', audience: 'guest', max: 5, window: 60 }],
        excludedIps: ['10.0.0.0/8'],
      },
      realtime: {
        collections: ['posts'],
        streamSeconds: 60,
        listenUrl: 'postgres://user:secret@db.example.com/app',
      },
    });
    expect(application).toEqual({
      appUrl: 'https://app.example.com/',
      basePath: '/api/nextbase',
      trustedOrigins: ['*.example.com'],
      trustProxy: true,
      clientIp: {
        source: 'header',
        header: 'x-forwarded-for',
        trustedHops: 1,
      },
      statementTimeout: 0,
      rateLimits: {
        rules: [{ label: 'users:auth', audience: 'guest', max: 5, window: 60 }],
        excludedIps: ['10.0.0.0/8'],
      },
      realtime: { collections: ['posts'], streamSeconds: 60 },
    });
    expect(JSON.stringify(application)).not.toContain('secret');
  });

  it('answers when rate limits are off and realtime covers every collection', async () => {
    expect(await settings({ rateLimits: false, realtime: true })).toMatchObject(
      {
        rateLimits: null,
        realtime: { collections: null, streamSeconds: 240 },
      },
    );
  });
});

describe('security settings', () => {
  let t: TestDatabase;
  const instances: NextBase[] = [];
  const key = () => randomBytes(32).toString('base64');
  const security = async (options: NextBaseOptions = {}) => {
    const nextbase = new NextBase({
      database: t.pool,
      logs: false,
      ...options,
    });
    instances.push(nextbase);
    return (await nextbase.client({ superuser: true }).settings.get()).security;
  };

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    for (const nextbase of instances) await nextbase.flush();
    await t.close();
  });

  it('answers what guards secrets and sign-ins, never the keys', async () => {
    vi.stubEnv('NEXTBASE_SECRET_KEY', '');
    expect(await security()).toEqual({
      secretKeys: 0,
      secretKeySource: 'none',
      rejectBreachedPasswords: false,
      validateSignIn: false,
    });
    const first = key();
    const options = await security({
      secretKey: [first, key()],
      rejectBreachedPasswords: true,
      validateSignIn: () => undefined,
    });
    expect(options).toEqual({
      secretKeys: 2,
      secretKeySource: 'option',
      rejectBreachedPasswords: true,
      validateSignIn: true,
    });
    expect(JSON.stringify(options)).not.toContain(first);
    vi.stubEnv('NEXTBASE_SECRET_KEY', key());
    expect(await security()).toMatchObject({
      secretKeys: 1,
      secretKeySource: 'env',
    });
  });
});

describe('clientIpSettings', () => {
  it('names where the IP comes from', () => {
    expect(clientIpSettings(undefined, false)).toEqual({ source: 'unknown' });
    expect(clientIpSettings(undefined, true)).toEqual({ source: 'vercel' });
    expect(clientIpSettings('vercel', false)).toEqual({ source: 'vercel' });
    expect(clientIpSettings(() => '1.2.3.4', false)).toEqual({
      source: 'function',
    });
    expect(clientIpSettings({ header: 'X-Real-IP' }, false)).toEqual({
      source: 'header',
      header: 'x-real-ip',
      trustedHops: 0,
    });
  });
});
