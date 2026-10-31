import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClientError, type NextBaseClient } from '@nextbasejs/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Io, run } from '../src/cli/run.ts';
import { type Migration, type Migrations, NextBase } from '../src/index.ts';
import { migrationNames } from '../src/migrations/files.ts';
import { createTestDatabase, type TestDatabase } from './postgres.ts';

const quiet = { logs: false, rateLimits: false } as const;

describe("the app's migrations", () => {
  const databases: TestDatabase[] = [];
  const instances: NextBase[] = [];
  const dirs: string[] = [];

  const database = async (): Promise<TestDatabase> => {
    const t = await createTestDatabase();
    databases.push(t);
    return t;
  };
  const instance = (
    t: TestDatabase,
    migrations: Migrations | undefined,
  ): NextBase => {
    const nextbase = new NextBase({
      database: t.pool,
      ...(migrations && { migrations }),
      ...quiet,
    });
    instances.push(nextbase);
    return nextbase;
  };
  const folder = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'nextbase-migrations-'));
    dirs.push(dir);
    return dir;
  };
  /** A development instance that writes a migration for each change. */
  const dev = async (t: TestDatabase, dir: string) => {
    const nextbase = instance(t, { dir, files: {}, automigrate: true });
    return { nextbase, admin: nextbase.client({ superuser: true }) };
  };
  /** The migrations a folder's generated index lists. */
  const load = async (dir: string): Promise<Migrations> => {
    const mod = (await import(`${join(dir, 'index.ts')}?v=${Date.now()}`)) as {
      default: Migrations;
    };
    return { ...mod.default, automigrate: false };
  };
  const applied = async (t: TestDatabase): Promise<string[]> =>
    (
      await t.pool.query<{ name: string }>(
        'SELECT name FROM nextbase._app_migrations ORDER BY name',
      )
    ).rows.map((r) => r.name);
  const collections = async (admin: NextBaseClient) =>
    (await admin.collections.getFullList())
      .filter((c) => !c.system)
      // Each database has its own token secrets.
      .map((c) => ({ ...c, tokens: undefined }));

  afterAll(async () => {
    for (const nextbase of instances) await nextbase.flush();
    for (const t of databases) await t.close();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  describe('automigrate', () => {
    let t: TestDatabase;
    let dir: string;
    let admin: NextBaseClient;

    beforeAll(async () => {
      t = await database();
      dir = await folder();
      ({ admin } = await dev(t, dir));
    });

    it('writes a migration for each change, counted as applied, and none for no change', async () => {
      const posts = await admin.collections.create({
        name: 'posts',
        listRule: '',
        fields: [{ name: 'title', type: 'text' }],
      });
      await admin.collections.create({
        name: 'comments',
        fields: [
          {
            name: 'post',
            type: 'relation',
            collectionId: posts.id,
            maxSelect: 1,
          },
        ],
      });
      const title = posts.fields.find((f) => f.name === 'title');
      await admin.collections.update('posts', {
        listRule: null,
        fields: [
          ...posts.fields.filter((f) => f.name !== 'title'),
          { ...title, name: 'heading' },
          { name: 'body', type: 'text' },
        ],
      });
      await admin.collections.update('posts', {});
      await admin.collections.create({ name: 'members', type: 'auth' });

      const names = await migrationNames(dir);
      expect(names.map((n) => n.replace(/^\d+_/, ''))).toEqual([
        'created_posts',
        'created_comments',
        'updated_posts',
        'created_members',
      ]);
      expect(await applied(t)).toEqual(names);
      const update = await readFile(join(dir, `${names[2]}.ts`), 'utf8');
      expect(update).toContain('c.listRule = null;');
      expect(update).toContain('c.fields.addAt(');
      // Renamed in place, by id: the column and its data stay.
      expect(update).toContain('"name": "heading"');
      const index = await readFile(join(dir, 'index.ts'), 'utf8');
      for (const name of names) expect(index).toContain(`"./${name}"`);
      // No token secret goes into a file.
      const auth = await readFile(join(dir, `${names[3]}.ts`), 'utf8');
      expect(auth).toContain('"tokens"');
      expect(auth).not.toContain('secret');
    });

    it('rebuilds the same collections from the files elsewhere, and reverts them', async () => {
      const expected = await collections(admin);
      const other = await database();
      const replay = instance(other, await load(dir));
      await replay.migrate();
      const replayAdmin = replay.client({ superuser: true });
      expect(await collections(replayAdmin)).toEqual(expected);
      expect(await applied(other)).toEqual(await applied(t));
      // Each instance keeps its own secrets.
      const secret = async (nb: NextBase) =>
        (
          (await nb
            .client({ superuser: true })
            .collections.getOne('members')) as {
            tokens: { auth: { secret: string } };
          }
        ).tokens.auth.secret;
      expect(await secret(replay)).not.toBe(
        await secret(instances[0] as NextBase),
      );

      expect(await replay.revertMigrations(2)).toHaveLength(2);
      const posts = await replayAdmin.collections.getOne('posts');
      expect(posts.listRule).toBe('');
      expect(posts.fields.map((f) => f.name)).toContain('title');
      expect(
        (await replayAdmin.collections.getFullList()).map((c) => c.name),
      ).not.toContain('members');
    });

    it('writes a migration for a delete, and changes nothing when it cannot write', async () => {
      await admin.collections.delete('members');
      expect((await migrationNames(dir)).at(-1)).toMatch(/_deleted_members$/);

      const blocked = await folder();
      // A file where the folder should be: the write fails.
      await writeFile(join(blocked, 'nested'), '');
      const broken = instance(t, {
        dir: join(blocked, 'nested'),
        files: {},
        automigrate: true,
      });
      const error = await broken
        .client({ superuser: true })
        .collections.create({ name: 'unsaved' })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ClientError);
      expect(
        (await admin.collections.getFullList()).map((c) => c.name),
      ).not.toContain('unsaved');
    });
  });

  describe('runner', () => {
    it('runs pending migrations once, in order, and seeds records in the same transaction', async () => {
      const t = await database();
      const files: Record<string, Migration> = {
        '1700000002_seed': {
          async up(app) {
            await app.nextbase.collection('tags').create({ label: 'first' });
          },
        },
        '1700000001_tags': {
          async up(app) {
            await app.collections.create({
              name: 'tags',
              fields: [{ name: 'label', type: 'text' }],
            });
          },
          async down(app) {
            await app.collections.delete('tags');
          },
        },
      };
      const list = { dir: 'unused', files, automigrate: false };
      // Two instances starting together run each migration once.
      await Promise.all([
        instance(t, list).migrate(),
        instance(t, list).migrate(),
      ]);
      const { rows } = await t.pool.query('SELECT label FROM nextbase.tags');
      expect(rows).toEqual([{ label: 'first' }]);
      expect(await applied(t)).toEqual(['1700000001_tags', '1700000002_seed']);
    });

    it('keeps none of a failed migration, and stops there', async () => {
      const t = await database();
      const list: Migrations = {
        dir: 'unused',
        automigrate: false,
        files: {
          '1700000001_half': {
            async up(app) {
              await app.collections.create({ name: 'half' });
              throw new Error('Something in the middle failed.');
            },
          },
          '1700000002_after': {
            async up(app) {
              await app.collections.create({ name: 'after' });
            },
          },
        },
      };
      const nextbase = instance(t, list);
      await expect(nextbase.migrate()).rejects.toThrow(
        /1700000001_half failed, and none of its changes were kept: Something in the middle failed/,
      );
      const { rows } = await t.pool.query(
        "SELECT name FROM nextbase._collections WHERE name IN ('half', 'after')",
      );
      expect(rows).toEqual([]);
      expect(await applied(t)).toEqual([]);
    });

    it('refuses badly named migrations', () => {
      expect(
        () =>
          new NextBase({
            migrations: {
              dir: 'x',
              files: { 'Add Posts': { up() {} } },
            },
          }),
      ).toThrow(/must be named/);
    });
  });

  describe('import', () => {
    it('keeps what a snapshot leaves out unless deleteMissing, never system collections, and imports views last', async () => {
      const t = await database();
      const files: Record<string, Migration> = {
        '1700000001_import': {
          async up(app) {
            // Each refers to the other, and the view to both.
            await app.collections.import([
              {
                name: 'active',
                type: 'view',
                viewQuery: 'SELECT id, name FROM nextbase.a',
              },
              {
                id: 'aaaaaaaaaaaaaaa',
                name: 'a',
                fields: [
                  { name: 'name', type: 'text' },
                  {
                    name: 'b',
                    type: 'relation',
                    collectionId: 'bbbbbbbbbbbbbbb',
                  },
                ],
              },
              {
                id: 'bbbbbbbbbbbbbbb',
                name: 'b',
                listRule: '@collection.a.id != ""',
                fields: [
                  {
                    name: 'a',
                    type: 'relation',
                    collectionId: 'aaaaaaaaaaaaaaa',
                  },
                ],
              },
            ]);
          },
        },
        '1700000002_extend': {
          async up(app) {
            await app.collections.import([
              { id: 'aaaaaaaaaaaaaaa', name: 'a', fields: [] },
            ]);
          },
        },
      };
      const nextbase = instance(t, { dir: 'x', files, automigrate: false });
      await nextbase.migrate();
      const admin = nextbase.client({ superuser: true });
      const a = await admin.collections.getOne('a');
      expect(a.fields.map((f) => f.name)).toEqual(
        expect.arrayContaining(['name', 'b']),
      );

      const strict = instance(t, {
        dir: 'x',
        automigrate: false,
        files: {
          ...files,
          '1700000003_only_a': {
            async up(app) {
              await app.collections.import(
                [{ id: 'aaaaaaaaaaaaaaa', name: 'a', fields: [] }],
                { deleteMissing: true },
              );
            },
          },
        },
      });
      await strict.migrate();
      const names = (await admin.collections.getFullList()).map((c) => c.name);
      expect(names).toEqual(expect.arrayContaining(['_superusers', 'a']));
      expect(names).not.toContain('b');
      expect(names).not.toContain('active');
      expect(
        (await admin.collections.getOne('a')).fields.map((f) => f.name),
      ).toEqual(['id']);
    });
  });

  describe('cli', () => {
    const io = (out: string[]): Io => ({
      env: {},
      out: (line) => out.push(line),
      err: (line) => out.push(line),
      prompt: async () => '',
    });

    it('writes blank and snapshot migrations, and forgets ones whose file is gone', async () => {
      const t = await database();
      const dir = await folder();
      const out: string[] = [];
      expect(
        await run(['migrate', 'create', 'Add Tags', '--dir', dir], io(out)),
      ).toBe(0);
      const [blank] = await migrationNames(dir);
      expect(blank).toMatch(/^\d+_add_tags$/);

      await instance(t, undefined)
        .client({ superuser: true })
        .collections.create({ name: 'tags' });
      const database_ = ['--database', t.url, '--dir', dir];
      expect(await run(['migrate', 'collections', ...database_], io(out))).toBe(
        0,
      );
      const names = await migrationNames(dir);
      const snapshot = names.at(-1) as string;
      expect(snapshot).toMatch(/_collections_snapshot$/);
      expect(await readFile(join(dir, `${snapshot}.ts`), 'utf8')).toContain(
        '"name": "tags"',
      );
      expect(await applied(t)).toEqual([snapshot]);

      await rm(join(dir, `${snapshot}.ts`));
      expect(
        await run(['migrate', 'history-sync', ...database_], io(out)),
      ).toBe(0);
      expect(await applied(t)).toEqual([]);
      expect(out.at(-1)).toContain(snapshot);
    });
  });
});
