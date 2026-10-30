import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NextBase } from '../src/index.ts';
import { call } from './http.ts';
import { createTestDatabase, type TestDatabase } from './postgres.ts';

interface Sent {
  text: string;
  values: unknown[];
}

/** Wraps `pool` to keep every query sent through it, inside transactions too. */
function recording(pool: pg.Pool): { pool: pg.Pool; sent: Sent[] } {
  const sent: Sent[] = [];
  const record = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        if (prop === 'query') {
          return (config: Sent) => {
            sent.push({ text: config.text, values: config.values ?? [] });
            return value.call(target, config);
          };
        }
        if (prop === 'connect') {
          return async () => record(await value.apply(target));
        }
        return value.bind(target);
      },
    });
  return { pool: record(pool), sent };
}

// The tables are tiny, so Postgres would scan them anyway. Turning scans off
// shows whether an index *can* serve the query.
describe('queries the indexes can serve', () => {
  let t: TestDatabase;
  let nextbase: NextBase;
  let sent: Sent[];

  const plan = async (query: Sent): Promise<string> => {
    const client = await t.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN ${query.text}`,
        query.values,
      );
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  };
  const find = (pattern: RegExp): Sent => {
    const query = sent.find((q) => pattern.test(q.text));
    if (!query) throw new Error(`No query matched ${pattern}.`);
    return query;
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    const recorded = recording(t.pool);
    sent = recorded.sent;
    nextbase = new NextBase({ database: recorded.pool });
    const admin = nextbase.client({ superuser: true });
    const members = await admin.collections.create({
      name: 'members',
      type: 'auth',
      listRule: '',
      viewRule: '',
      fields: [{ id: 'membername', name: 'name', type: 'text' }],
      indexes: [{ name: 'members_name', fields: ['membername'] }],
    });
    await admin.collections.create({
      name: 'notes',
      listRule: '',
      fields: [
        { name: 'tags', type: 'select', values: ['a', 'b'], maxSelect: 2 },
        { name: 'owner', type: 'relation', collectionId: members.id },
      ],
    });
    await admin.collection('members').create({
      email: 'robin@example.com',
      password: 'password 123 456',
      passwordConfirm: 'password 123 456',
    });
  });

  afterAll(async () => {
    // Log entries still waiting would be written to an ended pool.
    await nextbase.flush();
    await t.close();
  });

  it('finds an account by email with the unique email index', async () => {
    sent.length = 0;
    await call(nextbase, 'POST', '/collections/members/auth-with-password', {
      body: { identity: 'Robin@Example.com', password: 'password 123 456' },
    });
    const lookup = find(/lower\("email"\) = lower/);
    expect(await plan(lookup)).toMatch(/Index Scan using _\w+_email /);
  });

  it('filters a multi-value field with its GIN index', async () => {
    sent.length = 0;
    await nextbase
      .client()
      .collection('notes')
      .getList(1, 30, { filter: 'tags ?= "a"', skipTotal: true });
    const list = find(/"tags" @> ARRAY/);
    expect(await plan(list)).toMatch(/Bitmap Index Scan on _\w+_gin /);
  });

  it("filters through a single relation with the related collection's index", async () => {
    sent.length = 0;
    await nextbase
      .client()
      .collection('notes')
      .getList(1, 30, { filter: 'owner.name = "Robin"', skipTotal: true });
    const list = find(/"owner"/);
    expect(await plan(list)).toMatch(/Index Scan (on|using) members_name /);
  });
});
