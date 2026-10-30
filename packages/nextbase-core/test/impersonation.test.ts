import { NextBaseClient } from '@nextbasejs/client';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CookieStore, NextBase } from '../src/index.ts';
import { timings } from '../src/realtime/timings.ts';
import { call, origin, type Reply } from './http.ts';
import { createTestDatabase, type TestDatabase } from './postgres.ts';
import { waitFor } from './wait.ts';

const PASSWORD = 'password 123 456';
const ADMIN_PASSWORD = 'admin password!';
const HOUR = 3600;

/** Cookies as Next.js's `cookies()` keeps them, for `client({ cookies })`. */
class Cookies implements CookieStore {
  readonly values = new Map<string, { value: string; maxAge: number }>();
  get(name: string): { value: string } | undefined {
    const cookie = this.values.get(name);
    return cookie && cookie.maxAge > 0 ? cookie : undefined;
  }
  set(name: string, value: string, options: { maxAge: number }): void {
    this.values.set(name, { value, maxAge: options.maxAge });
  }
}

interface Stream {
  /** The topic each record event came for, as `"0"` for the first. */
  topics: () => string[];
  ended: () => boolean;
  last: () => Record<string, unknown> | undefined;
  close: () => Promise<void>;
}

describe('impersonation', () => {
  const defaults = { ...timings };
  let t: TestDatabase;
  let nextbase: NextBase;
  let admin = '';
  let adminId = '';
  const ids = { ann: '', bob: '', max: '', locked: '', team: '' };
  const hooked: string[] = [];
  const pending: Promise<unknown>[] = [];

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
    collection: string,
    email: string,
    password = PASSWORD,
  ): Promise<{ token: string; id: string }> => {
    const reply = await call(
      nextbase,
      'POST',
      `/collections/${collection}/auth-with-password`,
      { body: { identity: email, password } },
    );
    expect(reply.status).toBe(200);
    return {
      token: reply.body.token as string,
      id: (reply.body.record as { id: string }).id,
    };
  };

  const impersonate = (
    id: string,
    {
      token = admin,
      body = {},
      collection = 'users',
      query = '',
    }: {
      token?: string;
      body?: unknown;
      collection?: string;
      query?: string;
    } = {},
  ): Promise<Reply> =>
    call(
      nextbase,
      'POST',
      `/collections/${collection}/impersonate/${id}${query}`,
      { token, body },
    );

  /** An impersonation token for `id`, from `admin` unless given. */
  const actAs = async (id: string, token = admin): Promise<string> => {
    const reply = await impersonate(id, { token });
    expect(reply.status).toBe(200);
    return reply.body.token as string;
  };

  const status = async (token: string): Promise<number> =>
    (await call(nextbase, 'GET', '/session', { token })).status;

  const newSuperuser = async (
    email: string,
  ): Promise<{ token: string; id: string }> => {
    await nextbase.createSuperuser(email, ADMIN_PASSWORD);
    return login('_superusers', email, ADMIN_PASSWORD);
  };

  const sessionRow = async (
    id: string,
  ): Promise<{ expires: Date; impersonator_id: string | null }> => {
    const { rows } = await t.pool.query(
      'SELECT expires, impersonator_id FROM nextbase._sessions WHERE id = $1',
      [id],
    );
    return rows[0];
  };

  /** Opens a realtime stream and collects its record events. */
  const subscribe = async (
    token: string,
    topics: Record<string, unknown>[],
  ): Promise<Stream> => {
    const controller = new AbortController();
    const response = await nextbase.handle(
      new Request(`${origin}/api/nextbase/realtime`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ topics }),
        signal: controller.signal,
      }),
    );
    expect(response.status).toBe(200);
    const messages: { type: string; data?: Record<string, unknown> }[] = [];
    let ended = false;
    const reading = (async () => {
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
          const message: (typeof messages)[number] = { type: '' };
          for (const line of buffer.slice(0, end).split('\n')) {
            const [field, ...rest] = line.split(': ');
            if (field === 'event') message.type = rest.join(': ');
            if (field === 'data') message.data = JSON.parse(rest.join(': '));
          }
          messages.push(message);
          buffer = buffer.slice(end + 2);
          end = buffer.indexOf('\n\n');
        }
      }
    })().finally(() => {
      ended = true;
    });
    await waitFor(() => messages.length > 0, 'the stream to start');
    return {
      topics: () =>
        messages
          .filter((m) => m.type === 'create')
          .flatMap((m) => Object.keys(m.data?.topics ?? {})),
      ended: () => ended,
      last: () => messages.at(-1),
      close: async () => {
        controller.abort();
        await reading.catch(() => {});
      },
    };
  };

  beforeAll(async () => {
    Object.assign(timings, { pollMs: 30, heartbeatMs: 100, sessionMs: 50 });
    t = await createTestDatabase();
    nextbase = new NextBase({
      database: t.pool,
      // Tests sign in many times a second; rate limits have their own tests.
      rateLimits: false,
      appUrl: origin,
      oauth2: { google: { clientId: 'client', clientSecret: 'secret' } },
      waitUntil: (promise) => pending.push(promise),
      realtime: { collections: ['notes', 'secrets'], listenUrl: t.url },
      hooks: {
        users: {
          beforeUpdate: (e) => {
            hooked.push(e.principal.impersonatedBy ?? '');
          },
        },
      },
    });
    ({ token: admin, id: adminId } = await newSuperuser('admin@example.com'));
    const su = nextbase.client({ superuser: true });
    const team = await su.collections.create({
      name: 'teams',
      viewRule: '',
      fields: [{ name: 'name', type: 'text' }],
    });
    await su.collections.create({
      name: 'users',
      type: 'auth',
      createRule: '',
      viewRule: 'id = @request.auth.id || @request.auth.name = "manager"',
      listRule: 'id = @request.auth.id',
      updateRule: 'id = @request.auth.id || @request.auth.name = "manager"',
      deleteRule: 'id = @request.auth.id',
      manageRule: '@request.auth.name = "manager"',
      phoneSignIn: true,
      identityFields: ['email', 'username'],
      fields: [
        { name: 'name', type: 'text' },
        { id: 'usernamefd', name: 'username', type: 'text' },
        { name: 'team', type: 'relation', collectionId: team.id },
      ],
      indexes: [
        { name: 'users_username', unique: true, fields: ['usernamefd'] },
      ],
    });
    await su.collections.create({
      name: 'locked',
      type: 'auth',
      authRule: null,
    });
    await su.collections.create({
      name: 'notes',
      listRule: '@request.auth.id != ""',
      viewRule: '@request.auth.id != ""',
      createRule: '@request.auth.id != "" && @request.impersonatedBy = ""',
      fields: [{ name: 'text', type: 'text' }],
    });
    await su.collections.create({
      name: 'secrets',
      listRule: '@request.auth.id != "" && @request.impersonatedBy = ""',
      viewRule: '@request.auth.id != "" && @request.impersonatedBy = ""',
      fields: [{ name: 'text', type: 'text' }],
    });
    ids.team = (await su.collection('teams').create({ name: 'Red' }))
      ?.id as string;
    for (const [key, name] of [
      ['ann', 'ann'],
      ['bob', 'bob'],
      ['max', 'manager'],
    ] as const) {
      const record = await su.collection('users').create({
        email: `${key}@example.com`,
        username: key,
        name,
        team: ids.team,
        password: PASSWORD,
        passwordConfirm: PASSWORD,
      });
      ids[key] = record?.id as string;
    }
    ids.locked = (
      await su.collection('locked').create({
        email: 'locked@example.com',
        password: PASSWORD,
        passwordConfirm: PASSWORD,
      })
    )?.id as string;
    await su.collection('secrets').create({ text: 'hidden' });
  });
  afterAll(async () => {
    Object.assign(timings, defaults);
    while (pending.length > 0) await Promise.all(pending.splice(0));
    // Log entries still waiting would be written to an ended pool.
    await nextbase.flush();
    await t.close();
  });

  describe('starting', () => {
    it('is for signed-in superusers only', async () => {
      expect((await impersonate(ids.ann, { token: '' })).status).toBe(401);
      const { token: bob } = await login('users', 'bob@example.com');
      const byUser = await impersonate(ids.ann, { token: bob });
      expect(byUser.status).toBe(403);
      expect(byUser.body.message).toBe('Only superusers can do this.');
      // Server code has no superuser to act for the record.
      const reply = await nextbase
        .client({ superuser: true })
        .send(`/collections/users/impersonate/${ids.ann}`, { method: 'POST' })
        .catch((error: { status: number; message: string }) => error);
      expect(reply).toMatchObject({
        status: 403,
        message: 'Sign in as a superuser to impersonate.',
      });
    });

    it('is a 404 for other collections and missing records, a 403 for superusers', async () => {
      const notAuth = await impersonate(ids.team, { collection: 'teams' });
      expect(notAuth.status).toBe(404);
      expect(notAuth.body.message).toBe('Collection not found.');
      expect((await impersonate(ids.ann, { collection: 'nope' })).status).toBe(
        404,
      );
      const missing = await impersonate('aaaaaaaaaaaaaaa');
      expect(missing.status).toBe(404);
      expect(missing.body.message).toBe('Record not found.');
      const superuser = await impersonate(adminId, {
        collection: '_superusers',
      });
      expect(superuser.status).toBe(403);
      expect(superuser.body.message).toBe('Superusers cannot be impersonated.');
    });

    it('skips the auth rule', async () => {
      const signIn = await call(
        nextbase,
        'POST',
        '/collections/locked/auth-with-password',
        { body: { identity: 'locked@example.com', password: PASSWORD } },
      );
      expect(signIn.status).toBe(403);
      const reply = await impersonate(ids.locked, { collection: 'locked' });
      expect(reply.status).toBe(200);
      const session = await call(nextbase, 'GET', '/session', {
        token: reply.body.token as string,
      });
      expect(session.body).toMatchObject({
        impersonatedBy: adminId,
        record: { id: ids.locked },
      });
    });

    it('answers like a sign-in, with the session', async () => {
      const reply = await impersonate(ids.ann);
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({
        token: expect.any(String),
        record: { id: ids.ann, email: 'ann@example.com', name: 'ann' },
        session: { impersonatedBy: adminId, current: false, userAgent: '' },
      });
      const session = reply.body.session as { id: string; expires: string };
      const left = Date.parse(session.expires) - Date.now();
      expect(left).toBeGreaterThan((HOUR - 60) * 1000);
      expect(left).toBeLessThanOrEqual(HOUR * 1000);
      expect((await sessionRow(session.id)).impersonator_id).toBe(adminId);
      // The superuser stays signed in as themselves.
      const own = await call(nextbase, 'GET', '/session', { token: admin });
      expect(own.body).toMatchObject({ record: { id: adminId } });
      expect(own.body).not.toHaveProperty('impersonatedBy');
    });

    it('checks the duration', async () => {
      for (const duration of [59, 3601, 1.5, '600', null, -1]) {
        const reply = await impersonate(ids.ann, { body: { duration } });
        expect(reply.status).toBe(400);
        expect(reply.body.data).toEqual({
          duration: {
            code: 'validation_invalid_value',
            message: 'Must be a whole number of seconds from 60 to 3600.',
          },
        });
      }
      const reply = await impersonate(ids.ann, { body: { duration: 60 } });
      expect(reply.status).toBe(200);
      const { expires } = reply.body.session as { expires: string };
      const left = Date.parse(expires) - Date.now();
      expect(left).toBeGreaterThan(55_000);
      expect(left).toBeLessThanOrEqual(60_000);
    });

    it('returns the record with expand and fields, seen as the record', async () => {
      const expanded = await impersonate(ids.ann, { query: '?expand=team' });
      expect(expanded.body.record).toMatchObject({
        expand: { team: { id: ids.team, name: 'Red' } },
      });
      const picked = await impersonate(ids.ann, { query: '?fields=id,name' });
      expect(picked.body.record).toEqual({ id: ids.ann, name: 'ann' });
      // A refused expand starts no session.
      const before = await t.pool.query(
        'SELECT count(*)::int AS n FROM nextbase._sessions',
      );
      const refused = await impersonate(ids.ann, {
        query: '?expand=a.b.c.d.e.f.g',
      });
      expect(refused.status).toBe(400);
      const after = await t.pool.query(
        'SELECT count(*)::int AS n FROM nextbase._sessions',
      );
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    it('is logged, unless logs are off', async () => {
      const reply = await impersonate(ids.bob, { body: { duration: 120 } });
      const session = reply.body.session as { id: string; expires: string };
      await nextbase.flush();
      const { rows } = await t.pool.query(
        "SELECT level, message, data FROM nextbase._logs WHERE data->>'type' = 'impersonate' AND data->>'sessionId' = $1",
        [session.id],
      );
      expect(rows).toEqual([
        {
          level: 0,
          message: 'Impersonation started',
          data: {
            type: 'impersonate',
            superuserId: adminId,
            collection: 'users',
            recordId: ids.bob,
            sessionId: session.id,
            expires: session.expires,
          },
        },
      ]);

      // Requests the session makes say who made them, too.
      await call(nextbase, 'GET', '/collections/notes/records', {
        token: reply.body.token as string,
      });
      await nextbase.flush();
      const { rows: requests } = await t.pool.query(
        "SELECT data FROM nextbase._logs WHERE data->>'type' = 'request' AND data->>'url' LIKE '%/collections/notes/records'",
      );
      expect(requests.map((r) => r.data)).toContainEqual(
        expect.objectContaining({ auth: 'users', impersonatedBy: adminId }),
      );

      const silent = new NextBase({
        database: t.pool,
        logs: false,
        rateLimits: false,
      });
      const quiet = await call(
        silent,
        'POST',
        `/collections/users/impersonate/${ids.bob}`,
        { token: admin, body: {} },
      );
      expect(quiet.status).toBe(200);
      await silent.flush();
      const { rows: none } = await t.pool.query(
        "SELECT 1 FROM nextbase._logs WHERE data->>'sessionId' = $1",
        [(quiet.body.session as { id: string }).id],
      );
      expect(none).toEqual([]);
    });
  });

  describe('the session', () => {
    it('shows as impersonated to the record, which can revoke it', async () => {
      const { token: ann } = await login('users', 'ann@example.com');
      const reply = await impersonate(ids.ann);
      const id = (reply.body.session as { id: string }).id;
      const listed = await call(nextbase, 'GET', '/sessions', { token: ann });
      const items = listed.body.items as Record<string, unknown>[];
      expect(items.find((s) => s.id === id)).toMatchObject({
        impersonatedBy: adminId,
        current: false,
      });
      expect(items.find((s) => s.current)).not.toHaveProperty('impersonatedBy');
      // The impersonation sees the same list, and itself as current.
      const seen = await call(nextbase, 'GET', '/sessions', {
        token: reply.body.token as string,
      });
      expect(
        (seen.body.items as Record<string, unknown>[]).find((s) => s.current),
      ).toMatchObject({ id, impersonatedBy: adminId });

      expect(
        (await call(nextbase, 'DELETE', `/sessions/${id}`, { token: ann }))
          .status,
      ).toBe(204);
      expect(await status(reply.body.token as string)).toBe(401);
      // Revoking every other session ends it too.
      const again = await actAs(ids.ann);
      await call(nextbase, 'DELETE', '/sessions', { token: ann });
      expect(await status(again)).toBe(401);
    });

    it('ends on time and is never extended', async () => {
      const reply = await impersonate(ids.ann);
      const token = reply.body.token as string;
      const id = (reply.body.session as { id: string }).id;
      // Due for an extension, as a session with this little time left would be.
      await t.pool.query(
        "UPDATE nextbase._sessions SET expires = now() + interval '10 minutes', created = now() - interval '1 hour' WHERE id = $1",
        [id],
      );
      const before = (await sessionRow(id)).expires;
      const response = await raw('GET', '/session', {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      expect((await sessionRow(id)).expires).toEqual(before);
      // An ordinary session in the same state is extended, so the check above means something.
      const { token: ann } = await login('users', 'ann@example.com');
      const own = (await call(nextbase, 'GET', '/session', { token: ann })).body
        .id as string;
      await t.pool.query(
        "UPDATE nextbase._sessions SET expires = now() + interval '10 minutes', created = now() - interval '1 hour' WHERE id = $1",
        [own],
      );
      const ownBefore = (await sessionRow(own)).expires;
      await call(nextbase, 'GET', '/session', { token: ann });
      expect((await sessionRow(own)).expires.getTime()).toBeGreaterThan(
        ownBefore.getTime(),
      );

      const refresh = await call(
        nextbase,
        'POST',
        '/collections/users/auth-refresh',
        { token },
      );
      expect(refresh.status).toBe(403);
      expect(refresh.body.message).toBe(
        'Impersonation sessions cannot be refreshed.',
      );
      expect((await sessionRow(id)).expires).toEqual(before);

      await t.pool.query(
        "UPDATE nextbase._sessions SET expires = now() - interval '1 second' WHERE id = $1",
        [id],
      );
      expect(await status(token)).toBe(401);
    });

    it('ends once its superuser is deleted or changes their password', async () => {
      const other = await newSuperuser('other@example.com');
      const token = await actAs(ids.ann, other.token);
      const reply = await call(
        nextbase,
        'PATCH',
        `/collections/_superusers/records/${other.id}`,
        {
          token: other.token,
          body: {
            password: 'a new password 1',
            passwordConfirm: 'a new password 1',
          },
        },
      );
      expect(reply.status).toBe(200);
      expect(await status(token)).toBe(401);
      // Their own session goes on.
      expect(await status(other.token)).toBe(200);

      const again = await actAs(ids.ann, other.token);
      expect(await status(again)).toBe(200);
      expect(
        (
          await call(
            nextbase,
            'DELETE',
            `/collections/_superusers/records/${other.id}`,
            { token: admin },
          )
        ).status,
      ).toBe(204);
      expect(await status(again)).toBe(401);
    });

    it("ends when the record's key changes", async () => {
      const token = await actAs(ids.bob);
      const reply = await call(
        nextbase,
        'PATCH',
        `/collections/users/records/${ids.bob}`,
        {
          token: admin,
          body: { password: PASSWORD, passwordConfirm: PASSWORD },
        },
      );
      expect(reply.status).toBe(200);
      expect(await status(token)).toBe(401);
    });

    it('can do what the record can, as it', async () => {
      const token = await actAs(ids.ann);
      const updated = await call(
        nextbase,
        'PATCH',
        `/collections/users/records/${ids.ann}`,
        { token, body: { name: 'ann' } },
      );
      expect(updated.status).toBe(200);
      const list = await call(nextbase, 'GET', '/collections/notes/records', {
        token,
      });
      expect(list.status).toBe(200);
      // Signing out ends it.
      expect(
        (await call(nextbase, 'DELETE', '/session', { token })).status,
      ).toBe(204);
      expect(await status(token)).toBe(401);
    });

    it('lets rules tell, through @request.impersonatedBy', async () => {
      const token = await actAs(ids.ann);
      const { token: ann } = await login('users', 'ann@example.com');
      const secrets = (who: string) =>
        call(nextbase, 'GET', '/collections/secrets/records', { token: who });
      expect((await secrets(ann)).body.totalItems).toBe(1);
      expect((await secrets(token)).body.totalItems).toBe(0);
      const create = (who: string) =>
        call(nextbase, 'POST', '/collections/notes/records', {
          token: who,
          body: { text: 'hi' },
        });
      expect((await create(ann)).status).toBe(200);
      expect((await create(token)).status).toBe(400);
    });

    it('checks @request.impersonatedBy like @request.method', async () => {
      const su = nextbase.client({ superuser: true });
      const refused = await su.collections
        .create({ name: 'odd', listRule: '@request.impersonatedBy:lower = ""' })
        .catch((error: { status: number }) => error);
      expect(refused).toMatchObject({ status: 400 });
      // Filters read no @request values, whoever sends them.
      const token = await actAs(ids.ann);
      const filtered = await call(
        nextbase,
        'GET',
        `/collections/notes/records?filter=${encodeURIComponent('@request.impersonatedBy = ""')}`,
        { token },
      );
      expect(filtered.status).toBe(400);
    });

    it('tells hooks who is acting', async () => {
      const token = await actAs(ids.ann);
      const { token: ann } = await login('users', 'ann@example.com');
      hooked.length = 0;
      for (const who of [token, ann]) {
        await call(nextbase, 'PATCH', `/collections/users/records/${ids.ann}`, {
          token: who,
          body: { name: 'ann' },
        });
      }
      expect(hooked).toEqual([adminId, '']);
    });

    it('gets realtime events as the record, until the superuser goes', async () => {
      const other = await newSuperuser('live@example.com');
      const token = await actAs(ids.ann, other.token);
      const stream = await subscribe(token, [
        { collection: 'notes' },
        { collection: 'secrets' },
      ]);
      try {
        const su = nextbase.client({ superuser: true });
        await su.collection('secrets').create({ text: 'unseen' });
        await su.collection('notes').create({ text: 'seen' });
        await waitFor(() => stream.topics().length > 0, 'the note');
        expect(stream.topics()).toEqual(['0']);
        await call(
          nextbase,
          'DELETE',
          `/collections/_superusers/records/${other.id}`,
          { token: admin },
        );
        await waitFor(stream.ended, 'the stream to end');
        expect(stream.last()).toEqual({
          type: 'end',
          data: { reason: 'signed_out' },
        });
      } finally {
        await stream.close();
      }
    });
  });

  describe('cannot leave a way back in', () => {
    const forbidden = (reply: Reply, action: string): void => {
      expect(reply.status).toBe(403);
      expect(reply.body.message).toBe(
        `Impersonation sessions cannot ${action}.`,
      );
    };

    it('changes no password, email, phone or identity, of any account', async () => {
      const token = await actAs(ids.max);
      const patch = (id: string, body: Record<string, unknown>) =>
        call(nextbase, 'PATCH', `/collections/users/records/${id}`, {
          token,
          body,
        });
      const changes: Record<string, unknown>[] = [
        {
          oldPassword: PASSWORD,
          password: 'a new password 1',
          passwordConfirm: 'a new password 1',
        },
        { password: PASSWORD, passwordConfirm: PASSWORD },
        { email: 'max2@example.com' },
        { emailVerified: true },
        { phone: '+255712345678' },
        { phoneVerified: true },
        { username: 'maxi' },
      ];
      const { rows: before } = await t.pool.query(
        'SELECT * FROM nextbase.users ORDER BY id',
      );
      // Its own record, and one it manages.
      for (const id of [ids.max, ids.bob]) {
        for (const body of changes) {
          forbidden(await patch(id, body), 'change sign-in details');
        }
      }
      const { rows: after } = await t.pool.query(
        'SELECT * FROM nextbase.users ORDER BY id',
      );
      expect(after).toEqual(before);
      // Unchanged values and other fields are fine.
      expect(
        (await patch(ids.bob, { email: 'bob@example.com', username: 'bob' }))
          .status,
      ).toBe(200);
      expect((await patch(ids.bob, { name: 'bob' })).status).toBe(200);
      // A batch is refused the same way.
      const batch = await call(nextbase, 'POST', '/batch', {
        token,
        body: {
          requests: [
            {
              method: 'PATCH',
              url: `/collections/users/records/${ids.max}`,
              body: { username: 'maxi' },
            },
          ],
        },
      });
      expect(batch.status).toBe(400);
      expect(batch.body.message).toBe(
        'Request 1 of the batch failed with 403: Impersonation sessions cannot change sign-in details. Nothing was saved.',
      );
      expect(await status(token)).toBe(200);
    });

    it('uses no account flow', async () => {
      const token = await actAs(ids.ann);
      for (const flow of [
        'request-email-verification',
        'confirm-email-verification',
        'request-password-reset',
        'confirm-password-reset',
        'request-email-change',
        'confirm-email-change',
        'request-phone-code',
        'request-password-reset-by-phone',
        'confirm-password-reset-by-phone',
        'request-phone-verification',
        'confirm-phone-verification',
      ]) {
        forbidden(
          await call(nextbase, 'POST', `/collections/users/${flow}`, {
            token,
            body: {
              email: 'ann@example.com',
              newEmail: 'ann2@example.com',
              phone: '+255712345678',
            },
          }),
          'change sign-in details',
        );
      }
    });

    it('links and unlinks no provider', async () => {
      const token = await actAs(ids.ann);
      forbidden(
        await call(
          nextbase,
          'GET',
          '/collections/users/auth-with-oauth2/google?link=true&redirect=/',
          { token, headers: { origin } },
        ),
        'link a provider',
      );
      forbidden(
        await call(
          nextbase,
          'DELETE',
          `/collections/users/records/${ids.ann}/linked-accounts/google`,
          { token },
        ),
        'unlink a provider',
      );
      // Listing them is fine.
      expect(
        (
          await call(
            nextbase,
            'GET',
            `/collections/users/records/${ids.ann}/linked-accounts`,
            { token },
          )
        ).status,
      ).toBe(200);
    });

    it('revokes no other session and starts no new one', async () => {
      const { token: ann } = await login('users', 'ann@example.com');
      const token = await actAs(ids.ann);
      const others = await call(nextbase, 'GET', '/sessions', { token: ann });
      const own = (
        others.body.items as { id: string; current: boolean }[]
      ).find((s) => s.current)?.id as string;
      forbidden(
        await call(nextbase, 'DELETE', '/sessions', { token }),
        'revoke other sessions',
      );
      forbidden(
        await call(nextbase, 'DELETE', `/sessions/${own}`, { token }),
        'revoke other sessions',
      );
      expect(await status(ann)).toBe(200);
      forbidden(
        await call(nextbase, 'POST', '/collections/users/auth-refresh', {
          token,
        }),
        'be refreshed',
      );
      forbidden(await impersonate(ids.bob, { token }), 'impersonate');
      expect(await status(token)).toBe(200);
    });

    it('gets file tokens that end with the session', async () => {
      const reply = await impersonate(ids.ann, { body: { duration: 60 } });
      const file = await call(nextbase, 'POST', '/files/token', {
        token: reply.body.token as string,
      });
      const { exp, iat } = decodeJwt(file.body.token as string);
      expect((exp as number) - (iat as number)).toBeLessThanOrEqual(60);
      const { token: ann } = await login('users', 'ann@example.com');
      const ownFile = await call(nextbase, 'POST', '/files/token', {
        token: ann,
      });
      const claims = decodeJwt(ownFile.body.token as string);
      expect((claims.exp as number) - (claims.iat as number)).toBe(120);
    });
  });

  describe('with a cookie', () => {
    const cookieOf = (response: Response, name: string): string | undefined =>
      response.headers
        .getSetCookie()
        .find((c) => c.startsWith(`${name}=`))
        ?.split(';')[0]
        ?.slice(name.length + 1);

    const superuserCookie = async (): Promise<string> => {
      const response = await raw(
        'POST',
        '/collections/_superusers/auth-with-password',
        {
          headers: { origin },
          body: {
            identity: 'admin@example.com',
            password: ADMIN_PASSWORD,
            cookie: true,
          },
        },
      );
      expect(response.status).toBe(200);
      return cookieOf(response, 'nextbase_session') as string;
    };

    const startCookie = async (
      su: string,
    ): Promise<{ response: Response; session: string }> => {
      const response = await raw(
        'POST',
        `/collections/users/impersonate/${ids.ann}`,
        {
          headers: { origin, cookie: `nextbase_session=${su}` },
          body: { cookie: true },
        },
      );
      expect(response.status).toBe(200);
      return {
        response,
        session: cookieOf(response, 'nextbase_session') as string,
      };
    };

    it('keeps the superuser session aside and restores it on sign-out', async () => {
      const su = await superuserCookie();
      const { response, session } = await startCookie(su);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty('token');
      expect(body).toMatchObject({
        record: { id: ids.ann },
        session: { impersonatedBy: adminId },
      });
      expect(cookieOf(response, 'nextbase_impersonator')).toBe(su);
      expect(session).not.toBe(su);
      const kept = response.headers
        .getSetCookie()
        .find((c) => c.startsWith('nextbase_impersonator='));
      expect(kept).toContain('HttpOnly');
      expect(Number(/Max-Age=(\d+)/.exec(kept ?? '')?.[1])).toBeGreaterThan(
        HOUR - 60,
      );

      const current = await raw('GET', '/session', {
        headers: { cookie: `nextbase_session=${session}` },
      });
      expect(await current.json()).toMatchObject({
        impersonatedBy: adminId,
        record: { id: ids.ann },
      });

      const out = await raw('DELETE', '/session', {
        headers: {
          origin,
          cookie: `nextbase_session=${session}; nextbase_impersonator=${su}`,
        },
      });
      expect(out.status).toBe(204);
      expect(cookieOf(out, 'nextbase_session')).toBe(su);
      expect(cookieOf(out, 'nextbase_impersonator')).toBe('');
      const back = await raw('GET', '/session', {
        headers: { cookie: `nextbase_session=${su}` },
      });
      expect(await back.json()).toMatchObject({ record: { id: adminId } });
    });

    it('restores no session that ended or is not the impersonator', async () => {
      const su = await superuserCookie();
      const { session } = await startCookie(su);
      // The kept session ended meanwhile.
      await raw('DELETE', '/session', {
        headers: { origin, cookie: `nextbase_session=${su}` },
      });
      const out = await raw('DELETE', '/session', {
        headers: {
          origin,
          cookie: `nextbase_session=${session}; nextbase_impersonator=${su}`,
        },
      });
      expect(cookieOf(out, 'nextbase_session')).toBe('');
      expect(cookieOf(out, 'nextbase_impersonator')).toBe('');

      // A session of someone else in the cookie is not taken.
      const su2 = await superuserCookie();
      const second = await startCookie(su2);
      const { token: bob } = await login('users', 'bob@example.com');
      const planted = await raw('DELETE', '/session', {
        headers: {
          origin,
          cookie: `nextbase_session=${second.session}; nextbase_impersonator=${bob}`,
        },
      });
      expect(cookieOf(planted, 'nextbase_session')).toBe('');
      expect(await status(bob)).toBe(200);
    });

    it('is refused from another site', async () => {
      const su = await superuserCookie();
      const response = await raw(
        'POST',
        `/collections/users/impersonate/${ids.ann}`,
        {
          headers: {
            origin: 'https://evil.example',
            'sec-fetch-site': 'cross-site',
            authorization: `Bearer ${admin}`,
            cookie: `nextbase_session=${su}`,
          },
          body: { cookie: true },
        },
      );
      expect(response.status).toBe(403);
    });

    it('is not renewed, and a token impersonation leaves the cookie alone', async () => {
      const su = await superuserCookie();
      const { session } = await startCookie(su);
      const row = await t.pool.query(
        'SELECT id FROM nextbase._sessions WHERE impersonator_id IS NOT NULL ORDER BY created DESC LIMIT 1',
      );
      await t.pool.query(
        "UPDATE nextbase._sessions SET expires = now() + interval '10 minutes' WHERE id = $1",
        [row.rows[0].id],
      );
      const read = await raw('GET', '/session', {
        headers: { cookie: `nextbase_session=${session}` },
      });
      expect(read.headers.getSetCookie()).toEqual([]);

      // A token impersonation from the same browser signs out by itself.
      const token = await actAs(ids.ann);
      const out = await raw('DELETE', '/session', {
        headers: {
          authorization: `Bearer ${token}`,
          cookie: `nextbase_session=${su}`,
        },
      });
      expect(out.status).toBe(204);
      expect(out.headers.getSetCookie()).toEqual([]);
      expect(await status(token)).toBe(401);
    });
  });

  describe('client', () => {
    it('returns a client signed in as the record, leaving its own store alone', async () => {
      const nb = new NextBaseClient({
        baseUrl: `${origin}/api/nextbase`,
        fetch: (input, init) => nextbase.handle(new Request(input, init)),
      });
      await nb
        .collection('_superusers')
        .signInWithPassword('admin@example.com', ADMIN_PASSWORD);
      const { token } = nb.authStore;
      const result = await nb
        .collection('users')
        .impersonate(ids.ann, { duration: 600, fields: 'id,email' });
      expect(result.record).toEqual({ id: ids.ann, email: 'ann@example.com' });
      expect(result.session.impersonatedBy).toBe(adminId);
      expect(nb.authStore.token).toBe(token);
      expect(nb.authStore.record?.id).toBe(adminId);
      expect(result.client.authStore.token).toBe(result.token);
      expect(result.client.authStore.record?.id).toBe(ids.ann);
      const session = await result.client.getSession();
      expect(session?.impersonatedBy).toBe(adminId);
      expect(session?.record.id).toBe(ids.ann);
      await result.client.signOut();
      expect(result.client.authStore.isValid).toBe(false);
      expect((await nb.getSession())?.record.id).toBe(adminId);
    });

    it('swaps the cookie session in cookie mode, and back on sign-out', async () => {
      const cookies = new Cookies();
      const nb = nextbase.client({ cookies });
      await nb
        .collection('_superusers')
        .signInWithPassword('admin@example.com', ADMIN_PASSWORD, {
          cookie: true,
        });
      const su = cookies.get('nextbase_session')?.value;
      const result = await nb
        .collection('users')
        .impersonate(ids.ann, { cookie: true });
      expect(result).not.toHaveProperty('client');
      expect(result).not.toHaveProperty('token');
      expect(nb.authStore.record?.id).toBe(ids.ann);
      expect(cookies.get('nextbase_impersonator')?.value).toBe(su);
      expect((await nb.getSession())?.impersonatedBy).toBe(adminId);
      await nb.signOut();
      expect(cookies.get('nextbase_session')?.value).toBe(su);
      expect(cookies.get('nextbase_impersonator')).toBeUndefined();
      expect((await nb.getSession())?.record.id).toBe(adminId);
    });
  });
});
