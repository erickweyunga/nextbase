import { spawnSync } from 'node:child_process';
import net from 'node:net';
import {
  AuthStore,
  type ClientError,
  type Collection,
  NextBaseClient,
  type RealtimeEvent,
  type RecordModel,
} from '@nextbasejs/client';
import { DB } from '@nextbasejs/dbx';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiError, NextBase, type SmsMessage } from '../src/index.ts';
import { CursorSigner } from '../src/realtime/cursor.ts';
import { headCursor, readEvents, writeEvents } from '../src/realtime/events.ts';
import { type HubStream, RealtimeHub } from '../src/realtime/hub.ts';
import { timings } from '../src/realtime/timings.ts';
import { call, origin } from './http.ts';
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseUrl,
} from './postgres.ts';
import { waitFor } from './wait.ts';

const PASSWORD = 'password 123 456';
const ADMIN = 'admin@example.com';
const ADMIN_PASSWORD = 'admin password 123';

interface Message {
  type: string;
  id?: string;
  data?: Record<string, unknown>;
}

interface OpenStream {
  status: number;
  headers: Headers;
  /** The error body, when the stream was refused. */
  body: Record<string, unknown>;
  messages: Message[];
  /** The create, update and delete events, as the first topic got them. */
  records: () => { action: string; record: Record<string, unknown> }[];
  /** The id the client would send back in Last-Event-ID. */
  lastId: () => string | undefined;
  ended: () => boolean;
  close: () => Promise<void>;
}

/** Opens a realtime stream over HTTP and collects its messages. */
async function open(
  nextbase: NextBase,
  topics: Record<string, unknown>[],
  options: { token?: string; lastEventId?: string } = {},
): Promise<OpenStream> {
  const controller = new AbortController();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.lastEventId) headers['last-event-id'] = options.lastEventId;
  const response = await nextbase.handle(
    new Request(`${origin}/api/nextbase/realtime`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ topics }),
      signal: controller.signal,
    }),
  );
  const messages: Message[] = [];
  let ended = false;
  let lastId: string | undefined;
  const reading = response.ok
    ? (async () => {
        const reader = (response.body as ReadableStream<Uint8Array>)
          .pipeThrough(new TextDecoderStream())
          .getReader();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += value;
          let end = buffer.indexOf('\n\n');
          while (end !== -1) {
            const message: Message = { type: '' };
            for (const line of buffer.slice(0, end).split('\n')) {
              const [field, ...rest] = line.split(': ');
              const value = rest.join(': ');
              if (field === 'id') message.id = lastId = value;
              else if (field === 'event') message.type = value;
              else if (field === 'data') message.data = JSON.parse(value);
            }
            messages.push(message);
            buffer = buffer.slice(end + 2);
            end = buffer.indexOf('\n\n');
          }
        }
      })().finally(() => {
        ended = true;
      })
    : Promise.resolve();
  return {
    status: response.status,
    headers: response.headers,
    body: response.ok
      ? {}
      : ((await response.json()) as Record<string, unknown>),
    messages,
    records: () =>
      messages
        .filter((m) => ['create', 'update', 'delete'].includes(m.type))
        .map((m) => ({
          action: m.type,
          record: (m.data?.topics as Record<string, Record<string, unknown>>)?.[
            '0'
          ] as Record<string, unknown>,
        })),
    lastId: () => lastId,
    ended: () => ended,
    close: async () => {
      controller.abort();
      await reading.catch(() => {});
    },
  };
}

/** A promise with its resolve, to hold a hook until a test lets it go. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** How many connections of the test database are listening for events. */
async function listeners(t: TestDatabase): Promise<number> {
  const { rows } = await t.pool.query(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND query = 'LISTEN nextbase_realtime'",
  );
  return rows[0].n as number;
}

/** Wraps `pool` to count the queries sent to Postgres, including those in transactions. */
function counting(pool: pg.Pool): {
  pool: pg.Pool;
  trips: () => number;
} {
  let count = 0;
  const countQueries = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        if (prop === 'query') {
          return (...args: unknown[]) => {
            count++;
            return value.apply(target, args);
          };
        }
        if (prop === 'connect') {
          return async () => countQueries(await value.apply(target));
        }
        return value.bind(target);
      },
    });
  return {
    pool: countQueries(pool),
    trips: () => {
      const n = count;
      count = 0;
      return n;
    },
  };
}

