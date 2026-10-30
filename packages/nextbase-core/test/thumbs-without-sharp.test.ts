import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RecordModel } from '@nextbasejs/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NextBase } from '../src/index.ts';
import { origin } from './http.ts';
import { createTestDatabase, type TestDatabase } from './postgres.ts';

const load = vi.hoisted(() => ({ error: new Error('unset') }));

// Vitest wraps errors a mock factory throws, so the import fails on use,
// with the error Node.js or sharp would give.
vi.mock('sharp', () => ({
  get default(): never {
    throw load.error;
  },
}));

/** As Node.js reports a package that is not installed. */
function notFound(name: string): Error {
  return Object.assign(
    new Error(`Cannot find package '${name}' imported from /app/index.js`),
    { code: 'ERR_MODULE_NOT_FOUND' },
  );
}

/** The smallest valid PNG: a 1x1 transparent pixel. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('thumbnails without sharp', () => {
  let t: TestDatabase;
  let dir: string;
  const instances: NextBase[] = [];
  const pending: Promise<unknown>[] = [];

  /** A NextBase whose import of sharp fails with `error`, as a fresh process. */
  const withLoadError = async (error: Error) => {
    load.error = error;
    vi.resetModules();
    const { NextBase } = await import('../src/index.ts');
    const nextbase = new NextBase({
      database: t.pool,
      storage: { dir },
      waitUntil: (promise) => pending.push(promise),
    });
    instances.push(nextbase);
    return nextbase;
  };

  /** Requests thumbnails twice in two sizes; each redirects to the original. */
  const requestThumbs = async (nextbase: NextBase) => {
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
      expect(response.status).toBe(302);
      const original = await nextbase.handle(
        new Request(new URL(response.headers.get('location') ?? '', origin)),
      );
      expect(Buffer.from(await original.arrayBuffer())).toEqual(PNG);
    }
    expect(
      await readdir(join(dir, post?.collectionId ?? '', post?.id ?? '')),
    ).toEqual([name]);
  };

  const entries = async () => {
    await Promise.all(pending.splice(0));
    await Promise.all(instances.map((i) => i.flush()));
    const { rows } = await t.pool.query<{
      level: number;
      message: string;
      data: { error: string };
    }>(
      "SELECT level, message, data FROM nextbase._logs WHERE data->>'type' = 'thumbs' ORDER BY created",
    );
    await t.pool.query('DELETE FROM nextbase._logs');
    return rows.map((r) => ({
      level: r.level,
      message: r.message,
      error: r.data.error,
    }));
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'nextbase-no-sharp-'));
    const nextbase = await withLoadError(notFound('sharp'));
    await nextbase.client({ superuser: true }).collections.create({
      name: 'posts',
      type: 'base',
      createRule: '',
      viewRule: '',
      fields: [{ name: 'cover', type: 'file', thumbs: ['10x10'] }],
    });
    await entries();
  });
  afterAll(async () => {
    await Promise.all(instances.map((i) => i.flush()));
    await t.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('serves originals when sharp is not installed, warning once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await requestThumbs(await withLoadError(notFound('sharp')));
      expect(
        warn.mock.calls.filter((c) => String(c[0]).includes('sharp')),
      ).toHaveLength(1);
      expect(await entries()).toEqual([
        {
          level: 4,
          message:
            'Making thumbnails needs sharp, so originals are served. Install it',
          error: expect.stringContaining("Cannot find package 'sharp'"),
        },
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('logs any other error loading sharp as it is, once', async () => {
    const fail = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const error of [
        new Error(
          'Could not load the "sharp" module using the linux-x64 runtime',
        ),
        // A package sharp needs, not sharp itself.
        notFound('@img/sharp-libvips-linux-x64'),
      ]) {
        await requestThumbs(await withLoadError(error));
        expect(await entries()).toEqual([
          {
            level: 8,
            message: 'Loading sharp failed, so originals are served',
            error: error.message,
          },
        ]);
      }
      expect(fail).toHaveBeenCalledTimes(2);
    } finally {
      fail.mockRestore();
    }
  });
});
