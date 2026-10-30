import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RecordModel } from '@nextbasejs/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextBase } from '../src/index.ts';
import { origin } from './http.ts';
import { createTestDatabase, type TestDatabase } from './postgres.ts';

// As when the optional peer dependency is not installed.
vi.mock('sharp', () => {
  throw new Error("Cannot find package 'sharp'");
});

/** The smallest valid PNG: a 1x1 transparent pixel. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('thumbnails without sharp', () => {
  let t: TestDatabase;
  let dir: string;
  let nextbase: NextBase;
  const pending: Promise<unknown>[] = [];

  beforeAll(async () => {
    t = await createTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'nextbase-no-sharp-'));
    nextbase = new NextBase({
      database: t.pool,
      storage: { dir },
      waitUntil: (promise) => pending.push(promise),
    });
    await nextbase.client({ superuser: true }).collections.create({
      name: 'posts',
      type: 'base',
      createRule: '',
      viewRule: '',
      fields: [{ name: 'cover', type: 'file', thumbs: ['10x10'] }],
    });
  });
  afterAll(async () => {
    await nextbase.flush();
    await t.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('serves originals, warning once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const nb = nextbase.client();
      const post = await nb
        .collection('posts')
        .create({ cover: new File([PNG], 'a.png', { type: 'image/png' }) });
      const name = post?.cover as string;
      for (const thumb of ['10x10', '100x100', '10x10', '100x100']) {
        const url = new URL(
          nb.files.getUrl(post as RecordModel, name, { thumb }),
          origin,
        );
        const response = await nextbase.handle(new Request(url));
        expect(response.status).toBe(200);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
      }
      expect(
        await readdir(join(dir, post?.collectionId ?? '', post?.id ?? '')),
      ).toEqual([name]);

      await Promise.all(pending.splice(0));
      await nextbase.flush();
      const missing = warn.mock.calls.filter((call) =>
        String(call[0]).includes('sharp'),
      );
      expect(missing).toHaveLength(1);
      const { rows } = await t.pool.query<{ level: number }>(
        "SELECT level FROM nextbase._logs WHERE data->>'type' = 'thumbs'",
      );
      expect(rows.map((r) => r.level)).toEqual([4]);
    } finally {
      warn.mockRestore();
    }
  });
});