describe('realtime', () => {
  const defaults = { ...timings };
  let t: TestDatabase;
  let nextbase: NextBase;
  let admin: NextBaseClient;
  const pending: Promise<unknown>[] = [];
  const texts: SmsMessage[] = [];
  const people = ['alice', 'bob', 'carol', 'dave'] as const;
  const tokens = { alice: '', bob: '', carol: '', dave: '', admin: '' };
  const ids = { alice: '', bob: '', carol: '', dave: '' };
  let slow = gate();
  /** A record the held create updates once it is let go. */
  let slowUpdate: string | undefined;
  let entered = gate();
  const streams: OpenStream[] = [];

  const flush = async (): Promise<void> => {
    while (pending.length > 0) await Promise.all(pending.splice(0));
  };
  const signIn = async (email: string, password = PASSWORD) =>
    (
      await call(nextbase, 'POST', '/collections/users/auth-with-password', {
        body: { identity: email, password },
      })
    ).body.token as string;
  const subscribe = async (
    topics: Record<string, unknown>[],
    options: { token?: string; lastEventId?: string; via?: NextBase } = {},
  ): Promise<OpenStream> => {
    const stream = await open(options.via ?? nextbase, topics, options);
    streams.push(stream);
    if (stream.status === 200) {
      // Subscribed once the first message, the cursor, arrives.
      await waitFor(() => stream.messages.length > 0, 'the stream to start');
    }
    return stream;
  };
  /**
   * Waits until `stream` got `n` record events whose records `keep` keeps.
   * A stream may also get writes committed shortly before it started, which
   * a transaction of another test file, on another database of the server,
   * held back. So tests count only their own records.
   */
  const received = async (
    stream: OpenStream,
    n: number,
    keep: (record: Record<string, unknown>) => boolean = () => true,
  ) => {
    const kept = () => stream.records().filter((e) => keep(e.record));
    await waitFor(() => kept().length >= n, `${n} events`);
    return kept();
  };

  beforeAll(async () => {
    Object.assign(timings, {
      pollMs: 30,
      reconnectMs: 20,
      maxReconnectMs: 100,
      heartbeatMs: 100,
      sessionMs: 50,
      purgeMs: 0,
    });
    t = await createTestDatabase();
    nextbase = new NextBase({
      database: t.pool,
      waitUntil: (promise) => pending.push(promise),
      sms: {
        countries: ['TZ'],
        send: async (message) => {
          texts.push(message);
        },
      },
      realtime: {
        collections: [
          'users',
          'rooms',
          'messages',
          'posts',
          'comments',
          'locked',
          'items',
          'lounge',
          'tagged',
          'scores',
        ],
        listenUrl: t.url,
      },
      hooks: {
        items: {
          async onCreate(e) {
            if (String(e.record.title).startsWith('slow')) {
              entered.open();
              await slow.promise;
              if (slowUpdate) {
                await e.nextbase
                  .collection('items')
                  .update(slowUpdate, { title: 'from slow' });
              }
            }
            if (e.record.title === 'boom') throw new ApiError(400, 'Boom.');
          },
        },
      },
    });
    await nextbase.createSuperuser(ADMIN, ADMIN_PASSWORD);
    admin = nextbase.client({ superuser: true });
    const users = await admin.collections.create({
      name: 'users',
      type: 'auth',
      phoneSignIn: true,
      identityFields: ['email', 'phone'],
      createRule: '',
      listRule: '',
      viewRule: '',
      updateRule: 'id = @request.auth.id',
      fields: [{ name: 'name', type: 'text' }],
    });
    const rooms = await admin.collections.create({
      name: 'rooms',
      listRule: '',
      viewRule: '',
      fields: [{ name: 'name', type: 'text' }],
    });
    await admin.collections.create({
      name: 'messages',
      listRule: 'public = true || author = @request.auth.id',
      viewRule: 'public = true || author = @request.auth.id',
      createRule: 'author = @request.auth.id',
      updateRule: 'author = @request.auth.id',
      fields: [
        { name: 'text', type: 'text' },
        { name: 'public', type: 'bool' },
        { name: 'secret', type: 'text', hidden: true },
        { name: 'room', type: 'relation', collectionId: rooms.id },
        {
          name: 'author',
          type: 'relation',
          collectionId: users.id,
          maxSelect: 1,
        },
      ],
    });
    const posts = await admin.collections.create({
      name: 'posts',
      listRule: '',
      viewRule: '',
      fields: [{ name: 'title', type: 'text' }],
    });
    await admin.collections.create({
      name: 'comments',
      listRule: '',
      viewRule: '',
      fields: [
        { name: 'text', type: 'text' },
        {
          name: 'post',
          type: 'relation',
          collectionId: posts.id,
          cascadeDelete: true,
        },
      ],
    });
    await admin.collections.create({
      name: 'locked',
      fields: [{ name: 'text', type: 'text' }],
    });
    await admin.collections.create({
      name: 'items',
      listRule: '',
      viewRule: '',
      fields: [{ name: 'title', type: 'text', required: true }],
    });
    await admin.collections.create({
      name: 'scores',
      listRule: '',
      viewRule: '',
      fields: [{ name: 'active', type: 'bool' }],
    });
    await admin.collections.create({
      name: 'tagged',
      listRule: '',
      viewRule: '',
      fields: [
        { name: 'tag', type: 'relation', collectionId: rooms.id, maxSelect: 1 },
      ],
    });
    await admin.collections.create({
      name: 'lounge',
      listRule: '@request.auth.name = "vip"',
      viewRule: '@request.auth.name = "vip"',
      fields: [{ name: 'text', type: 'text' }],
    });
    await admin.collections.create({
      name: 'notes',
      listRule: '',
      viewRule: '',
      fields: [{ name: 'text', type: 'text' }],
    });
    for (const name of people) {
      const record = await admin.collection('users').create({
        email: `${name}@example.com`,
        name,
        password: PASSWORD,
        passwordConfirm: PASSWORD,
      });
      ids[name] = record?.id ?? '';
      tokens[name] = await signIn(`${name}@example.com`);
    }
    tokens.admin = (
      await call(
        nextbase,
        'POST',
        '/collections/_superusers/auth-with-password',
        {
          body: { identity: ADMIN, password: ADMIN_PASSWORD },
        },
      )
    ).body.token as string;
  });

  afterAll(async () => {
    await Promise.all(streams.map((s) => s.close()));
    await waitFor(async () => (await listeners(t)) === 0, 'listeners to stop');
    await flush();
    Object.assign(timings, defaults);
    await nextbase.flush();
    await t.close();
  });

  it('sends creates, updates and deletes once, in order, as a list would return them', async () => {
    const stream = await subscribe(
      [{ collection: 'messages', expand: 'author' }],
      { token: tokens.alice },
    );
    const created = await admin.collection('messages').create({
      text: 'hello',
      public: true,
      secret: 's',
      author: ids.bob,
    });
    const id = created?.id as string;
    await admin.collection('messages').update(id, { text: 'edited' });
    await admin.collection('messages').delete(id);
    expect(stream.headers.get('content-type')).toBe(
      'text/event-stream; charset=utf-8',
    );
    expect(stream.headers.get('cache-control')).toBe('no-store, no-transform');
    const events = await received(stream, 3, (r) => r.id === id);
    expect(events.map((e) => e.action)).toEqual(['create', 'update', 'delete']);
    expect(events.map((e) => e.record.text)).toEqual([
      'hello',
      'edited',
      // A delete sends the record as it was.
      'edited',
    ]);
    for (const { record } of events) {
      expect(record.id).toBe(id);
      expect(record.collectionName).toBe('messages');
      expect(record).not.toHaveProperty('secret');
      // Bob's email is not visible to Alice, as in a list.
      expect(record.expand).toMatchObject({
        author: { id: ids.bob, name: 'bob', email: '' },
      });
      expect(record.expand).not.toHaveProperty('author.password');
      expect(record.expand).not.toHaveProperty('author.tokenKey');
    }
    // Ids increase in commit order.
    const order = stream.messages
      .filter((m) => m.type !== '')
      .map((m) => m.id as string);
    expect([...order].sort(byId)).toEqual(order);
    expect(stream.lastId()).toBe(order.at(-1));
  });

  it("shapes records with fields, and shows a record's own email to it", async () => {
    const shaped = await subscribe(
      [{ collection: 'messages', fields: 'id,text' }],
      { token: tokens.alice },
    );
    const own = await subscribe([{ collection: 'users', id: ids.alice }], {
      token: tokens.alice,
    });
    const other = await subscribe([{ collection: 'users', id: ids.alice }], {
      token: tokens.bob,
    });
    await admin.collection('messages').create({ text: 'fields', public: true });
    await admin.collection('users').update(ids.alice, { name: 'Alice' });
    const [message] = await received(shaped, 1, (r) => r.text === 'fields');
    expect(Object.keys(message?.record ?? {})).toEqual(['id', 'text']);
    const renamed = (r: Record<string, unknown>) => r.name === 'Alice';
    const [mine] = await received(own, 1, renamed);
    expect(mine?.record).toMatchObject({
      name: 'Alice',
      email: 'alice@example.com',
    });
    expect(mine?.record).not.toHaveProperty('password');
    expect(mine?.record).not.toHaveProperty('tokenKey');
    const [theirs] = await received(other, 1, renamed);
    expect(theirs?.record).toMatchObject({ name: 'Alice', email: '' });
  });

  it('sends each subscriber only what its rules and filter allow', async () => {
    const bob = await subscribe([{ collection: 'messages' }], {
      token: tokens.bob,
    });
    const anonymous = await subscribe([{ collection: 'messages' }]);
    const superuser = await subscribe([{ collection: 'messages' }], {
      token: tokens.admin,
    });
    const filtered = await subscribe(
      [{ collection: 'messages', filter: 'text ~ "match"' }],
      { token: tokens.alice },
    );
    const alice = nextbase.client();
    alice.authStore.save(tokens.alice as string, null);
    const hidden = await alice
      .collection('messages')
      .create({ text: 'private match', author: ids.alice });
    await alice
      .collection('messages')
      .create({ text: 'public', public: true, author: ids.alice });
    // One record, under the view rule.
    const one = await subscribe(
      [{ collection: 'messages', id: hidden?.id as string }],
      { token: tokens.bob },
    );
    const mine = await subscribe(
      [{ collection: 'messages', id: hidden?.id as string }],
      { token: tokens.alice },
    );
    await alice
      .collection('messages')
      .update(hidden?.id as string, { text: 'private match 2' });
    await alice
      .collection('messages')
      .create({ text: 'last', public: true, author: ids.alice });

    const written = ['private match', 'public', 'private match 2', 'last'];
    const ours = (r: Record<string, unknown>) =>
      written.includes(r.text as string);
    const texts = async (s: OpenStream, n: number) =>
      (await received(s, n, ours)).map((e) => e.record.text);
    expect(await texts(bob, 2)).toEqual(['public', 'last']);
    expect(await texts(anonymous, 2)).toEqual(['public', 'last']);
    expect(await texts(superuser, 4)).toEqual(written);
    expect(await texts(filtered, 2)).toEqual([
      'private match',
      'private match 2',
    ]);
    await received(mine, 1, (r) => r.text === 'private match 2');
    // Bob got the last event, so he would have got the update by now.
    // Ids are signed for each caller; their first parts are the position.
    const position = (s: OpenStream) =>
      s.lastId()?.split('.').slice(0, 2).join('.');
    await waitFor(
      () => position(one) === position(superuser),
      'the stream to pass the update',
    );
    expect(one.records()).toEqual([]);
  });

  it('refuses topics a list or view request would refuse', async () => {
    const refused = async (
      topics: Record<string, unknown>[],
      token?: string,
    ) => {
      const stream = await subscribe(topics, { ...(token && { token }) });
      return { status: stream.status, body: stream.body };
    };
    const locked = await refused(
      [{ collection: 'rooms' }, { collection: 'locked' }],
      tokens.alice,
    );
    expect(locked.status).toBe(403);
    expect(locked.body.data).toEqual({
      topics: {
        1: {
          code: 'realtime_topic_refused',
          message: 'Only superusers can perform this action.',
        },
      },
    });
    expect(
      (await refused([{ collection: 'locked' }], tokens.admin)).status,
    ).toBe(200);
    expect((await refused([{ collection: 'notes' }])).status).toBe(400);
    expect(
      (await refused([{ collection: '_superusers' }], tokens.admin)).status,
    ).toBe(400);
    expect((await refused([{ collection: 'missing' }])).status).toBe(404);
    expect(
      (await refused([{ collection: 'rooms', filter: 'nope = 1' }])).status,
    ).toBe(400);
    expect(
      (await refused([{ collection: 'rooms', expand: 'a.b.c.d.e.f.g' }]))
        .status,
    ).toBe(400);
    expect(
      (await refused([{ collection: 'rooms', id: 'bad id' }])).status,
    ).toBe(404);
    expect((await refused([])).status).toBe(400);
    expect((await refused([{ collection: 1 }])).status).toBe(400);
    expect(
      (
        await refused(
          Array.from({ length: 51 }, () => ({ collection: 'rooms' })),
        )
      ).status,
    ).toBe(400);
    // An id that is not one starts over, as any id not signed for the caller.
    const malformed = await subscribe([{ collection: 'rooms' }], {
      lastEventId: 'nope',
    });
    expect(malformed.messages[0]?.type).toBe('reset');
  });

  it('sends nothing for writes that roll back', async () => {
    const stream = await subscribe([{ collection: 'items' }], {
      token: tokens.admin,
    });
    await expect(
      admin.collection('items').create({ title: 'boom' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      admin
        .createBatch()
        .collection('items')
        .create({ title: 'batched' })
        .collection('items')
        .create({ title: '' })
        .send(),
    ).rejects.toMatchObject({ status: 400 });
    await admin
      .createBatch()
      .collection('items')
      .create({ title: 'one' })
      .collection('items')
      .create({ title: 'two' })
      .collection('items')
      .create({ title: 'three' })
      .send();
    const events = await received(stream, 3);
    expect(events.map((e) => e.record.title)).toEqual(['one', 'two', 'three']);
    const { rows } = await t.pool.query(
      "SELECT count(*)::int AS n FROM nextbase._realtime_events WHERE record->>'title' IN ('boom', 'batched')",
    );
    expect(rows[0].n).toBe(0);
  });

  it("sends cascades, cleared relations and NextBase's own writes", async () => {
    const stream = await subscribe(
      [
        { collection: 'comments' },
        { collection: 'messages' },
        { collection: 'users' },
      ],
      { token: tokens.admin },
    );
    const post = await admin.collection('posts').create({ title: 'p' });
    const comment = await admin
      .collection('comments')
      .create({ text: 'c', post: post?.id });
    const room = await admin.collection('rooms').create({ name: 'r' });
    const message = await admin
      .collection('messages')
      .create({ text: 'in room', room: room?.id });
    await admin.collection('posts').delete(post?.id as string);
    await admin.collection('rooms').delete(room?.id as string);
    // A sign-up with a texted code: NextBase creates the record itself.
    const phone = '+255712345678';
    const nb = nextbase.client();
    await nb.collection('users').requestPhoneCode(phone);
    await flush();
    const code = /\b(\d{6})\b/.exec(texts.at(-1)?.text ?? '')?.[1] as string;
    await nb.collection('users').signInWithPhoneCode(phone, code);

    const ours = [comment?.id, message?.id];
    const events = () =>
      stream.messages
        .filter((m) => m.data?.topics)
        .map((m) => {
          const [[topic, record]] = Object.entries(
            m.data?.topics as Record<string, Record<string, unknown>>,
          ) as [[string, Record<string, unknown>]];
          return { action: m.type, topic, record };
        })
        .filter(
          ({ record }) =>
            ours.includes(record.id as string) || record.phone === phone,
        );
    await waitFor(() => events().length >= 5, '5 events');
    expect(
      events().map(({ action, topic, record }) => [action, topic, record.id]),
    ).toEqual([
      ['create', '0', comment?.id],
      ['create', '1', message?.id],
      // The cascade deletes the comment, and the room leaves the message.
      ['delete', '0', comment?.id],
      ['update', '1', message?.id],
      ['create', '2', expect.any(String)],
    ]);
    expect(events()[3]?.record.room).toBe('');
    expect(events()[4]?.record.phone).toBe(phone);
  });

  it('never logs superusers, nor collections without realtime', async () => {
    await nextbase.createSuperuser('second@example.com', ADMIN_PASSWORD);
    await admin.collection('notes').create({ text: 'n' });
    const { rows } = await t.pool.query(
      "SELECT count(*)::int AS n FROM nextbase._realtime_events WHERE collection_id IN ('_superusers', (SELECT id FROM nextbase._collections WHERE name = 'notes'))",
    );
    expect(rows[0].n).toBe(0);
  });

  it('sends both of two overlapping transactions, in commit order', async () => {
    const stream = await subscribe([{ collection: 'items' }], {
      token: tokens.admin,
    });
    slow = gate();
    entered = gate();
    const writing = admin.collection('items').create({ title: 'slow' });
    // The slow create logged its event and holds its transaction open.
    await entered.promise;
    await admin.collection('items').create({ title: 'fast' });
    slow.open();
    await writing;
    const events = await received(stream, 2, (r) =>
      ['slow', 'fast'].includes(r.title as string),
    );
    // The slow create started writing first, but committed last.
    expect(events.map((e) => e.record.title)).toEqual(['fast', 'slow']);
  });

  it("sends a record's writes in the order they were committed", async () => {
    const shared = await admin.collection('items').create({ title: 'shared' });
    const id = shared?.id as string;
    const stream = await subscribe([{ collection: 'items', id }], {
      token: tokens.admin,
    });
    slow = gate();
    entered = gate();
    slowUpdate = id;
    try {
      // The held create starts writing first, then updates the record last.
      const writing = admin.collection('items').create({ title: 'slow one' });
      await entered.promise;
      await admin.collection('items').update(id, { title: 'from fast' });
      slow.open();
      await writing;
    } finally {
      slowUpdate = undefined;
    }
    expect((await admin.collection('items').getOne(id)).title).toBe(
      'from slow',
    );
    const events = await received(stream, 2, (r) => r.title !== 'shared');
    expect(events.map((e) => e.record.title)).toEqual([
      'from fast',
      'from slow',
    ]);
  });

  it('keeps events of a transaction that commits after old events are deleted', async () => {
    slow = gate();
    entered = gate();
    const writing = admin.collection('items').create({ title: 'slow late' });
    await entered.promise;
    // Deletes everything committed so far, while the held create runs.
    timings.retentionMs = 0;
    try {
      await admin.collection('items').create({ title: 'purged' });
      // A write deletes old events while it runs, so it takes a second
      // write to delete the first once it is committed.
      await admin.collection('items').create({ title: 'purging' });
      await flush();
      const { rows } = await t.pool.query(
        "SELECT count(*)::int AS n FROM nextbase._realtime_events WHERE record->>'title' = 'purged'",
      );
      expect(rows[0].n).toBe(0);
    } finally {
      timings.retentionMs = defaults.retentionMs;
    }
    const stream = await subscribe([{ collection: 'items' }], {
      token: tokens.admin,
    });
    slow.open();
    await writing;
    await received(stream, 1, (r) => r.title === 'slow late');
    expect(stream.messages.some((m) => m.type === 'reset')).toBe(false);
  });

  it('notices a listening connection that died without a word', async () => {
    const proxy = await freezableProxy(t.url);
    Object.assign(timings, { healthMs: 50, healthTimeoutMs: 50 });
    try {
      const instance = new NextBase({
        database: t.pool,
        realtime: { collections: ['rooms'], listenUrl: proxy.url },
      });
      const before = await listeners(t);
      const stream = await subscribe([{ collection: 'rooms' }], {
        via: instance,
      });
      await waitFor(async () => (await listeners(t)) > before, 'a listener');
      // The connection stays open but carries nothing, as after a NAT drop.
      proxy.freeze();
      await admin.collection('rooms').create({ name: 'after freeze' });
      await received(stream, 1, (r) => r.name === 'after freeze');
      await stream.close();
    } finally {
      Object.assign(timings, {
        healthMs: defaults.healthMs,
        healthTimeoutMs: defaults.healthTimeoutMs,
      });
      await proxy.close();
    }
  });

  it('resumes only for the caller and the record state an id was sent to', async () => {
    const first = await subscribe([{ collection: 'rooms' }], {
      token: tokens.alice,
    });
    const id = first.lastId() as string;
    await first.close();
    await admin.collection('rooms').create({ name: 'replay' });
    const replayed = (s: OpenStream) =>
      s.records().some((e) => e.record.name === 'replay');

    const bob = await subscribe([{ collection: 'rooms' }], {
      token: tokens.bob,
      lastEventId: id,
    });
    expect(bob.messages[0]?.type).toBe('reset');
    const own = await subscribe([{ collection: 'rooms' }], {
      token: tokens.alice,
      lastEventId: id,
    });
    await received(own, 1, (r) => r.name === 'replay');
    expect(own.messages[0]?.type).not.toBe('reset');

    // A changed record, such as one given a new role, starts over.
    await admin.collection('users').update(ids.alice, { name: 'promoted' });
    const promoted = await subscribe([{ collection: 'rooms' }], {
      token: tokens.alice,
      lastEventId: id,
    });
    expect(promoted.messages[0]?.type).toBe('reset');
    await admin.collection('users').update(ids.alice, { name: 'Alice' });
    await admin.collection('rooms').create({ name: 'after replay' });
    const after = (r: Record<string, unknown>) => r.name === 'after replay';
    await received(bob, 1, after);
    await received(promoted, 1, after);
    expect(replayed(bob)).toBe(false);
    expect(replayed(promoted)).toBe(false);
  });

  it('starts over when resuming across a change of the collections', async () => {
    const stream = await subscribe([{ collection: 'tagged' }], {
      token: tokens.admin,
    });
    const room = await admin.collection('rooms').create({ name: 'tag' });
    await admin.collection('tagged').create({ tag: room?.id });
    await received(stream, 1);
    const id = stream.lastId() as string;
    await stream.close();
    // The relation now takes several records: the old event's single value
    // no longer fits it.
    const tagged = await admin.collections.getOne('tagged');
    await admin.collections.update('tagged', {
      fields: tagged.fields.map((f) =>
        f.name === 'tag' ? { ...f, maxSelect: 2 } : f,
      ),
    });
    const resumed = await subscribe([{ collection: 'tagged' }], {
      token: tokens.admin,
      lastEventId: id,
    });
    expect(resumed.messages[0]?.type).toBe('reset');
    await admin.collection('tagged').create({ tag: [room?.id] });
    const [event] = await received(resumed, 1);
    expect(event?.record.tag).toEqual([room?.id]);
    expect(resumed.ended()).toBe(false);
  });

  it('stops sending as soon as the session ends', async () => {
    // The timer alone would not notice for a minute.
    timings.sessionMs = 60_000;
    try {
      const token = await signIn('bob@example.com');
      const stream = await subscribe([{ collection: 'rooms' }], { token });
      await call(nextbase, 'DELETE', '/session', { token });
      await admin.collection('rooms').create({ name: 'after sign out' });
      await waitFor(stream.ended, 'the stream to end');
      expect(stream.messages.at(-1)?.data).toEqual({ reason: 'signed_out' });
      expect(
        stream.records().some((e) => e.record.name === 'after sign out'),
      ).toBe(false);
    } finally {
      timings.sessionMs = 50;
    }
  });

  it('limits streams per account and the weight of topics', async () => {
    await admin.collection('users').create({
      email: 'erin@example.com',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    const token = await signIn('erin@example.com');
    const open: OpenStream[] = [];
    for (let i = 0; i < 10; i++) {
      open.push(await subscribe([{ collection: 'rooms' }], { token }));
    }
    const refused = await subscribe([{ collection: 'rooms' }], { token });
    expect(refused.status).toBe(429);
    await Promise.all(open.map((s) => s.close()));
    expect((await subscribe([{ collection: 'rooms' }], { token })).status).toBe(
      200,
    );

    const heavy = await subscribe(
      Array.from({ length: 50 }, () => ({
        collection: 'messages',
        expand: 'author,room',
      })),
      { token },
    );
    expect(heavy.status).toBe(400);
    expect(String(heavy.body.message)).toMatch(/weigh 150/);
  });

  it("goes back to its own reads when the instance's read fails or falls behind", async () => {
    const injected = injectable(t.pool);
    const instance = new NextBase({
      database: injected.pool,
      realtime: { collections: ['rooms'], listenUrl: t.url },
    });
    const stream = await subscribe([{ collection: 'rooms' }], {
      via: instance,
    });
    // Caught up, the stream follows the instance's reads.
    await admin.collection('rooms').create({ name: 'followed' });
    await received(stream, 1, (r) => r.name === 'followed');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      injected.failNextSharedRead();
      await admin.collection('rooms').create({ name: 'after failure' });
      await received(stream, 1, (r) => r.name === 'after failure');
      expect(injected.failed()).toBe(1);
      expect(String(error.mock.calls[0]?.[0])).toMatch(/reading events failed/);
    } finally {
      error.mockRestore();
    }

    // The instance finds events it has not read deleted: the stream reads
    // on by itself, finds the same and resets.
    await admin.collection('rooms').create({ name: 'followed again' });
    await received(stream, 1, (r) => r.name === 'followed again');
    await t.pool.query(
      `UPDATE nextbase._realtime_state s
       SET purged_position = l.position, purged_seq = l.seq + 1
       FROM (SELECT t.position, max(e.seq) AS seq
             FROM nextbase._realtime_transactions t
             JOIN nextbase._realtime_events e ON e.transaction_id = t.id
             WHERE t.position IS NOT NULL
             GROUP BY t.position ORDER BY t.position DESC LIMIT 1) l`,
    );
    await admin.collection('rooms').create({ name: 'behind' });
    await waitFor(
      () => stream.messages.some((m) => m.type === 'reset'),
      'a reset',
    );
    await admin.collection('rooms').create({ name: 'after reset' });
    await received(stream, 1, (r) => r.name === 'after reset');
  });

  it('reads the sessions of all streams with one query per page', async () => {
    // The timer alone would not read them during the test.
    timings.sessionMs = 60_000;
    try {
      await admin.collection('users').create({
        email: 'frank@example.com',
        password: PASSWORD,
        passwordConfirm: PASSWORD,
      });
      const counted = counting(t.pool);
      // Without request logs, whose writes would land in a count whenever
      // they are flushed.
      const instance = new NextBase({
        database: counted.pool,
        realtime: { collections: ['rooms'], listenUrl: t.url },
        logs: false,
      });
      const open: OpenStream[] = [];
      const trips = async (name: string) => {
        await admin.collection('rooms').create({ name: `warm ${name}` });
        for (const stream of open) {
          await received(stream, 1, (r) => r.name === `warm ${name}`);
        }
        counted.trips();
        await admin.collection('rooms').create({ name });
        for (const stream of open) {
          await received(stream, 1, (r) => r.name === name);
        }
        return counted.trips();
      };
      open.push(
        await subscribe([{ collection: 'rooms' }], {
          via: instance,
          token: await signIn('frank@example.com'),
        }),
      );
      const one = await trips('one session');
      for (let i = 0; i < 4; i++) {
        open.push(
          await subscribe([{ collection: 'rooms' }], {
            via: instance,
            token: await signIn('frank@example.com'),
          }),
        );
      }
      // Reading each stream's session alone would add a trip per stream;
      // background work may add one to either count, so only more fails.
      expect(await trips('five sessions')).toBeLessThanOrEqual(one);
      await Promise.all(open.map((s) => s.close()));
    } finally {
      timings.sessionMs = 50;
    }
  });

  it('signs the id it ends with for the signed-in record as it is', async () => {
    Object.assign(timings, { sessionMs: 60_000, heartbeatMs: 60_000 });
    try {
      const short = new NextBase({
        database: t.pool,
        realtime: { collections: true, listenUrl: t.url, streamSeconds: 0.3 },
      });
      const grace = await admin.collection('users').create({
        email: 'grace@example.com',
        password: PASSWORD,
        passwordConfirm: PASSWORD,
      });
      const token = await signIn('grace@example.com');
      const stream = await subscribe([{ collection: 'rooms' }], {
        via: short,
        token,
      });
      const reply = await call(
        nextbase,
        'PATCH',
        `/collections/users/records/${grace?.id}`,
        { token, body: { name: 'Grace H' } },
      );
      expect(reply.status).toBe(200);
      await waitFor(stream.ended, 'the stream to end');
      const resumed = await subscribe([{ collection: 'rooms' }], {
        via: short,
        token,
        lastEventId: stream.lastId() as string,
      });
      expect(resumed.messages[0]?.type).not.toBe('reset');
      await resumed.close();
    } finally {
      Object.assign(timings, { sessionMs: 50, heartbeatMs: 100 });
    }
  });

  it('leaves out only the records it cannot read back', async () => {
    const stream = await subscribe(
      [{ collection: 'scores', filter: 'active = true' }],
      { token: tokens.admin },
    );
    const collection = await admin.collections.getOne('scores');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // One transaction, so one page: a good record, one whose flag cannot
      // be read back, and another good one.
      await t.pool.query(
        `WITH tx AS (SELECT nextval('nextbase._realtime_transaction_ids') AS id),
         mark AS (INSERT INTO nextbase._realtime_transactions (id) SELECT id FROM tx)
         INSERT INTO nextbase._realtime_events (transaction_id, collection_id, action, record_id, record)
         SELECT tx.id, $1, 'create', v.id, jsonb_build_object('id', v.id, 'active', v.active)
         FROM tx, (VALUES ('good1', 'true'::jsonb), ('bad', '"x"'::jsonb), ('good2', 'true'::jsonb)) AS v(id, active)`,
        [collection.id],
      );
      await t.pool.query("SELECT pg_notify('nextbase_realtime', '')");
      const events = await received(stream, 2);
      expect(events.map((e) => e.record.id)).toEqual(['good1', 'good2']);
      await waitFor(
        () => stream.messages.some((m) => m.type === 'reset'),
        'a reset',
      );
      expect(stream.ended()).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('reads for a new start while a read from before a stop still runs', async () => {
    const held = gate();
    let heads = 0;
    const slow = new Proxy(t.pool, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop !== 'query' || typeof value !== 'function') {
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return async (config: { text?: string }, ...rest: unknown[]) => {
          // The first read of where the log ends hangs until let go.
          if (
            String(config?.text).includes('purgedPosition') &&
            heads++ === 0
          ) {
            await held.promise;
          }
          return value.call(target, config, ...rest);
        };
      },
    });
    const pollMs = timings.pollMs;
    // Polling would hide a read that never happens.
    timings.pollMs = 60_000;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const quiet: HubStream = {
      session: undefined,
      sessionRead() {},
      page() {},
      wake() {},
      unfollowed() {},
    };
    const hub = new RealtimeHub(
      undefined,
      () => new DB(slow),
      async () => [],
    );
    try {
      const first = hub.subscribe(quiet);
      await waitFor(() => heads === 1, 'the first read to hang');
      first();
      const unsubscribe = hub.subscribe({ ...quiet });
      // The new start reads while the old read still hangs.
      await waitFor(() => heads === 2, "the new start's read");
      held.open();
      unsubscribe();
    } finally {
      held.open();
      warn.mockRestore();
      timings.pollMs = pollMs;
    }
  });

  it('reads each page of events once for every stream', async () => {
    const counted = counting(t.pool);
    // Without request logs, whose writes would land in a count whenever
    // they are flushed.
    const instance = new NextBase({
      database: counted.pool,
      realtime: { collections: ['rooms'], listenUrl: t.url },
      logs: false,
    });
    const before = await listeners(t);
    const many: OpenStream[] = [];
    for (let i = 0; i < 5; i++) {
      many.push(await subscribe([{ collection: 'rooms' }], { via: instance }));
    }
    await waitFor(async () => (await listeners(t)) > before, 'a listener');
    const all = async (name: string) => {
      await admin.collection('rooms').create({ name });
      for (const stream of many) {
        await received(stream, 1, (r) => r.name === name);
      }
    };
    // Caught up, the streams follow the instance's reads.
    await all('warm');
    counted.trips();
    await all('shared');
    expect(counted.trips()).toBeLessThanOrEqual(2);
    await Promise.all(many.map((s) => s.close()));
  });

  it.skipIf(!hasPgDump())(
    'keeps working on a restored copy of the database',
    async () => {
      const first = await subscribe([{ collection: 'rooms' }], {
        token: tokens.alice,
      });
      await admin.collection('rooms').create({ name: 'before dump' });
      await received(first, 1, (r) => r.name === 'before dump');
      const id = first.lastId() as string;
      await first.close();
      const copy = await createTestDatabase();
      try {
        const dump = spawnSync(
          'pg_dump',
          ['--no-owner', '--no-privileges', t.url],
          {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
          },
        );
        expect(dump.status).toBe(0);
        const restore = spawnSync(
          'psql',
          ['--quiet', '--set', 'ON_ERROR_STOP=1', copy.url],
          { input: dump.stdout, encoding: 'utf8' },
        );
        expect(restore.stderr).toBe('');
        const restored = new NextBase({
          database: copy.pool,
          realtime: { collections: ['rooms'], listenUrl: copy.url },
        });
        // The id resumes on the copy, which has the same secret and log.
        const resumed = await open(restored, [{ collection: 'rooms' }], {
          token: tokens.alice,
          lastEventId: id,
        });
        try {
          await waitFor(() => resumed.messages.length > 0, 'the stream');
          expect(resumed.messages[0]?.type).not.toBe('reset');
          await restored
            .client({ superuser: true })
            .collection('rooms')
            .create({ name: 'on the copy' });
          await waitFor(
            () =>
              resumed.records().some((e) => e.record.name === 'on the copy'),
            "the copy's event",
          );
        } finally {
          await resumed.close();
        }
        await waitFor(
          async () => (await listeners(copy)) === 0,
          "the copy's listener to stop",
        );
      } finally {
        await copy.close();
      }
    },
  );

  it('sends events at once while other transactions run', async () => {
    const stream = await subscribe([{ collection: 'items' }], {
      token: tokens.admin,
    });
    // A transaction that took an id and stays open, as session renewals
    // and other writes do for a moment, holds nothing back.
    const blocker = new pg.Client({ connectionString: t.url });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_current_xact_id()');
      await admin.collection('items').create({ title: 'unblocked' });
      await received(stream, 1, (r) => r.title === 'unblocked');
      await blocker.query('COMMIT');
    } finally {
      await blocker.end();
    }
  });

  it('orders events by commit, not by when a transaction started writing', async () => {
    const collection = { id: 'gap', fields: [] } as unknown as Collection;
    const start = await headCursor(t.db);
    const read = async () =>
      (await readEvents(t.db, start, ['gap'], 500)).events.map(
        (e) => e.recordId,
      );
    const early = await t.db.begin();
    try {
      // The early transaction writes first and commits last.
      await writeEvents(early, collection, 'create', [{ id: 'early' }]);
      await t.db.transaction((late) =>
        writeEvents(late, collection, 'update', [{ id: 'shared' }]),
      );
      // The late one is committed: it is sent at once, not held back.
      expect(await read()).toEqual(['shared']);
      await writeEvents(early, collection, 'update', [{ id: 'shared' }]);
      await early.commit();
    } finally {
      if (!early.done) await early.rollback();
    }
    // The early transaction's update of the shared record comes last, as
    // the database has it.
    expect(await read()).toEqual(['shared', 'early', 'shared']);
    await t.pool.query(
      "DELETE FROM nextbase._realtime_events WHERE collection_id = 'gap'",
    );
  });

  it('resumes after the last event id, without losing or repeating events', async () => {
    const first = await subscribe([{ collection: 'rooms' }], {
      token: tokens.alice,
    });
    const start = first.lastId();
    expect(start).toBeTruthy();
    await first.close();
    await admin.collection('rooms').create({ name: 'missed 1' });
    await admin.collection('rooms').create({ name: 'missed 2' });
    const resumed = await subscribe([{ collection: 'rooms' }], {
      token: tokens.alice,
      lastEventId: start as string,
    });
    const missed = (r: Record<string, unknown>) =>
      String(r.name).startsWith('missed');
    const events = await received(resumed, 2, missed);
    expect(events.map((e) => e.record.name)).toEqual(['missed 1', 'missed 2']);
    const afterOne = resumed.messages.find(
      (m) =>
        (m.data?.topics as Record<string, Record<string, unknown>>)?.['0']
          ?.name === 'missed 1',
    )?.id as string;
    const again = await subscribe([{ collection: 'rooms' }], {
      token: tokens.alice,
      lastEventId: afterOne,
    });
    const rest = await received(again, 1, missed);
    expect(rest.map((e) => e.record.name)).toEqual(['missed 2']);
  });

  it('resets a subscriber whose events were deleted as too old', async () => {
    const first = await subscribe([{ collection: 'rooms' }], {
      token: tokens.alice,
    });
    const old = first.lastId() as string;
    await first.close();
    await admin.collection('rooms').create({ name: 'forgotten' });
    await t.pool.query(
      "UPDATE nextbase._realtime_transactions SET committed = now() - interval '1 day'",
    );
    // A write deletes old events in the background.
    await admin.collection('rooms').create({ name: 'kept' });
    await flush();
    const stream = await subscribe([{ collection: 'rooms' }], {
      token: tokens.alice,
      lastEventId: old,
    });
    await waitFor(
      () => stream.messages.some((m) => m.type === 'reset'),
      'a reset',
    );
    await admin.collection('rooms').create({ name: 'after' });
    await received(stream, 1, (r) => r.name === 'after');
    expect(stream.records().map((e) => e.record.name)).not.toContain(
      'forgotten',
    );

    // A signed id ahead of the log, as after restoring an older copy of the
    // database, resets too, and says so in the log.
    const { rows } = await t.pool.query(
      'SELECT setup_secret, schema_version FROM nextbase._meta',
    );
    const ahead = new CursorSigner(rows[0].setup_secret).sign(
      { position: 10n ** 12n, seq: 1n },
      Number(rows[0].schema_version),
      { superuser: false },
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const future = await subscribe([{ collection: 'rooms' }], {
        lastEventId: ahead,
      });
      expect(future.messages[0]?.type).toBe('reset');
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/ahead of the event log/);
    } finally {
      warn.mockRestore();
    }
  });

  it('ends the stream when its session ends', async () => {
    const carol = await subscribe([{ collection: 'rooms' }], {
      token: tokens.carol,
    });
    await call(nextbase, 'DELETE', '/session', { token: tokens.carol });
    await waitFor(carol.ended, 'the stream to end');
    expect(carol.messages.at(-1)).toEqual({
      type: 'end',
      data: { reason: 'signed_out' },
    });

    // A password change ends the record's other sessions.
    const other = await signIn('dave@example.com');
    const dave = await subscribe([{ collection: 'rooms' }], {
      token: tokens.dave,
    });
    const reply = await call(
      nextbase,
      'PATCH',
      `/collections/users/records/${ids.dave}`,
      {
        token: other,
        body: {
          oldPassword: PASSWORD,
          password: 'a new password 1',
          passwordConfirm: 'a new password 1',
        },
      },
    );
    expect(reply.status).toBe(200);
    await waitFor(dave.ended, 'the stream to end');
    expect(dave.messages.at(-1)?.data).toEqual({ reason: 'signed_out' });
  });

  it('checks rules with the signed-in record as it is now', async () => {
    const lounge = await subscribe([{ collection: 'lounge' }], {
      token: tokens.bob,
    });
    await admin.collection('users').update(ids.bob, { name: 'vip' });
    // Once the stream reads the session again, Bob's new name lets him in.
    let n = 0;
    await waitFor(async () => {
      await admin.collection('lounge').create({ text: `after ${n++}` });
      return lounge.records().length > 0;
    }, 'a record let in by the new name');
    await admin.collection('users').update(ids.bob, { name: 'bob' });
  });

  it('ends the stream after streamSeconds', async () => {
    const short = new NextBase({
      database: t.pool,
      realtime: { collections: true, listenUrl: t.url, streamSeconds: 0.2 },
    });
    const stream = await subscribe([{ collection: 'rooms' }], { via: short });
    await waitFor(stream.ended, 'the stream to end');
    expect(stream.messages.at(-1)).toEqual({
      type: 'end',
      data: { reason: 'timeout' },
    });
  });

  it('delivers writes made through another instance, and polls when it cannot listen', async () => {
    const other = new NextBase({
      database: t.pool,
      realtime: { collections: true, listenUrl: t.url },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deaf = new NextBase({
        database: t.pool,
        realtime: {
          collections: ['rooms'],
          listenUrl: 'postgres://localhost:1/nextbase_none',
        },
      });
      const listening = await subscribe([{ collection: 'rooms' }], {
        via: other,
      });
      const polling = await subscribe([{ collection: 'rooms' }], {
        via: deaf,
      });
      await admin.collection('rooms').create({ name: 'elsewhere' });
      const elsewhere = (r: Record<string, unknown>) => r.name === 'elsewhere';
      await received(listening, 1, elsewhere);
      await received(polling, 1, elsewhere);
      // Only the deaf instance cannot listen. The other warning says guests
      // are not rate limited, since their IP is unknown.
      const listen = warn.mock.calls.filter((c) =>
        /cannot listen/.test(String(c[0])),
      );
      expect(listen).toHaveLength(1);
      await polling.close();
      await listening.close();
    } finally {
      warn.mockRestore();
    }
  });

  it('holds no connection while idle, and stops listening once streams close', async () => {
    await Promise.all(streams.map((s) => s.close()));
    await waitFor(async () => (await listeners(t)) === 0, 'listeners to stop');
    const stream = await subscribe([{ collection: 'rooms' }]);
    await waitFor(async () => (await listeners(t)) === 1, 'a listener');
    await admin.collection('rooms').create({ name: 'idle' });
    await received(stream, 1, (r) => r.name === 'idle');
    await waitFor(
      () => t.pool.totalCount === t.pool.idleCount,
      'connections to return to the pool',
    );
    await stream.close();
    await waitFor(async () => (await listeners(t)) === 0, 'listeners to stop');
  });

  it("logs a batch's creates with one statement, so they stay together", async () => {
    // Old events are deleted on the first write only, out of the count.
    timings.purgeMs = 60_000;
    const counted = counting(t.pool);
    const instance = new NextBase({
      database: counted.pool,
      realtime: { collections: ['rooms'], listenUrl: t.url },
    });
    const client = instance.client({ superuser: true });
    const batch = (n: number) => {
      const b = client.createBatch();
      for (let i = 0; i < n; i++)
        b.collection('rooms').create({ name: `b${i}` });
      return b.send();
    };
    await batch(2);
    counted.trips();
    // Two creates take as many queries as twenty.
    await batch(2);
    const two = counted.trips();
    await batch(20);
    expect(counted.trips()).toBe(two);
    timings.purgeMs = 0;
  });
});

describe('realtime client', () => {
  const defaults = { ...timings };
  let t: TestDatabase;
  let nextbase: NextBase;
  let admin: NextBaseClient;
  let userId: string;

  /** A browser-like client that talks to `nextbase` over its handler. */
  const browser = (): NextBaseClient =>
    new NextBaseClient({
      baseUrl: `${origin}/api/nextbase`,
      fetch: (input, init) => nextbase.handle(new Request(input, init)),
      authStore: new AuthStore({ storage: null }),
    });

  beforeAll(async () => {
    Object.assign(timings, { pollMs: 30, sessionMs: 50, heartbeatMs: 100 });
    t = await createTestDatabase();
    nextbase = new NextBase({
      database: t.pool,
      realtime: { collections: true, listenUrl: t.url, streamSeconds: 0.3 },
    });
    admin = nextbase.client({ superuser: true });
    await admin.collections.create({
      name: 'users',
      type: 'auth',
      listRule: '',
      viewRule: '',
      fields: [{ name: 'name', type: 'text' }],
    });
    await admin.collections.create({
      name: 'tasks',
      listRule: '@request.auth.id != ""',
      viewRule: '@request.auth.id != ""',
      fields: [{ name: 'title', type: 'text' }],
    });
    await admin.collections.create({
      name: 'secrets',
      fields: [{ name: 'text', type: 'text' }],
    });
    userId =
      (
        await admin.collection('users').create({
          email: 'user@example.com',
          password: PASSWORD,
          passwordConfirm: PASSWORD,
        })
      )?.id ?? '';
  });

  afterAll(async () => {
    await waitFor(async () => (await listeners(t)) === 0, 'listeners to stop');
    Object.assign(timings, defaults);
    await nextbase.flush();
    await t.close();
  });

  it('subscribes, survives stream ends without losing events, and unsubscribes', async () => {
    const nb = browser();
    await nb
      .collection('users')
      .signInWithPassword('user@example.com', PASSWORD);
    const tasks: RealtimeEvent[] = [];
    const users: RealtimeEvent[] = [];
    let live = 0;
    const onReset = () => {
      live++;
    };
    const offTasks = nb
      .collection('tasks')
      .subscribe('*', (e) => tasks.push(e), { fields: 'id,title', onReset });
    const offUser = nb
      .collection('users')
      .subscribe(userId, (e) => users.push(e), { onReset });
    // Both are live once their stream started.
    await waitFor(() => live === 2, 'the subscriptions to be live');
    // Streams end every 0.3 seconds; writes across several are all sent once.
    for (let i = 0; i < 6; i++) {
      await admin.collection('tasks').create({ title: `t${i}` });
      await waitFor(() => tasks.length > i, `task ${i}`);
    }
    await admin.collection('users').update(userId, { name: 'renamed' });
    // Its create may come too, if held back until the stream started.
    const updates = () => users.filter((e) => e.action === 'update');
    await waitFor(() => updates().length === 1, 'the user update');
    expect(tasks.map((e) => e.record.title)).toEqual(
      Array.from({ length: 6 }, (_, i) => `t${i}`),
    );
    expect(Object.keys(tasks[0]?.record ?? {})).toEqual(['id', 'title']);
    expect(updates()[0]).toMatchObject({
      action: 'update',
      record: { id: userId, name: 'renamed' },
    });
    offTasks();
    offUser();
    await waitFor(async () => (await listeners(t)) === 0, 'the stream to stop');
  });

  it('starts over when the session changes, and reports refused topics', async () => {
    const nb = browser();
    const seen: RecordModel[] = [];
    const errors: ClientError[] = [];
    const off = nb
      .collection('tasks')
      .subscribe('*', (e) => seen.push(e.record));
    const refused = nb
      .collection('secrets')
      .subscribe('*', () => {}, { onError: (e) => errors.push(e) });
    await waitFor(() => errors.length === 1, 'the refusal');
    expect(errors[0]?.status).toBe(403);
    refused();
    // Signed out, the list rule refuses every task.
    await admin.collection('tasks').create({ title: 'unseen' });
    await nb
      .collection('users')
      .signInWithPassword('user@example.com', PASSWORD);
    await waitFor(async () => (await listeners(t)) === 1, 'the stream');
    await admin.collection('tasks').create({ title: 'seen' });
    await waitFor(
      () => seen.some((r) => r.title === 'seen'),
      'the task seen once signed in',
    );
    off();
  });
});

/**
 * Wraps `pool` so a test can make the instance's next shared read of the
 * event log fail, as a dropped connection would.
 */
function injectable(pool: pg.Pool): {
  pool: pg.Pool;
  failNextSharedRead: () => void;
  failed: () => number;
} {
  let fail = false;
  let failed = 0;
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        if (prop === 'query') {
          return (config: { text?: string }, ...rest: unknown[]) => {
            // The instance's read takes every record; a stream's own read
            // takes those of its collections.
            if (fail && String(config?.text).includes('e.record AS record')) {
              fail = false;
              failed++;
              return Promise.reject(new Error('injected failure'));
            }
            return value.call(target, config, ...rest);
          };
        }
        if (prop === 'connect') {
          return async () => wrap(await value.apply(target));
        }
        return value.bind(target);
      },
    });
  return {
    pool: wrap(pool),
    failNextSharedRead: () => {
      fail = true;
    },
    failed: () => failed,
  };
}

