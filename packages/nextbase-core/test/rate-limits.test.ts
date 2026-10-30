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
import { waitFor, waitsForLock } from './wait.ts';

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
      createRule: '',
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
    it('takes the collection tag, then any tag, method and path, path, and longest prefix', async () => {
      const list = ['GET', '/collections/posts/records'] as const;
      const collections = ['/', '/collections/', '*:list', 'posts:list'];
      expect(await labelOf(collections, ...list)).toBe('posts:list');
      expect(await labelOf(collections.slice(0, 3), ...list)).toBe('*:list');
      expect(await labelOf(collections.slice(0, 2), ...list)).toBe(
        '/collections/',
      );
      const batch = ['POST', '/batch'] as const;
      const paths = ['/', '/batch', 'POST /batch', '*:batch'];
      expect(await labelOf(paths, ...batch)).toBe('*:batch');
      expect(await labelOf(paths.slice(0, 3), ...batch)).toBe('POST /batch');
      expect(await labelOf(paths.slice(0, 2), ...batch)).toBe('/batch');
      expect(await labelOf(paths.slice(0, 1), ...batch)).toBe('/');
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
      for (const path of [
        `/collections/${rows[0]?.id}/records`,
        '/collections/%70osts/records',
      ]) {
        expect(await labelOf(['*:list', 'posts:list'], 'GET', path), path).toBe(
          'posts:list',
        );
      }
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
        ['list', 'GET', '/collections/users/records/x/linked-accounts'],
        [
          'delete',
          'DELETE',
          '/collections/users/records/x/linked-accounts/github',
        ],
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
      ] as const) {
        expect(await labelOf(['/', `*:${tag}`], method, path), path).toBe(
          `*:${tag}`,
        );
      }
      // Untagged: only paths apply. The OAuth2 callback is bound to its
      // state cookie and a single-use code, so sign-in limits leave it be.
      expect(await labelOf(['/', '*:list'], 'GET', '/collections')).toBe('/');
      expect(await labelOf(['/', '*:auth'], 'GET', '/callback/github')).toBe(
        '/',
      );
    });

    it('counts creating an auth record as signing up, directly or in a batch', async () => {
      const create = ['POST', '/collections/users/records'] as const;
      expect(
        await labelOf(['/', '*:create', '*:auth', 'users:auth'], ...create),
      ).toBe('users:auth');
      expect(await labelOf(['/', '*:create', '*:auth'], ...create)).toBe(
        '*:auth',
      );
      // A rule for creates in that collection wins; `*:create` never applies.
      expect(
        await labelOf(
          ['/', '*:create', '*:auth', 'users:auth', 'users:create'],
          ...create,
        ),
      ).toBe('users:create');
      expect(await labelOf(['/', '*:create'], ...create)).toBe('/');
      expect(
        await labelOf(['/', '*:auth'], 'POST', '/collections/posts/records'),
      ).toBe('/');
      const nextbase = limited([
        { label: '*:auth', max: 1, window: 60 },
        { label: '*:create', max: 50, window: 60 },
      ]);
      const reply = await send(nextbase, 'POST', '/batch', {
        ip: nextIp(),
        body: {
          requests: ['a', 'b'].map((name) => ({
            method: 'POST',
            url: '/collections/users/records',
            body: {
              email: `${name}-batch@example.com`,
              password: PASSWORD,
              passwordConfirm: PASSWORD,
            },
          })),
        },
      });
      expect(reply.status).toBe(429);
      expect(reply.headers.get('ratelimit-policy')).toBe('"*:auth";q=1;w=60');
      const users = await nextbase
        .client({ superuser: true })
        .collection('users')
        .getList(1, 10, { filter: 'email ~ "-batch@"' });
      expect(users.totalItems).toBe(0);
    });

    it('matches an exact path only, a method only as sent, and HEAD as GET', async () => {
      const labels = ['/', '/batc', 'GET /batch'];
      expect(await labelOf(labels, 'POST', '/batch')).toBe('/');
      expect(
        await labelOf(['/', '/batch', 'GET /batch'], 'POST', '/batch'),
      ).toBe('/batch');
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
    // This instance still refuses until the window it saw ends, without
    // asking the database. Another starts the new window.
    expect((await send(nextbase, 'GET', path, { ip })).status).toBe(429);
    const another = limited([{ label: '/', max: 2, window: 60 }]);
    expect(await statuses(another, 3, 'GET', path, { ip })).toEqual([
      200, 200, 429,
    ]);
    // Refused requests count no further than one past the limit.
    expect(Object.values(await counts())).toEqual([3]);
  });

  it('answers repeated refusals without the database, and never rewrites a refused count', async () => {
    const rules = [{ label: '/', max: 1, window: 60 }];
    const path = '/collections/posts/records';
    const ip = nextIp();
    const first = limited(rules);
    expect(await statuses(first, 2, 'GET', path, { ip })).toEqual([200, 429]);
    const row = async () =>
      (
        await t.pool.query<{ hits: number; version: string }>(
          'SELECT hits, xmin::text AS version FROM nextbase._rate_limits',
        )
      ).rows[0];
    const over = await row();
    expect(over?.hits).toBe(2);
    // Another instance asks the database once, which leaves the row as it
    // is, then answers from memory too.
    let queries = 0;
    const pool = new Proxy(t.pool, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        if (prop !== 'query') return value.bind(target);
        return (...args: unknown[]) => {
          queries++;
          return value.apply(target, args);
        };
      },
    });
    const second = limited(rules, { database: pool });
    await second.migrate();
    queries = 0;
    const refused = await send(second, 'GET', path, { ip });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(55);
    expect(queries).toBe(1);
    expect(await row()).toEqual(over);
    expect(await statuses(second, 5, 'GET', path, { ip })).toEqual(
      Array<number>(5).fill(429),
    );
    expect(queries).toBe(1);
    expect(await statuses(first, 5, 'GET', path, { ip })).toEqual(
      Array<number>(5).fill(429),
    );
    expect(await row()).toEqual(over);
  });

  describe('batches', () => {
    const creates = (n: number, title: string) => ({
      requests: Array.from({ length: n }, () => ({
        method: 'POST',
        url: '/collections/posts/records',
        body: { title },
      })),
    });
    const titled = async (nextbase: NextBase, title: string) =>
      (
        await nextbase
          .client({ superuser: true })
          .collection('posts')
          .getList(1, 1, { filter: `title = "${title}"` })
      ).totalItems;

    it('counts every write as if sent on its own, refusing the whole batch', async () => {
      const nextbase = limited([
        { label: '*:create', max: 3, window: 60 },
        { label: '*:update', max: 1, window: 60 },
        { label: '/', max: 100, window: 60 },
      ]);
      const ip = nextIp();
      const batch = (body: unknown) =>
        send(nextbase, 'POST', '/batch', { ip, body });
      expect((await batch(creates(2, 'batch-a'))).status).toBe(200);
      const refused = await batch(creates(2, 'batch-b'));
      expect(refused.status).toBe(429);
      expect(refused.headers.get('ratelimit-policy')).toBe(
        '"*:create";q=3;w=60',
      );
      expect(await titled(nextbase, 'batch-a')).toBe(2);
      expect(await titled(nextbase, 'batch-b')).toBe(0);
      // The batch itself counts under its own rule too.
      expect(Object.values(await counts()).sort()).toEqual([2, 4]);
      // Other kinds of writes count under their own tags.
      const updates = await batch({
        requests: ['x', 'y'].map((id) => ({
          method: 'PATCH',
          url: `/collections/posts/records/${id}`,
          body: {},
        })),
      });
      expect(updates.headers.get('ratelimit-policy')).toBe(
        '"*:update";q=1;w=60',
      );
    });

    it('refuses a batch over its own rule before counting its writes', async () => {
      const nextbase = limited([
        { label: 'POST /batch', max: 1, window: 60 },
        { label: '*:create', max: 50, window: 60 },
      ]);
      const ip = nextIp();
      expect(
        (await send(nextbase, 'POST', '/batch', { ip, body: creates(1, 'b1') }))
          .status,
      ).toBe(200);
      const refused = await send(nextbase, 'POST', '/batch', {
        ip,
        body: creates(1, 'b2'),
      });
      expect(refused.headers.get('ratelimit-policy')).toBe(
        '"POST /batch";q=1;w=60',
      );
      expect(await titled(nextbase, 'b2')).toBe(0);
    });

    it('counts a signed-in caller by record', async () => {
      const nextbase = limited([{ label: '*:create', max: 3, window: 60 }]);
      expect(
        (
          await send(nextbase, 'POST', '/batch', {
            token: user,
            body: creates(3, 'mine'),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await send(nextbase, 'POST', '/collections/posts/records', {
            token: user,
            ip: nextIp(),
            body: { title: 'mine' },
          })
        ).status,
      ).toBe(429);
    });

    it('limits the default batch to far fewer creates than it carries', async () => {
      const nextbase = instance();
      const reply = await send(nextbase, 'POST', '/batch', {
        token: user,
        body: creates(25, 'default'),
      });
      expect(reply.status).toBe(429);
      expect(reply.headers.get('ratelimit-policy')).toBe('"*:create";q=20;w=5');
      expect(await titled(nextbase, 'default')).toBe(0);
    });
  });

  it('counts requests with an invalid token as a guest', async () => {
    const nextbase = limited([{ label: '/', max: 1, window: 60 }]);
    const ip = nextIp();
    const path = '/collections/posts/records';
    expect(
      await statuses(nextbase, 2, 'GET', path, { ip, token: 'made-up' }),
    ).toEqual([401, 429]);
    expect(await counts()).toEqual({ [`/||ip:${ip}`]: 2 });
  });

  it('sends a refused OAuth2 sign-in back to the app', async () => {
    const nextbase = limited([{ label: '*:auth', max: 1, window: 60 }], {
      appUrl: 'https://app.example',
      oauth2: { github: { clientId: 'client', clientSecret: 'secret' } },
    });
    const ip = nextIp();
    const path =
      '/collections/users/auth-with-oauth2/github?redirect=/home&errorRedirect=/login';
    const started = await send(nextbase, 'GET', path, { ip });
    expect(started.status).toBe(302);
    expect(started.headers.get('location')).toMatch(/^https:\/\/github\.com\//);
    const refused = await send(nextbase, 'GET', path, { ip });
    expect(refused.status).toBe(302);
    expect(refused.headers.get('location')).toBe(
      'https://app.example/login?error=too_many_requests',
    );
    expect(refused.headers.get('ratelimit-policy')).toBe('"*:auth";q=1;w=60');
    expect(refused.headers.get('retry-after')).toMatch(/^\d+$/);
    // With a bad redirect there is nowhere to send it back to, so the
    // refusal is JSON, as the validation error is under the limit.
    const evil =
      '/collections/users/auth-with-oauth2/github?redirect=https://evil.example';
    const invalid = await send(nextbase, 'GET', evil, { ip });
    expect(invalid.status).toBe(429);
    expect(invalid.headers.get('content-type')).toMatch(/json/);
    expect((await send(nextbase, 'GET', evil, { ip: nextIp() })).status).toBe(
      400,
    );
    // Requests that fail validation count too.
    const other = nextIp();
    expect(
      (
        await send(
          nextbase,
          'GET',
          '/collections/nothing/auth-with-oauth2/github',
          {
            ip: other,
          },
        )
      ).status,
    ).toBe(404);
    const after = await send(nextbase, 'GET', path, { ip: other });
    expect(after.headers.get('location')).toBe(
      'https://app.example/login?error=too_many_requests',
    );
  });

  it('never deadlocks batches of one caller that count the same rules in another order', async () => {
    const nextbase = limited([
      { label: '*:create', max: 10_000, window: 60 },
      { label: '*:update', max: 10_000, window: 60 },
      { label: '*:delete', max: 10_000, window: 60 },
    ]);
    const write = (method: string) =>
      method === 'POST'
        ? {
            method,
            url: '/collections/posts/records',
            body: { title: 'order' },
          }
        : { method, url: '/collections/posts/records/missing', body: {} };
    const batch = (methods: string[]) =>
      send(nextbase, 'POST', '/batch', {
        token: user,
        body: { requests: methods.map(write) },
      });
    const statuses: number[] = [];
    const orders = [
      ['POST', 'PATCH', 'DELETE'],
      ['DELETE', 'PATCH', 'POST'],
      ['PATCH', 'DELETE', 'POST'],
      ['POST', 'DELETE', 'PATCH'],
    ];
    for (let round = 0; round < 20; round++) {
      const replies = await Promise.all(
        Array.from({ length: 12 }, (_, i) => batch(orders[i % 4] as string[])),
      );
      statuses.push(...replies.map((r) => r.status));
    }
    // The writes to a missing record fail the batch with a 400; never a
    // conflict or a 500.
    expect(new Set(statuses)).toEqual(new Set([400]));
  });

  it('reads when a window ends again if another statement started it meanwhile', async () => {
    const nextbase = limited([{ label: '/', max: 1, window: 60 }]);
    const ip = nextIp();
    const key = `/||ip:${ip}`;
    const path = '/collections/posts/records';
    await t.pool.query(
      "INSERT INTO nextbase._rate_limits VALUES ($1, 5, now() - interval '1 second')",
      [key],
    );
    // Another caller's statement starts the next window and goes over,
    // committing only once this request's statement has read the old one.
    const other = await t.pool.connect();
    try {
      await other.query('BEGIN');
      await other.query(
        "UPDATE nextbase._rate_limits SET hits = 2, window_end = now() + interval '60 seconds' WHERE key = $1",
        [key],
      );
      const pending = send(nextbase, 'GET', path, { ip });
      await waitFor(() => waitsForLock(t.pool), 'the count to wait');
      await other.query('COMMIT');
      const refused = await pending;
      expect(refused.status).toBe(429);
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(50);
    } finally {
      other.release();
    }
    // Remembered for the window as it is now.
    const again = await send(nextbase, 'GET', path, { ip });
    expect(Number(again.headers.get('retry-after'))).toBeGreaterThan(50);
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
    // The refusal is remembered no longer than the window the database
    // counts, which started before either response.
    await new Promise((resolve) => setTimeout(resolve, 1500));
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

  it('counts an IPv6 guest by its /56', async () => {
    const nextbase = limited([{ label: '/', max: 2, window: 60 }]);
    const path = '/collections/posts/records';
    const status = async (ip: string) =>
      (await send(nextbase, 'GET', path, { ip })).status;
    expect(await status('2001:db8:1:2::1')).toBe(200);
    expect(await status('[2001:DB8:1:FF:ffff::5]:443')).toBe(200);
    expect(await status('2001:db8:1:0:abcd::')).toBe(429);
    expect(await status('2001:db8:1:100::1')).toBe(200);
    expect(await status('2001:db8:2::1')).toBe(200);
    expect(await status('::ffff:203.0.113.9')).toBe(200);
    expect(await counts()).toEqual({
      '/||ip:2001:db8:1:0::/56': 3,
      '/||ip:2001:db8:1:100::/56': 1,
      '/||ip:2001:db8:2:0::/56': 1,
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
    // Paths below one collection can also be sent with its id or escapes.
    for (const label of [
      '/collections/posts/',
      '/collections/posts/records',
      'POST /collections/posts/records',
      'DELETE /collections/posts/records/x',
      '/files/posts/',
      '/files/posts/x/a.txt',
    ]) {
      expect(create({ rules: [rule({ label })] }), label).toThrow(
        /tag label such as "posts:list"/,
      );
    }
    for (const label of [
      '/',
      '/x',
      '/x/',
      '/x%20y',
      'GET /x',
      '/collections/',
      '/collections/posts',
      '/files/',
      'GET /collections',
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
