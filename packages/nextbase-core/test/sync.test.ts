import { type DB, hash } from '@nextbasejs/dbx';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrations.ts';
import { ApiError } from '../src/errors.ts';
import { NextBase } from '../src/index.ts';
import { superusersCollection } from '../src/schema/collection.ts';
import { loadCollections } from '../src/schema/store.ts';
import {
  deleteCollection,
  newCollection,
  updateCollection,
} from '../src/schema/sync.ts';
import { createTestDatabase, endPool, type TestDatabase } from './postgres.ts';

/** Column name → "type" or "type not null", from the catalog. */
async function columns(
  db: DB,
  tableName: string,
): Promise<Record<string, string>> {
  const rows = await db
    .newQuery(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'nextbase' AND table_name = {:name} ORDER BY ordinal_position`,
    )
    .bind({ name: tableName })
    .all<{ column_name: string; data_type: string; is_nullable: string }>();
  return Object.fromEntries(
    rows.map((r) => [
      r.column_name,
      r.data_type + (r.is_nullable === 'NO' ? ' not null' : ''),
    ]),
  );
}

async function indexNames(db: DB, tableName: string): Promise<string[]> {
  return db
    .newQuery(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'nextbase' AND tablename = {:name} ORDER BY 1",
    )
    .bind({ name: tableName })
    .column<string>();
}

async function schemaVersion(db: DB): Promise<number> {
  const [version] = await db
    .newQuery('SELECT schema_version FROM nextbase._meta')
    .column<string>();
  return Number(version);
}

const insert = (
  db: DB,
  tableName: string,
  row: Record<string, unknown>,
): Promise<unknown> => db.insert(`nextbase.${tableName}`, row).execute();

const rows = (db: DB, tableName: string): Promise<Record<string, unknown>[]> =>
  db.select().from(`nextbase.${tableName}`).orderBy('id').all();

const superuser = (id: string, email: string): Record<string, unknown> => ({
  id,
  email,
  password: 'hash',
  tokenKey: `key-${id}`,
});

describe('migrate', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(() => t.close());

  it('creates the system tables and _superusers, once, even when run concurrently', async () => {
    const a = new NextBase({ database: t.pool });
    const b = new NextBase({ database: t.pool });
    await Promise.all([a.migrate(), b.migrate(), migrate(t.db)]);
    await migrate(t.db);

    expect(
      await t.db.select('name').from('nextbase._migrations').column(),
    ).toEqual([
      '0001_init',
      '0002_sessions',
      '0003_parse_timestamptz',
      '0004_view_collections',
      '0005_oauth2',
      '0006_phone',
      '0007_email_verified',
      '0008_uploads',
      '0009_expiry_indexes',
      '0010_realtime',
      '0011_logs',
    ]);
    expect(await schemaVersion(t.db)).toBe(1);

    const [stored] = await loadCollections(t.db);
    const { tokens: _, fields: __, ...expected } = superusersCollection();
    expect(stored).toMatchObject(expected);
    expect(stored?.fields.map((f) => f.name)).toEqual([
      'id',
      'email',
      'emailVisibility',
      'emailVerified',
      'phone',
      'phoneVerified',
      'password',
      'tokenKey',
      'created',
      'updated',
    ]);
    expect(Object.keys(await columns(t.db, '_superusers'))).toEqual(
      stored?.fields.map((f) => f.name),
    );
  });

  it('refuses databases whose settings it cannot work with', async () => {
    const { connectionString } = (
      t.pool as unknown as { options: { connectionString: string } }
    ).options;
    const misconfigured = new pg.Pool({
      connectionString,
      options: '-c DateStyle=SQL,DMY -c standard_conforming_strings=off',
    });
    try {
      await expect(
        new NextBase({ database: misconfigured }).migrate(),
      ).rejects.toThrow(
        /DateStyle is "SQL, DMY".*standard_conforming_strings is off/,
      );
    } finally {
      await endPool(misconfigured);
    }
  });

  it('explains a missing database instead of connecting on construction', async () => {
    vi.stubEnv('DATABASE_URL', '');
    try {
      const nextbase = new NextBase();
      await expect(nextbase.migrate()).rejects.toThrow(/DATABASE_URL/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('schema sync', () => {
  let t: TestDatabase;
  let db: DB;
  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
    await migrate(db);
    await insert(
      db,
      '_superusers',
      superuser('user00000000001', 'a@example.com'),
    );
  });
  afterAll(() => t.close());

  it('creates a table whose columns follow the field types', async () => {
    const before = await schemaVersion(db);
    await newCollection(db, {
      name: 'posts',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'views', type: 'number' },
        { name: 'published', type: 'bool' },
        { name: 'publishedAt', type: 'date' },
        { name: 'meta', type: 'json' },
        { name: 'status', type: 'select', values: ['draft', 'live'] },
        { name: 'tags', type: 'select', values: ['a', 'b', 'c'], maxSelect: 3 },
        { name: 'author', type: 'relation', collectionId: '_superusers' },
        {
          name: 'editors',
          type: 'relation',
          collectionId: '_superusers',
          maxSelect: 5,
        },
        { name: 'cover', type: 'file' },
        { name: 'created', type: 'autodate' },
      ],
    });
    expect(await columns(db, 'posts')).toEqual({
      id: 'text not null',
      title: 'text not null',
      views: 'double precision not null',
      published: 'boolean not null',
      publishedAt: 'timestamp with time zone',
      meta: 'jsonb',
      status: 'text not null',
      tags: 'ARRAY not null',
      author: 'text',
      editors: 'ARRAY not null',
      cover: 'text not null',
      created: 'timestamp with time zone not null',
    });
    expect(await schemaVersion(db)).toBe(before + 1);

    const collection = (await loadCollections(db)).find(
      (c) => c.name === 'posts',
    );
    const fieldId = (name: string): string =>
      collection?.fields.find((f) => f.name === name)?.id ?? '';
    expect(await indexNames(db, 'posts')).toEqual(
      [
        `_${collection?.id}_pkey`,
        `_${collection?.id}_${fieldId('author')}`,
        `_${collection?.id}_${fieldId('editors')}_gin`,
        `_${collection?.id}_${fieldId('tags')}_gin`,
        `_${collection?.id}_${fieldId('created')}_sort`,
      ].sort(),
    );

    // Blank values come from column defaults.
    await insert(db, 'posts', { id: 'post00000000001' });
    expect((await rows(db, 'posts'))[0]).toMatchObject({
      title: '',
      views: 0,
      published: false,
      publishedAt: null,
      meta: null,
      status: '',
      tags: [],
      author: null,
      editors: [],
      cover: '',
    });
  });

  it('enforces record id format and single-relation integrity in the database', async () => {
    await expect(
      insert(db, 'posts', { id: '../etc/passwd00' }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insert(db, 'posts', { id: 'post00000000002', author: 'missing00000000' }),
    ).rejects.toMatchObject({
      code: '23503',
    });
    await insert(db, 'posts', {
      id: 'post00000000002',
      author: 'user00000000001',
    });
  });

  it('gives auth collections case-insensitive unique emails', async () => {
    await newCollection(db, { name: 'users', type: 'auth' });
    await insert(db, 'users', superuser('user00000000001', 'Ann@Example.com'));
    await expect(
      insert(db, 'users', superuser('user00000000002', 'ann@example.com')),
    ).rejects.toMatchObject({
      code: '23505',
    });
    // Blank emails do not collide.
    await insert(db, 'users', superuser('user00000000003', ''));
    await insert(db, 'users', superuser('user00000000004', ''));
  });

  it('renames and swaps columns without losing data', async () => {
    await newCollection(db, {
      name: 'pairs',
      fields: [
        { id: 'aaaaaaaaaa', name: 'a', type: 'text' },
        { id: 'bbbbbbbbbb', name: 'b', type: 'text' },
      ],
    });
    await insert(db, 'pairs', {
      id: 'pair00000000001',
      a: 'first',
      b: 'second',
    });
    await updateCollection(db, 'pairs', {
      fields: [
        { id: 'aaaaaaaaaa', name: 'b', type: 'text' },
        { id: 'bbbbbbbbbb', name: 'a', type: 'text' },
      ],
    });
    expect((await rows(db, 'pairs'))[0]).toMatchObject({
      a: 'second',
      b: 'first',
    });
  });

  it('drops and adds columns, reusing a dropped name, with defaults for existing rows', async () => {
    await updateCollection(db, 'pairs', {
      fields: [
        { id: 'aaaaaaaaaa', name: 'b', type: 'text' },
        { name: 'a', type: 'number' },
      ],
    });
    expect(await columns(db, 'pairs')).toEqual({
      id: 'text not null',
      b: 'text not null',
      a: 'double precision not null',
    });
    expect((await rows(db, 'pairs'))[0]).toMatchObject({ a: 0, b: 'first' });
  });

  it('renames a collection, freeing its old name for a new collection', async () => {
    await updateCollection(db, 'pairs', { name: 'couples' });
    expect(await rows(db, 'couples')).toHaveLength(1);
    await newCollection(db, { name: 'pairs' });
    expect(await columns(db, 'pairs')).toMatchObject({ id: 'text not null' });
  });

  it('converts select, file and relation columns between one value and several', async () => {
    await newCollection(db, {
      name: 'items',
      fields: [
        {
          id: 'status0000',
          name: 'status',
          type: 'select',
          values: ['a', 'b'],
        },
        {
          id: 'owner00000',
          name: 'owner',
          type: 'relation',
          collectionId: '_superusers',
        },
      ],
    });
    await insert(db, 'items', {
      id: 'item00000000001',
      status: 'a',
      owner: 'user00000000001',
    });
    await insert(db, 'items', { id: 'item00000000002' });

    const set = (maxSelect: number): Promise<unknown> =>
      updateCollection(db, 'items', {
        fields: [
          {
            id: 'status0000',
            name: 'status',
            type: 'select',
            values: ['a', 'b'],
            maxSelect,
          },
          {
            id: 'owner00000',
            name: 'owner',
            type: 'relation',
            collectionId: '_superusers',
            maxSelect,
          },
        ],
      });

    await set(2);
    expect(await rows(db, 'items')).toMatchObject([
      { status: ['a'], owner: ['user00000000001'] },
      { status: [], owner: [] },
    ]);

    await db
      .update(
        'nextbase.items',
        { status: ['b', 'a'] },
        hash({ id: 'item00000000001' }),
      )
      .execute();
    await set(1);
    expect(await rows(db, 'items')).toMatchObject([
      { status: 'b', owner: 'user00000000001' },
      { status: '', owner: null },
    ]);
    // The foreign key is back.
    await expect(
      db
        .update(
          'nextbase.items',
          { owner: 'missing00000000' },
          hash({ id: 'item00000000002' }),
        )
        .execute(),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('rolls back the whole change when a DDL step fails', async () => {
    await updateCollection(db, 'items', {
      fields: [
        {
          id: 'owner00000',
          name: 'owner',
          type: 'relation',
          collectionId: '_superusers',
          maxSelect: 2,
        },
      ],
    });
    // Multi-relations have no foreign key, so raw SQL can leave a dangling id;
    // converting back to a single relation then cannot add its foreign key.
    await db
      .update(
        'nextbase.items',
        { owner: ['missing00000000'] },
        hash({ id: 'item00000000002' }),
      )
      .execute();
    const version = await schemaVersion(db);
    const before = (await loadCollections(db)).find((c) => c.name === 'items');

    await expect(
      updateCollection(db, 'items', {
        name: 'renamed',
        fields: [
          {
            id: 'owner00000',
            name: 'owner',
            type: 'relation',
            collectionId: '_superusers',
            maxSelect: 1,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: '23503' });

    expect(
      (await loadCollections(db)).find((c) => c.id === before?.id),
    ).toEqual(before);
    expect(await schemaVersion(db)).toBe(version);
    expect(await columns(db, 'items')).toMatchObject({
      owner: 'ARRAY not null',
    });
  });

  it('creates, changes and drops user indexes', async () => {
    const fields = [{ id: 'titleaaaaa', name: 'title', type: 'text' }];
    await newCollection(db, {
      name: 'notes',
      fields,
      indexes: [{ name: 'notes_title', unique: true, fields: ['titleaaaaa'] }],
    });
    await insert(db, 'notes', { id: 'note00000000001', title: 'x' });
    await expect(
      insert(db, 'notes', { id: 'note00000000002', title: 'x' }),
    ).rejects.toMatchObject({ code: '23505' });

    await updateCollection(db, 'notes', {
      indexes: [{ name: 'notes_title', unique: false, fields: ['titleaaaaa'] }],
    });
    await insert(db, 'notes', { id: 'note00000000002', title: 'x' });
    expect(await indexNames(db, 'notes')).toContain('notes_title');

    await updateCollection(db, 'notes', { indexes: [] });
    expect(await indexNames(db, 'notes')).not.toContain('notes_title');
  });

  it('refuses to delete system or referenced collections, then deletes', async () => {
    await expect(deleteCollection(db, '_superusers')).rejects.toMatchObject({
      status: 400,
    });

    const target = await newCollection(db, { name: 'targets' });
    await newCollection(db, {
      name: 'sources',
      fields: [{ name: 'target', type: 'relation', collectionId: target.id }],
    });
    await expect(deleteCollection(db, 'targets')).rejects.toThrow(
      /sources\.target/,
    );

    await deleteCollection(db, 'sources');
    await deleteCollection(db, target.id);
    const names = (await loadCollections(db)).map((c) => c.name);
    expect(names).not.toContain('targets');
    expect(await columns(db, 'targets')).toEqual({});
  });

  it('reports validation errors and unknown collections without changing anything', async () => {
    const version = await schemaVersion(db);
    await expect(newCollection(db, { name: 'posts' })).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(updateCollection(db, 'nope', {})).rejects.toMatchObject({
      status: 404,
    });
    await expect(deleteCollection(db, 'nope')).rejects.toMatchObject({
      status: 404,
    });
    expect(await schemaVersion(db)).toBe(version);
  });
});
