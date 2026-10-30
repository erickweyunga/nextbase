import type { AuthCollection } from '@nextbasejs/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrations.ts';
import { NextBase } from '../src/index.ts';
import { createTestDatabase, type TestDatabase } from './postgres.ts';

describe('migrating from an older release', () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(() => t.close());

  it('indexes the expiry columns that cleanups delete by', async () => {
    await new NextBase({ database: t.pool }).migrate();
    const names = [
      '_auth_attempts_window_end',
      '_oauth2_states_expires',
      '_phone_codes_expires',
    ];
    // Rewinds to a release before the indexes.
    for (const name of names) {
      await t.pool.query(`DROP INDEX nextbase."${name}"`);
    }
    await t.pool.query(
      "DELETE FROM nextbase._migrations WHERE name = '0009_expiry_indexes'",
    );
    await migrate(t.db);
    const { rows } = await t.pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'nextbase' AND indexname = ANY($1) ORDER BY indexname",
      [names],
    );
    expect(rows.map((r) => r.indexname)).toEqual(names);
  });

  it('renames verified to emailVerified, in the table, the field and the rules that use it', async () => {
    const before = new NextBase({ database: t.pool });
    const admin = before.client({ superuser: true });
    await admin.collections.create({ name: 'users', type: 'auth' });
    const users = await admin.collections.getOne('users');
    await admin.collections.create({
      name: 'posts',
      type: 'base',
      fields: [
        { name: 'author', type: 'relation', collectionId: users.id },
        // Not the auth field: stays as it is.
        { name: 'verified', type: 'bool' },
      ],
    });
    const record = await admin.collection('users').create({
      email: 'ann@example.com',
      password: 'password 123 456',
      passwordConfirm: 'password 123 456',
      emailVerified: true,
    });
    if (!record) throw new Error('A superuser views every record.');

    // Rewinds to how a release before the rename stored things.
    const rules = {
      users: {
        authRule: 'verified = true',
        view_rule: '@request.auth.verified = true',
      },
      posts: { list_rule: 'author.verified = true && verified = true' },
    };
    await t.pool.query(
      `ALTER TABLE nextbase.users RENAME COLUMN "emailVerified" TO "verified"`,
    );
    await t.pool.query(
      `UPDATE nextbase._collections
       SET fields = (SELECT jsonb_agg(CASE WHEN f->>'id' = '_verified' THEN jsonb_set(f, '{name}', '"verified"') ELSE f END) FROM jsonb_array_elements(fields) f),
           options = jsonb_set(options, '{authRule}', to_jsonb($1::text)),
           view_rule = $2
       WHERE name = 'users'`,
      [rules.users.authRule, rules.users.view_rule],
    );
    await t.pool.query(
      "UPDATE nextbase._collections SET list_rule = $1 WHERE name = 'posts'",
      [rules.posts.list_rule],
    );
    await t.pool.query(
      "DELETE FROM nextbase._migrations WHERE name = '0007_email_verified'",
    );

    await migrate(t.db);
    const after = new NextBase({ database: t.pool }).client({
      superuser: true,
    });
    const upgraded = (await after.collections.getOne(
      'users',
    )) as AuthCollection;
    expect(upgraded.fields.find((f) => f.id === '_verified')?.name).toBe(
      'emailVerified',
    );
    expect(upgraded.authRule).toBe('emailVerified = true');
    expect(upgraded.viewRule).toBe('@request.auth.emailVerified = true');
    expect((await after.collections.getOne('posts')).listRule).toBe(
      'author.emailVerified = true && verified = true',
    );
    expect(
      (await after.collection('users').getOne(record.id)).emailVerified,
    ).toBe(true);
  });
});
