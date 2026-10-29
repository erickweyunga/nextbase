import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { NextBase, type NextBaseOptions } from '../src/index.ts';
import { type RateLimitRule, rateLimitTimings } from '../src/rate-limits.ts';
import { call, origin } from './http.ts';
import { createTestDatabase, type TestDatabase } from './postgres.ts';

const PASSWORD = 'password 123 456';

interface SendOptions {
  ip?: string;
  token?: string;
  body?: unknown;
}

describe('rate limits', () => {
  let t: TestDatabase;
  const pending: Promise<unknown>[] = [];
  const instances: NextBase[] = [];
  let admin = '';
  let user = '';
  let userId = '';
  let other = '';
  let ips = 0;

  /** A guest IP no other test uses. */
  const nextIp = (): string =>
    `198.51.${Math.floor(ips / 250)}.${(ips++ % 250) + 1}`;

  const instance = (options: NextBaseOptions = {}): NextBase => {
    const created = new NextBase({
      database: t.pool,
      waitUntil: (promise) => pending.push(promise),
      logs: false,
      clientIp: { header: 'x-forwarded-for' },
      ...options,
    });
    instances.push(created);
    return created;
  };
  const limited = (
    rules: RateLimitRule[],
    options: NextBaseOptions = {},
  ): NextBase => instance({ rateLimits: { rules }, ...options });
  const settle = async (): Promise<void> => {
    while (pending.length > 0) await Promise.all(pending.splice(0));
    await Promise.all(instances.map((i) => i.flush()));
  };

  const send = (
    nextbase: NextBase,
    method: string,
    path: string,
    { ip, token, body }: SendOptions = {},
  ): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (ip !== undefined) headers['x-forwarded-for'] = ip;
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    return nextbase.handle(
      new Request(`${origin}/api/nextbase${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  };
  const statuses = async (
    nextbase: NextBase,
    n: number,
    method: string,
    path: string,
    options: SendOptions = {},
  ): Promise<number[]> => {
    const result: number[] = [];
    for (let i = 0; i < n; i++) {
      result.push((await send(nextbase, method, path, options)).status);
    }
    return result;
  };
  /** The label of the rule that limits a guest's request, each rule allowing one. */
  const labelOf = async (
    labels: string[],
    method: string,
    path: string,
  ): Promise<string | undefined> => {
    const nextbase = limited(
      labels.map((label) => ({ label, max: 1, window: 60 })),
    );
    const ip = nextIp();
    await send(nextbase, method, path, { ip });
    const refused = await send(nextbase, method, path, { ip });
    if (refused.status !== 429) return undefined;
    const policy = refused.headers.get('ratelimit-policy') ?? '';
    return /^"(.*)";q=1;w=60$/.exec(policy)?.[1];
  };
  const counts = async (): Promise<Record<string, number>> => {
    const { rows } = await t.pool.query<{ key: string; hits: number }>(
      'SELECT key, hits FROM nextbase._rate_limits',
    );
    return Object.fromEntries(rows.map((r) => [r.key, r.hits]));
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    const setup = instance({ rateLimits: false });
    await setup.createSuperuser('admin@example.com', 'admin password!');
    const superuser = setup.client({ superuser: true });
    await superuser.collections.create({
      name: 'users',
      type: 'auth',
      listRule: '',
      viewRule: '',
    });
    await superuser.collections.create({
      name: 'posts',
      listRule: '',
      viewRule: '',
      createRule: '',
      fields: [{ name: 'title', type: 'text' }],
    });
    await superuser.collections.create({
      name: 'comments',
      listRule: '',
      viewRule: '',
    });
    const signIn = async (collection: string, email: string, pw: string) =>
      (
        await call(
          setup,
          'POST',
          `/collections/${collection}/auth-with-password`,
          {
            body: { identity: email, password: pw },
          },
        )
      ).body.token as string;
    for (const email of ['robin@example.com', 'sam@example.com']) {
      const created = await superuser.collection('users').create({
        email,
        password: PASSWORD,
        passwordConfirm: PASSWORD,
      });
      if (email.startsWith('robin')) userId = created?.id ?? '';
    }
    admin = await signIn('_superusers', 'admin@example.com', 'admin password!');
    user = await signIn('users', 'robin@example.com', PASSWORD);
    other = await signIn('users', 'sam@example.com', PASSWORD);
  });
  afterAll(async () => {
    await settle();
    await t.close();
  });
  beforeEach(async () => {
    await settle();
    await t.pool.query('TRUNCATE nextbase._rate_limits');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rateLimitTimings.pruneEvery = 100;
  });

  describe('which rule applies', () => {
    const all = [
      '/',
      '/collections/',
      '/collections/posts/',
      '/collections/posts/records',
      'GET /collections/posts/records',
      '*:list',
      'posts:list',
    ];

    it('takes the collection tag, then any tag, method and path, path, and longest prefix', async () => {
      const list = ['GET', '/collections/posts/records'] as const;
      expect(await labelOf(all, ...list)).toBe('posts:list');
      expect(await labelOf(all.slice(0, 6), ...list)).toBe('*:list');
      expect(await labelOf(all.slice(0, 5), ...list)).toBe(
        'GET /collections/posts/records',
      );
      expect(await labelOf(all.slice(0, 4), ...list)).toBe(
        '/collections/posts/records',
      );
      expect(await labelOf(all.slice(0, 3), ...list)).toBe(
        '/collections/posts/',
      );
      expect(await labelOf(all.slice(0, 2), ...list)).toBe('/collections/');
      expect(await labelOf(all.slice(0, 1), ...list)).toBe('/');
    });

    it('matches collection tags by name, in any case, and by id', async () => {
      expect(
        await labelOf(
          ['*:list', 'Posts:list'],
          'GET',
          '/collections/posts/records',
        ),
      ).toBe('Posts:list');
      expect(
        await labelOf(
          ['*:list', 'posts:list'],
          'GET',
          '/collections/comments/records',
        ),
      ).toBe('*:list');
      const { rows } = await t.pool.query<{ id: string }>(
        "SELECT id FROM nextbase._collections WHERE name = 'posts'",
      );
      expect(
        await labelOf(
          ['*:list', 'posts:list'],
          'GET',
          `/collections/${rows[0]?.id}/records`,
        ),
      ).toBe('posts:list');
    });

    it('tags every kind of route', async () => {
      const tags = [
        ['create', 'POST', '/collections/posts/records'],
        ['view', 'GET', '/collections/posts/records/x'],
        ['update', 'PATCH', '/collections/posts/records/x'],
        ['delete', 'DELETE', '/collections/posts/records/x'],
        ['auth', 'POST', '/collections/users/auth-with-password'],
        ['auth', 'POST', '/collections/users/request-password-reset'],
        ['auth', 'POST', '/collections/users/confirm-email-change'],
        ['auth', 'POST', '/collections/users/request-phone-code'],
        ['auth', 'POST', '/collections/users/sign-up'],
        ['auth', 'POST', '/collections/users/auth-refresh'],
        ['file', 'GET', '/files/posts/x/a.txt'],
        ['file', 'POST', '/collections/posts/upload-url'],
      ] as const;
      for (const [tag, method, path] of tags) {
        const collection = path.split('/')[2] as string;
        expect(
          await labelOf(
            ['/', `*:${tag}`, `${collection}:${tag}`],
            method,
            path,
          ),
          `${method} ${path}`,
        ).toBe(`${collection}:${tag}`);
      }
      for (const [tag, method, path] of [
        ['batch', 'POST', '/batch'],
        ['realtime', 'POST', '/realtime'],
        ['file', 'POST', '/files/token'],
        ['auth', 'GET', '/callback/github'],
      ] as const) {
        expect(await labelOf(['/', `*:${tag}`], method, path), path).toBe(
          `*:${tag}`,
        );
      }
      // Untagged: only paths apply.
      expect(await labelOf(['/', '*:list'], 'GET', '/collections')).toBe('/');
    });

    it('matches an exact path only, a method only as sent, and HEAD as GET', async () => {
      const labels = [
        '/',
        '/collections/posts',
        'POST /collections/posts/records',
      ];
      expect(await labelOf(labels, 'GET', '/collections/posts/records')).toBe(
        '/',
      );
      expect(await labelOf(labels, 'POST', '/collections/posts/records')).toBe(
        'POST /collections/posts/records',
      );
      expect(
        await labelOf(['/', 'GET /collections'], 'HEAD', '/collections'),
      ).toBe('GET /collections');
    });

    it('takes the rule for the caller, then the rule for both', async () => {
      const nextbase = limited([
        { label: '/', audience: 'guest', max: 1, window: 60 },
        { label: '/', max: 2, window: 60 },
        { label: '*:list', audience: 'auth', max: 3, window: 60 },
      ]);
      const policy = async (options: SendOptions, path: string) => {
        for (let i = 0; i < 5; i++) {
          const reply = await send(nextbase, 'GET', path, options);
          if (reply.status === 429)
            return reply.headers.get('ratelimit-policy');
        }
        return undefined;
      };
      const records = '/collections/posts/records';
      // A guest skips the rule for signed-in callers.
      expect(await policy({ ip: nextIp() }, records)).toBe('"/";q=1;w=60');
      expect(await policy({ token: user }, records)).toBe('"*:list";q=3;w=60');
      expect(
        await policy({ token: user }, '/collections/posts/records/x'),
      ).toBe('"/";q=2;w=60');
    });
  });

  it('lets exactly max of 50 parallel requests through', async () => {
    const nextbase = limited([{ label: '/', max: 10, window: 60 }]);
    const ip = nextIp();
    const replies = await Promise.all(
      Array.from({ length: 50 }, () =>
        send(nextbase, 'GET', '/collections/posts/records', { ip }),
      ),
    );
    const codes = replies.map((r) => r.status);
    expect(codes.filter((s) => s === 200)).toHaveLength(10);
    expect(codes.filter((s) => s === 429)).toHaveLength(40);
  });

  it('answers 429 with the policy and when it resets, before the handler', async () => {
    const nextbase = limited([{ label: '*:create', max: 1, window: 60 }]);
    const ip = nextIp();
    const create = () =>
      send(nextbase, 'POST', '/collections/posts/records', {
        ip,
        body: { title: 'limited' },
      });
    const allowed = await create();
    expect(allowed.status).toBe(200);
    for (const name of ['retry-after', 'ratelimit', 'ratelimit-policy']) {
      expect(allowed.headers.has(name)).toBe(false);
    }
    const refused = await create();
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      status: 429,
      message: 'Too many requests.',
      data: {},
    });
    const retryAfter = Number(refused.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThanOrEqual(59);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(refused.headers.get('ratelimit-policy')).toBe('"*:create";q=1;w=60');
    expect(refused.headers.get('ratelimit')).toBe(
      `"*:create";r=0;t=${retryAfter}`,
    );
    // The refused create never ran.
    const posts = await nextbase
      .client({ superuser: true })
      .collection('posts')
      .getList(1, 10, { filter: 'title = "limited"' });
    expect(posts.totalItems).toBe(1);
  });

  it('starts a new window once the last one ends', async () => {
    const nextbase = limited([{ label: '/', max: 2, window: 60 }]);
    const ip = nextIp();
    const path = '/collections/posts/records';
    expect(await statuses(nextbase, 3, 'GET', path, { ip })).toEqual([
      200, 200, 429,
    ]);
    await t.pool.query(
      "UPDATE nextbase._rate_limits SET window_end = now() - interval '1 millisecond'",
    );
    expect(await statuses(nextbase, 3, 'GET', path, { ip })).toEqual([
      200, 200, 429,
    ]);
    // Refused requests count no further than one past the limit.
    expect(Object.values(await counts())).toEqual([3]);
  });

  it('ends a real window after its seconds', async () => {
    const nextbase = limited([{ label: '/', max: 1, window: 1 }]);
    const ip = nextIp();
    const path = '/collections/posts/records';
    // Sent together, so both land in the one-second window under any load.
    const first = await Promise.all(
      [0, 1].map(() => send(nextbase, 'GET', path, { ip })),
    );
    expect(first.map((r) => r.status).sort()).toEqual([200, 429]);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await send(nextbase, 'GET', path, { ip })).status).toBe(200);
  });

  it('counts signed-in callers per record, whatever their IP, and guests per IP', async () => {
    const nextbase = limited([{ label: '/', max: 2, window: 60 }]);
    const path = '/collections/posts/records';
    expect(
      (await send(nextbase, 'GET', path, { token: user, ip: nextIp() })).status,
    ).toBe(200);
    expect(
      (await send(nextbase, 'GET', path, { token: user, ip: nextIp() })).status,
    ).toBe(200);
    expect((await send(nextbase, 'GET', path, { token: user })).status).toBe(
      429,
    );
    expect((await send(nextbase, 'GET', path, { token: other })).status).toBe(
      200,
    );
    const ip = nextIp();
    expect(await statuses(nextbase, 3, 'GET', path, { ip })).toEqual([
      200, 200, 429,
    ]);
    expect((await send(nextbase, 'GET', path, { ip: nextIp() })).status).toBe(
      200,
    );
    const { rows } = await t.pool.query<{ id: string }>(
      "SELECT id FROM nextbase._collections WHERE name = 'users'",
    );
    // Refused requests count no further than one past the limit.
    expect(await counts()).toMatchObject({
      [`/||rec:${rows[0]?.id}:${userId}`]: 3,
    });
  });

  it('never limits superusers or in-process requests', async () => {
    const nextbase = limited([{ label: '/', max: 1, window: 60 }]);
    const path = '/collections/posts/records';
    expect(await statuses(nextbase, 3, 'GET', path, { token: admin })).toEqual([
      200, 200, 200,
    ]);
    const client = nextbase.client();
    for (let i = 0; i < 3; i++) await client.collection('posts').getList();
    const signedIn = nextbase.client();
    await signedIn
      .collection('users')
      .signInWithPassword('robin@example.com', PASSWORD);
    for (let i = 0; i < 3; i++) await signedIn.collection('posts').getList();
    expect(await counts()).toEqual({});
  });

  it('never limits health checks, the admin page or paths it does not serve', async () => {
    const nextbase = limited([{ label: '/', max: 1, window: 60 }]);
    const ip = nextIp();
    for (const path of ['/health', '/_', '/nothing']) {
      const codes = await statuses(nextbase, 3, 'GET', path, { ip });
      expect(new Set(codes).has(429), path).toBe(false);
    }
    expect(await counts()).toEqual({});
  });

  it('never limits excluded IPs and ranges', async () => {
    const nextbase = instance({
      rateLimits: {
        rules: [{ label: '/', max: 1, window: 60 }],
        excludedIps: ['10.0.0.0/8', '192.0.2.7', '2001:db8::/32'],
      },
    });
    const path = '/collections/posts/records';
    for (const ip of ['10.200.3.4', '192.0.2.7', '2001:db8:ffff::1']) {
      expect(await statuses(nextbase, 3, 'GET', path, { ip }), ip).toEqual([
        200, 200, 200,
      ]);
    }
    // Signed-in callers too.
    expect(
      await statuses(nextbase, 2, 'GET', path, { ip: '10.0.0.1', token: user }),
    ).toEqual([200, 200]);
    for (const ip of ['11.0.0.1', '192.0.2.8', '2001:db9::1']) {
      expect(await statuses(nextbase, 2, 'GET', path, { ip }), ip).toEqual([
        200, 429,
      ]);
    }
  });

  it('skips guests whose IP is unknown, with one warning, and still limits signed-in callers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const nextbase = limited([{ label: '/', max: 1, window: 60 }], {
      clientIp: () => undefined,
    });
    const path = '/collections/posts/records';
    expect(await statuses(nextbase, 3, 'GET', path)).toEqual([200, 200, 200]);
    expect(await statuses(nextbase, 2, 'GET', path, { token: user })).toEqual([
      200, 429,
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /Guests are not rate limited.*clientIp/,
    );
    // No warning when no rule would apply to the guest.
    const quiet = limited(
      [{ label: '/', audience: 'auth', max: 1, window: 60 }],
      { clientIp: () => undefined },
    );
    await send(quiet, 'GET', path);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('counts an IPv6 guest by its /64', async () => {
    const nextbase = limited([{ label: '/', max: 2, window: 60 }]);
    const path = '/collections/posts/records';
    expect(
      (await send(nextbase, 'GET', path, { ip: '2001:db8:1:2::1' })).status,
    ).toBe(200);
    expect(
      (await send(nextbase, 'GET', path, { ip: '[2001:DB8:1:2:ffff::5]:443' }))
        .status,
    ).toBe(200);
    expect(
      (await send(nextbase, 'GET', path, { ip: '2001:db8:1:2:abcd::' })).status,
    ).toBe(429);
    expect(
      (await send(nextbase, 'GET', path, { ip: '2001:db8:1:3::1' })).status,
    ).toBe(200);
    expect(
      (await send(nextbase, 'GET', path, { ip: '::ffff:203.0.113.9' })).status,
    ).toBe(200);
    expect(await counts()).toEqual({
      '/||ip:2001:db8:1:2::/64': 3,
      '/||ip:2001:db8:1:3::/64': 1,
      '/||ip:203.0.113.9': 1,
    });
  });

  it('refuses invalid rules and excluded IPs when it is created', () => {
    const rule = (overrides: Partial<RateLimitRule>): RateLimitRule => ({
      label: '/',
      max: 1,
      window: 1,
      ...overrides,
    });
    const create = (options: unknown) => () =>
      new NextBase({ rateLimits: options as NextBaseOptions['rateLimits'] });
    for (const label of [
      '',
      'posts',
      'posts:nope',
      'posts:LIST',
      'po-sts:list',
      '*:',
      'get /collections',
      'POST /collections/',
      'POST collections',
      'GET  /x',
      'PUSH /x',
      '/x?y=1',
      '/x#y',
      '/a b',
      '/a/../b',
      '/"x"',
      `/${'x'.repeat(200)}`,
    ]) {
      expect(create({ rules: [rule({ label })] }), label).toThrow(TypeError);
    }
    for (const label of [
      '/',
      '/x',
      '/x/',
      '/x%20y',
      'GET /x',
      'DELETE /collections/posts/records/x',
      '*:auth',
      '_superusers:auth',
      'Posts:list',
    ]) {
      expect(create({ rules: [rule({ label })] }), label).not.toThrow();
    }
    expect(create({ rules: [rule({ max: 0 })] })).toThrow(RangeError);
    expect(create({ rules: [rule({ window: 1.5 })] })).toThrow(RangeError);
    expect(create({ rules: [rule({ max: Number.NaN })] })).toThrow(RangeError);
    expect(create({ rules: [rule({ audience: 'admin' as 'auth' })] })).toThrow(
      TypeError,
    );
    expect(create({ rules: [null] })).toThrow(TypeError);
    expect(create({ rules: 'x' })).toThrow(TypeError);
    expect(create('x')).toThrow(TypeError);
    // One rule per label and audience, collection names in any case.
    expect(create({ rules: [rule({}), rule({ max: 2 })] })).toThrow(
      /two rules for "\/"/,
    );
    expect(
      create({
        rules: [rule({ label: 'posts:list' }), rule({ label: 'POSTS:list' })],
      }),
    ).toThrow(TypeError);
    expect(
      create({
        rules: [
          rule({ audience: 'guest' }),
          rule({ audience: 'auth' }),
          rule({}),
        ],
      }),
    ).not.toThrow();
    expect(
      create({
        rules: [rule({ audience: 'guest' }), rule({ audience: 'guest' })],
      }),
    ).toThrow(/audience "guest"/);
    for (const entry of [
      '10.0.0.0/33',
      '2001:db8::/129',
      '10.0.0.0/-1',
      '10.0.0.0/8/8',
      '10.0.0',
      'example.com',
      '10.0.0.0/',
      '10.0.0.1:80',
    ]) {
      expect(create({ excludedIps: [entry] }), entry).toThrow(TypeError);
    }
    expect(create({ excludedIps: '10.0.0.1' })).toThrow(TypeError);
    expect(
      create({ excludedIps: ['10.0.0.1', '10.0.0.0/8', '::1', 'fd00::/8'] }),
    ).not.toThrow();
  });

  it('deletes expired counts in the background, now and then', async () => {
    await t.pool.query(
      `INSERT INTO nextbase._rate_limits (key, hits, window_end)
       SELECT 'old' || n, 1, now() - interval '1 second' FROM generate_series(1, 5) AS n
       UNION ALL SELECT 'live', 1, now() + interval '1 minute'`,
    );
    const nextbase = limited([{ label: '/', max: 5, window: 60 }]);
    const path = '/collections/posts/records';
    rateLimitTimings.pruneEvery = Number.POSITIVE_INFINITY;
    await send(nextbase, 'GET', path, { ip: nextIp() });
    await settle();
    expect(Object.keys(await counts())).toHaveLength(7);
    rateLimitTimings.pruneEvery = 1;
    const ip = nextIp();
    await send(nextbase, 'GET', path, { ip });
    await settle();
    const left = Object.keys(await counts());
    expect(left).toHaveLength(3);
    expect(left).toContain('live');
    expect(left).toContain(`/||ip:${ip}`);
  });

  it('logs a refused request at warn, saying it was rate limited', async () => {
    const nextbase = limited([{ label: '/', max: 1, window: 60 }], {
      logs: {},
    });
    await t.pool.query('TRUNCATE nextbase._logs');
    const ip = nextIp();
    await statuses(nextbase, 2, 'GET', '/collections/posts/records', { ip });
    await settle();
    const { rows } = await t.pool.query<{
      level: number;
      data: Record<string, unknown>;
    }>(
      "SELECT level, data FROM nextbase._logs WHERE data->>'type' = 'request' ORDER BY created",
    );
    expect(rows.map((r) => [r.level, r.data.status, r.data.error])).toEqual([
      [0, 200, undefined],
      [4, 429, 'Too many requests.'],
    ]);
  });

  it('turns off with false', async () => {
    const nextbase = instance({ rateLimits: false });
    const ip = nextIp();
    const codes = await statuses(
      nextbase,
      5,
      'POST',
      '/collections/users/auth-with-password',
      { ip, body: { identity: 'nobody@example.com', password: 'wrong' } },
    );
    // Not even the failed sign-in throttle, which allows 10.
    expect(codes).toEqual([400, 400, 400, 400, 400]);
    expect(await counts()).toEqual({});
  });

  it('limits sign-ins by default, alongside the failed sign-in throttle', async () => {
    const nextbase = instance();
    const ip = nextIp();
    const replies = await Promise.all(
      Array.from({ length: 3 }, () =>
        send(nextbase, 'POST', '/collections/users/auth-with-password', {
          ip,
          body: { identity: 'nobody2@example.com', password: 'wrong' },
        }),
      ),
    );
    const refused = replies.filter((r) => r.status === 429);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.headers.get('ratelimit-policy')).toBe(
      '"*:auth";q=2;w=3',
    );
    // From other IPs, the throttle on failed sign-ins per account still applies.
    const codes: number[] = [];
    let message = '';
    for (let i = 0; i < 11; i++) {
      const reply = await send(
        nextbase,
        'POST',
        '/collections/users/auth-with-password',
        {
          ip: nextIp(),
          body: { identity: 'sam@example.com', password: 'wrong password' },
        },
      );
      codes.push(reply.status);
      message = ((await reply.json()) as { message: string }).message;
    }
    expect(codes).toEqual([...Array<number>(10).fill(400), 429]);
    expect(message).toBe('Too many attempts. Try again later.');
  });
});