/** Whether pg_dump and psql are installed, for the restore test. */
/**
 * Whether pg_dump and psql are installed, and pg_dump can dump the test
 * server: it refuses a server of a newer major version than its own.
 */
function hasPgDump(): boolean {
  const major = (text: string) => Number(/(\d+)/.exec(text)?.[1] ?? 0);
  const dump = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
  const server = spawnSync(
    'psql',
    ['-tAc', 'SHOW server_version_num', testDatabaseUrl()],
    { encoding: 'utf8' },
  );
  if (dump.status !== 0 || server.status !== 0) return false;
  return major(dump.stdout) >= Math.floor(major(server.stdout) / 10_000);
}

/**
 * A TCP proxy to the database whose open connections can be frozen: they
 * stay open but carry nothing, as when a NAT drops a connection or a
 * server fails over without saying so. Later connections pass.
 */
async function freezableProxy(
  target: string,
): Promise<{ url: string; freeze: () => void; close: () => Promise<void> }> {
  const { hostname, port } = new URL(target);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(port || 5432), hostname || 'localhost');
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => {
        sockets.delete(socket);
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = new URL(target);
  url.hostname = '127.0.0.1';
  url.port = String((server.address() as net.AddressInfo).port);
  return {
    url: url.toString(),
    freeze: () => {
      for (const socket of sockets) {
        socket.unpipe();
        socket.pause();
      }
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Orders event ids, `{position}.{seq}.{schema}.{signature}`, by position. */
function byId(a: string, b: string): number {
  const [at, as] = a.split('.').slice(0, 2).map(BigInt) as [bigint, bigint];
  const [bt, bs] = b.split('.').slice(0, 2).map(BigInt) as [bigint, bigint];
  if (at !== bt) return at < bt ? -1 : 1;
  return as < bs ? -1 : as > bs ? 1 : 0;
}
