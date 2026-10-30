import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import {
  ClientError,
  type FileField,
  type NextBaseClient,
  type RecordModel,
} from '@nextbasejs/client';
import sharp from 'sharp';
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
import { newStorage, type Storage } from '../src/files/storage.ts';
import { Thumbs, thumbLimits, thumbsPrefix } from '../src/files/thumbs.ts';
import { NextBase } from '../src/index.ts';
import { Logger } from '../src/logs/logger.ts';
import { type FakeS3, startFakeS3 } from './fake-s3.ts';
import { origin } from './http.ts';
import { createTestDatabase, type TestDatabase } from './postgres.ts';
import { waitFor } from './wait.ts';

const PASSWORD = 'password 123 456';

const SIZES = [
  '100x100t',
  '100x100b',
  '100x100f',
  '50x50',
  '0x50',
  '200x0',
  '1000x0',
  '800x800',
];

type Format = 'png' | 'jpeg' | 'gif' | 'webp';

const solid = (width: number, height: number, background: string) =>
  sharp({ create: { width, height, channels: 3, background } });

const image = (width: number, height: number, format: Format = 'png') =>
  solid(width, height, '#ff0000').toFormat(format).toBuffer();

/** 200x400, red above and blue below, to tell where a crop was taken. */
const twoTone = () =>
  solid(200, 400, '#ff0000')
    .composite([{ input: { create: { ...BLUE_HALF } }, top: 200, left: 0 }])
    .png()
    .toBuffer();

const BLUE_HALF = {
  width: 200,
  height: 200,
  channels: 3,
  background: '#0000ff',
} as const;

/** A valid PNG header claiming 10000x10000 pixels, with almost no data. */
function hugePng(): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(10_000, 0);
  header.writeUInt32BE(10_000, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(1))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A PNG whose pixel data is garbage, past a valid header. */
async function corruptPng(): Promise<Buffer> {
  const bytes = Buffer.from(
    await solid(64, 64, '#00ff00').png({ compressionLevel: 0 }).toBuffer(),
  );
  for (let i = 80; i < 200; i++) bytes[i] = i % 7;
  return bytes;
}

const fileOf = (bytes: Uint8Array, name: string, type: string): File =>
  new File([bytes], name, { type });

/** Average red and blue, 0 to 255. */
async function colour(
  bytes: Uint8Array,
): Promise<{ red: number; blue: number }> {
  const { channels } = await sharp(bytes).stats();
  return {
    red: Math.round(channels[0]?.mean ?? 0),
    blue: Math.round(channels[2]?.mean ?? 0),
  };
}

const bytesOf = async (response: Response): Promise<Buffer> =>
  Buffer.from(await response.arrayBuffer());

const LIMITS = { ...thumbLimits };

/** The URL a fallback redirects to: the same one, without `thumb`. */
function expectFallback(response: Response, path: string): string {
  expect(response.status).toBe(302);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const url = new URL(path, origin);
  url.searchParams.delete('thumb');
  const location = response.headers.get('location') ?? '';
  expect(location).toBe(url.pathname + url.search);
  return location;
}

describe('thumbnails with local storage', () => {
  let t: TestDatabase;
  let dir: string;
  let nextbase: NextBase;
  let admin: NextBaseClient;
  const pending: Promise<unknown>[] = [];
  const settle = async (): Promise<void> => {
    while (pending.length > 0) await Promise.all(pending.splice(0));
  };

  const get = (path: string, headers: Record<string, string> = {}) =>
    nextbase.handle(new Request(`${origin}${path}`, { headers }));

  /** The path and query of a file's URL, for `get`. */
  const pathOf = (
    record: RecordModel | null | undefined,
    name: string,
    options: { thumb?: string; token?: string } = {},
  ): string => {
    const url = new URL(
      nextbase.client().files.getUrl(record as RecordModel, name, options),
      origin,
    );
    return url.pathname + url.search;
  };

  const upload = async (bytes: Uint8Array, name: string, type: string) => {
    const post = await nextbase
      .client()
      .collection('posts')
      .create({ cover: fileOf(bytes, name, type) });
    return { post, name: post?.cover as string };
  };

  const thumbsOf = async (record: RecordModel | null | undefined) => {
    await settle();
    const base = join(dir, record?.collectionId ?? '', record?.id ?? '');
    const entries = await readdir(base).catch(() => [] as string[]);
    const thumbs = entries.filter((e) => e.startsWith('thumbs_'));
    const files = await Promise.all(
      thumbs.map((d) => readdir(join(base, d)).catch(() => [] as string[])),
    );
    return { entries, thumbs: files.flat().sort() };
  };

  const warnings = async (): Promise<Record<string, unknown>[]> => {
    await settle();
    await nextbase.flush();
    const { rows } = await t.pool.query<{
      level: number;
      data: Record<string, unknown>;
    }>("SELECT level, data FROM nextbase._logs WHERE data->>'type' = 'thumbs'");
    return rows.map((r) => ({ level: r.level, ...r.data }));
  };

  /** Calls of `put` for thumbnails and markers, on any local storage. */
  const thumbPuts = (spy: { mock: { calls: unknown[][] } }, name: string) =>
    spy.mock.calls.filter((c) => String(c[0]).includes(`/thumbs_${name}/`))
      .length;

  /** Follows a fallback to the original. */
  const original = async (path: string): Promise<Response> =>
    get(expectFallback(await get(path), path));

  afterEach(() => {
    Object.assign(thumbLimits, LIMITS);
    vi.restoreAllMocks();
  });

  beforeAll(async () => {
    t = await createTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'nextbase-thumbs-'));
    nextbase = new NextBase({
      database: t.pool,
      storage: { dir },
      waitUntil: (promise) => pending.push(promise),
    });
    admin = nextbase.client({ superuser: true });
    await admin.collections.create({
      name: 'posts',
      type: 'base',
      createRule: '',
      viewRule: '',
      updateRule: '',
      deleteRule: '',
      fields: [
        { name: 'cover', type: 'file', thumbs: SIZES, maxSize: 1024 * 1024 },
      ],
    });
    await admin.collections.create({
      name: 'users',
      type: 'auth',
      createRule: '',
      viewRule: 'id = @request.auth.id',
      updateRule: 'id = @request.auth.id',
      fields: [
        { name: 'scan', type: 'file', protected: true, thumbs: ['50x50'] },
      ],
    });
  });
  afterAll(async () => {
    await settle();
    await nextbase.flush();
    await t.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('checks the sizes a field allows', async () => {
    const field = (thumbs: unknown) =>
      admin.collections
        .create({
          name: `bad_${Math.random().toString(36).slice(2, 8)}`,
          type: 'base',
          fields: [{ name: 'img', type: 'file', thumbs } as never],
        })
        .catch((error: unknown) => error);
    for (const size of [
      '0x0',
      '2501x10',
      '10x2501',
      '10x10x',
      '10x10c',
      '10',
      'x10',
      '12345x1',
      ' 10x10',
      '-1x10',
      '0100x100',
      '100x0100',
      '00x10',
      '0x100t',
      '100x0b',
      '0x100f',
    ]) {
      const error = await field([size]);
      expect(error, size).toBeInstanceOf(ClientError);
      expect((error as ClientError).data, size).toMatchObject({
        fields: { 0: { thumbs: { 0: { code: 'validation_invalid_value' } } } },
      });
    }
    const tooMany = (await field(
      Array.from({ length: 21 }, (_, i) => `${i + 1}x1`),
    )) as ClientError;
    expect(tooMany.data).toMatchObject({
      fields: { 0: { thumbs: { code: 'validation_too_many' } } },
    });
    expect(((await field('10x10')) as ClientError).status).toBe(400);

    const created = await admin.collections.create({
      name: 'good_sizes',
      type: 'base',
      fields: [
        {
          name: 'img',
          type: 'file',
          thumbs: [
            '2500x2500',
            '0x1',
            '1x0',
            '10x10t',
            '10x10b',
            '10x10f',
            '10x10t',
          ],
        },
        { name: 'plain', type: 'file' },
      ],
    });
    // Duplicates are dropped; twenty distinct sizes are allowed.
    expect(created.fields.find((f) => f.name === 'img')).toMatchObject({
      thumbs: ['2500x2500', '0x1', '1x0', '10x10t', '10x10b', '10x10f'],
    });
    expect(created.fields.find((f) => f.name === 'plain')).toMatchObject({
      thumbs: [],
    });
    await admin.collections.update('good_sizes', {
      fields: [
        {
          name: 'img',
          type: 'file',
          thumbs: Array.from({ length: 20 }, (_, i) => `${i + 1}x1`),
        },
      ],
    });
  });

  it('gives file fields stored before thumbnails no sizes', async () => {
    const posts = await admin.collections.getOne('posts');
    const { rows } = await t.pool.query<{ fields: unknown }>(
      'SELECT fields FROM nextbase._collections WHERE id = $1',
      [posts.id],
    );
    await t.pool.query(
      `UPDATE nextbase._collections
       SET fields = (
         SELECT jsonb_agg(f - 'thumbs' ORDER BY i)
         FROM jsonb_array_elements(fields) WITH ORDINALITY AS a(f, i)
       )
       WHERE id = $1`,
      [posts.id],
    );
    const fresh = new NextBase({ database: t.pool, storage: { dir } });
    const loaded = await fresh
      .client({ superuser: true })
      .collections.getOne('posts');
    expect(loaded.fields.find((f) => f.name === 'cover')).toMatchObject({
      thumbs: [],
    });
    await t.pool.query(
      'UPDATE nextbase._collections SET fields = $2 WHERE id = $1',
      [posts.id, JSON.stringify(rows[0]?.fields)],
    );
    await fresh.flush();
  });

  it('makes each size to its mode, keeping the format', async () => {
    const { post, name } = await upload(
      await image(400, 200),
      'wide.png',
      'image/png',
    );
    expect(pathOf(post, name, { thumb: '50x50' })).toMatch(/\?thumb=50x50$/);
    expect(pathOf(post, name, { thumb: '' })).not.toContain('?');
    const expected: Record<string, [number, number]> = {
      '100x100': [100, 100],
      '100x100t': [100, 100],
      '100x100f': [100, 50],
      '50x50': [50, 50],
      '0x50': [100, 50],
      '200x0': [200, 100],
      // Never enlarged.
      '1000x0': [400, 200],
      '800x800': [400, 200],
    };
    for (const [size, [width, height]] of Object.entries(expected)) {
      const response = await get(pathOf(post, name, { thumb: size }));
      expect(response.status, size).toBe(200);
      expect(response.headers.get('content-type'), size).toBe('image/png');
      const info = await sharp(await bytesOf(response)).metadata();
      expect([info.format, info.width, info.height], size).toEqual([
        'png',
        width,
        height,
      ]);
    }

    for (const format of ['jpeg', 'gif', 'webp'] as const) {
      const ext = format === 'jpeg' ? 'jpg' : format;
      const file = await upload(
        await image(300, 300, format),
        `a.${ext}`,
        `image/${format}`,
      );
      const response = await get(
        pathOf(file.post, file.name, { thumb: '50x50' }),
      );
      expect(response.headers.get('content-type')).toBe(`image/${format}`);
      const info = await sharp(await bytesOf(response)).metadata();
      expect([info.format, info.width, info.height]).toEqual([format, 50, 50]);
    }
  });

  it('crops from the centre, top or bottom', async () => {
    const { post, name } = await upload(
      await twoTone(),
      'tall.png',
      'image/png',
    );
    const crop = async (thumb: string) =>
      colour(await bytesOf(await get(pathOf(post, name, { thumb }))));
    const top = await crop('100x100t');
    expect(top.red).toBeGreaterThan(240);
    expect(top.blue).toBeLessThan(15);
    const bottom = await crop('100x100b');
    expect(bottom.blue).toBeGreaterThan(240);
    expect(bottom.red).toBeLessThan(15);
    const centre = await crop('100x100');
    expect(centre.red).toBeGreaterThan(110);
    expect(centre.blue).toBeGreaterThan(110);
  });

  it('stores each thumbnail once, beside the file', async () => {
    const { post, name } = await upload(
      await image(300, 200),
      'once.png',
      'image/png',
    );
    const first = await get(pathOf(post, name, { thumb: '50x50' }));
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('public, max-age=604800');
    const path = join(
      dir,
      post?.collectionId as string,
      post?.id as string,
      `thumbs_${name}`,
      `50x50_${name}`,
    );
    const made = await stat(path);
    const again = await get(pathOf(post, name, { thumb: '50x50' }));
    expect(await bytesOf(again)).toEqual(await bytesOf(first));
    // Files are renamed into place, so a second write would be a new inode.
    expect((await stat(path)).ino).toBe(made.ino);
    expect((await thumbsOf(post)).thumbs).toEqual([`50x50_${name}`]);
  });

  it('makes a thumbnail once for requests that arrive together', async () => {
    const { post, name } = await upload(
      await image(600, 600),
      'together.png',
      'image/png',
    );
    const put = vi.spyOn(
      Object.getPrototypeOf(newStorage({ dir })) as {
        put: (...args: unknown[]) => Promise<void>;
      },
      'put',
    );
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        get(pathOf(post, name, { thumb: '100x100f' })),
      ),
    );
    expect(thumbPuts(put, name)).toBe(1);
    const bodies = await Promise.all(responses.map(bytesOf));
    for (const [i, response] of responses.entries()) {
      expect(response.status).toBe(200);
      expect(bodies[i]).toEqual(bodies[0]);
    }
    expect((await thumbsOf(post)).thumbs).toEqual([`100x100f_${name}`]);
  });

  it('redirects to the original for other sizes, files and images it cannot read', async () => {
    const png = await image(300, 300);
    const { post, name } = await upload(png, 'a.png', 'image/png');
    for (const thumb of ['123x45', '0x0', 'nonsense', '100X100', '0100x100']) {
      const response = await original(pathOf(post, name, { thumb }));
      expect(response.headers.get('cache-control'), thumb).toBe(
        'public, max-age=604800',
      );
      expect(await bytesOf(response), thumb).toEqual(png);
    }
    const download = pathOf(post, name, { thumb: '1x1' }).replace(
      '?',
      '?download=1&',
    );
    expect(expectFallback(await get(download), download)).toBe(
      `${pathOf(post, name)}?download=1`,
    );

    const pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n',
      'latin1',
    );
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300"/></svg>',
    );
    const unthumbable: [Buffer, string, string][] = [
      [hugePng(), 'huge.png', 'image/png'],
      // Under the pixel limit, but slow to decode.
      [await image(1, 20_000), 'strip.png', 'image/png'],
      [await image(10, 600), 'thin.png', 'image/png'],
    ];
    const put = vi.spyOn(
      Object.getPrototypeOf(newStorage({ dir })) as {
        put: (...args: unknown[]) => Promise<void>;
      },
      'put',
    );
    const failed: { post: RecordModel | null; name: string }[] = [];
    for (const [bytes, filename, type, contentType] of [
      [pdf, 'doc.pdf', 'application/pdf', 'application/pdf'],
      [svg, 'logo.svg', 'image/svg+xml', 'application/octet-stream'],
      ...unthumbable.map(([b, f, ty]) => [b, f, ty, ty] as const),
    ] as const) {
      const file = await upload(bytes, filename, type);
      for (const thumb of ['100x100', '100x100', '50x50']) {
        const response = await original(
          pathOf(file.post, file.name, { thumb }),
        );
        expect(response.status, filename).toBe(200);
        expect(response.headers.get('content-type'), filename).toBe(
          contentType,
        );
        expect(await bytesOf(response), filename).toEqual(bytes);
      }
      const stored = await thumbsOf(file.post);
      if (filename.endsWith('.png')) {
        // A marker, written once, says the file can never be thumbed.
        expect(stored.thumbs, filename).toEqual(['.failed']);
        expect(thumbPuts(put, file.name), filename).toBe(1);
        failed.push(file);
      } else {
        expect(stored.entries, filename).toEqual([file.name]);
      }
    }

    // Each file's failure is logged once: stored files never change.
    const logged = await warnings();
    expect(logged.map((l) => l.level)).toEqual([4, 4, 4]);
    const errors = logged.map((l) => String(l.error));
    for (const reason of ['pixel limit', '1x20000', '10x600']) {
      expect(
        errors.some((e) => e.includes(reason)),
        reason,
      ).toBe(true);
    }

    // The markers hold for every instance: none decodes the files again.
    const other = new NextBase({ database: t.pool, storage: { dir } });
    for (const file of failed) {
      const path = pathOf(file.post, file.name, { thumb: '100x100' });
      expectFallback(await other.handle(new Request(`${origin}${path}`)), path);
    }
    await other.flush();
    expect(await warnings()).toHaveLength(3);
  });

  describe('with storage that fails', () => {
    const FIELD: FileField = {
      id: 'abcdefghij',
      name: 'img',
      type: 'file',
      system: false,
      required: false,
      hidden: false,
      maxSelect: 1,
      maxSize: 1024 * 1024,
      mimeTypes: [],
      protected: false,
      thumbs: ['50x50'],
    };
    let n = 0;

    /** A stored file, its key, and its thumbnails' directory. */
    const stored = async (bytes: Uint8Array) => {
      const key = `stub/r${n++}/a_abcdefghij.png`;
      await newStorage({ dir }).put(key, bytes, 'image/png');
      return { key, thumbs: join(dir, thumbsPrefix(key)) };
    };

    /** Thumbs over local storage with some methods replaced, and its logger. */
    const thumbsWith = (override: Partial<Storage> = {}) => {
      const real = newStorage({ dir });
      const storage: Storage = {
        kind: real.kind,
        put: real.put.bind(real),
        read: real.read.bind(real),
        readStart: real.readStart.bind(real),
        size: real.size.bind(real),
        copy: real.copy.bind(real),
        delete: real.delete.bind(real),
        deletePrefix: real.deletePrefix.bind(real),
        ...override,
      };
      const logger = new Logger(false, {
        db: () => t.db,
        ready: async () => {},
        waitUntil: () => {},
      });
      const failure = vi.spyOn(logger, 'failure');
      return { thumbs: new Thumbs(storage, logger), failure };
    };

    const listed = (path: string) => readdir(path).catch(() => [] as string[]);

    beforeEach(() => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('serves the original, remembering nothing, when the file cannot be read', async () => {
      const { key, thumbs: dirOf } = await stored(await image(200, 200));
      const failing = thumbsWith({
        read: () => Promise.reject(new Error('connection reset')),
      });
      expect(await failing.thumbs.keyOf(FIELD, key, '50x50')).toBeUndefined();
      expect(failing.failure).toHaveBeenCalledWith(
        'storage',
        'reading a file to thumb failed',
        expect.objectContaining({ message: 'connection reset' }),
      );
      expect(await listed(dirOf)).toEqual([]);
      const working = thumbsWith();
      expect(await working.thumbs.keyOf(FIELD, key, '50x50')).toBe(
        `${thumbsPrefix(key)}50x50_a_abcdefghij.png`,
      );
    });

    it('serves what it stored when storage cannot say whether the file still exists', async () => {
      // The second size check of the file is the one after storing.
      const sizes = (key: string) => {
        let checks = 0;
        return (asked: string) =>
          asked === key && ++checks === 2
            ? Promise.reject(new Error('timed out'))
            : newStorage({ dir }).size(asked);
      };
      const thumb = await stored(await image(200, 200));
      const afterThumb = thumbsWith({ size: sizes(thumb.key) });
      expect(await afterThumb.thumbs.keyOf(FIELD, thumb.key, '50x50')).toBe(
        `${thumbsPrefix(thumb.key)}50x50_a_abcdefghij.png`,
      );
      expect(afterThumb.failure).toHaveBeenCalledWith(
        'storage',
        'checking a thumbed file failed',
        expect.objectContaining({ message: 'timed out' }),
      );
      expect(await listed(thumb.thumbs)).toEqual(['50x50_a_abcdefghij.png']);

      const marked = await stored(await image(10, 600));
      const afterMarker = thumbsWith({ size: sizes(marked.key) });
      expect(
        await afterMarker.thumbs.keyOf(FIELD, marked.key, '50x50'),
      ).toBeUndefined();
      expect(afterMarker.failure).toHaveBeenCalledWith(
        'storage',
        'checking a thumbed file failed',
        expect.objectContaining({ message: 'timed out' }),
      );
      expect(await listed(marked.thumbs)).toEqual(['.failed']);
    });

    it('never marks a file for a failed resize, but waits before trying again', async () => {
      const { key, thumbs: dirOf } = await stored(await corruptPng());
      const { thumbs, failure } = thumbsWith();
      const tries = () =>
        failure.mock.calls.filter((c) => c[0] === 'thumbs').length;
      expect(await thumbs.keyOf(FIELD, key, '50x50')).toBeUndefined();
      expect(tries()).toBe(1);
      expect(await thumbs.keyOf(FIELD, key, '50x50')).toBeUndefined();
      expect(tries()).toBe(1);
      // Each size backs off on its own.
      expect(await thumbs.keyOf(FIELD, key, '100x100')).toBeUndefined();
      expect(tries()).toBe(2);
      thumbLimits.backoffMs = 0;
      expect(await thumbs.keyOf(FIELD, key, '50x50')).toBeUndefined();
      expect(tries()).toBe(3);
      expect(await listed(dirOf)).toEqual([]);
    });
  });

  it('does not read files larger than the limit', async () => {
    thumbLimits.maxBytes = 1000;
    const png = await image(400, 400, 'jpeg');
    expect(png.length).toBeGreaterThan(1000);
    const { post, name } = await upload(png, 'large.jpg', 'image/jpeg');
    const response = await original(pathOf(post, name, { thumb: '50x50' }));
    expect(await bytesOf(response)).toEqual(png);
    expect((await thumbsOf(post)).thumbs).toEqual(['.failed']);
  });

  it('stays 404 for files the record does not have or storage lost', async () => {
    const { post, name } = await upload(
      await image(100, 100),
      'lost.png',
      'image/png',
    );
    await rm(join(dir, post?.collectionId as string, post?.id as string, name));
    expect((await get(pathOf(post, name, { thumb: '50x50' }))).status).toBe(
      404,
    );
    expect(
      (await get(pathOf(post, 'other_abcdefghij.png', { thumb: '50x50' })))
        .status,
    ).toBe(404);
    expect((await thumbsOf(post)).thumbs).toEqual([]);
  });

  it('applies the EXIF orientation and strips metadata', async () => {
    // Stored 200x100, shown turned a quarter, as 100x200.
    const jpeg = await solid(200, 100, '#ff0000')
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect((await sharp(jpeg).metadata()).orientation).toBe(6);
    const { post, name } = await upload(jpeg, 'turned.jpg', 'image/jpeg');
    const response = await get(pathOf(post, name, { thumb: '100x100f' }));
    const info = await sharp(await bytesOf(response)).metadata();
    expect([info.width, info.height]).toEqual([50, 100]);
    expect(info.orientation).toBeUndefined();
    expect(info.exif).toBeUndefined();
    expect(info.icc).toBeUndefined();
  });

  it('makes one frame of an animated GIF', async () => {
    const frames = await Promise.all([
      solid(40, 40, '#ff0000').png().toBuffer(),
      solid(40, 40, '#0000ff').png().toBuffer(),
    ]);
    const gif = await sharp(frames, { join: { animated: true } })
      .gif()
      .toBuffer();
    expect((await sharp(gif).metadata()).pages).toBe(2);
    const { post, name } = await upload(gif, 'moving.gif', 'image/gif');
    const response = await get(pathOf(post, name, { thumb: '50x50' }));
    const thumb = await bytesOf(response);
    const info = await sharp(thumb, { animated: true }).metadata();
    expect([info.format, info.pages, info.width, info.height]).toEqual([
      'gif',
      1,
      40,
      40,
    ]);
    expect((await colour(thumb)).red).toBeGreaterThan(240);
  });

  it('serves thumbnails of protected files only with access, never cached', async () => {
    const owner = nextbase.client();
    await owner.collection('users').signUp({
      email: 'ann@example.com',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    const id = owner.authStore.record?.id as string;
    const record = await owner.collection('users').update(id, {
      scan: fileOf(await image(200, 200), 'scan.png', 'image/png'),
    });
    const name = record?.scan as string;

    expect((await get(pathOf(record, name, { thumb: '50x50' }))).status).toBe(
      404,
    );
    expect((await thumbsOf(record)).thumbs).toEqual([]);
    const token = await owner.files.getToken();
    const response = await get(pathOf(record, name, { thumb: '50x50', token }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect((await sharp(await bytesOf(response)).metadata()).width).toBe(50);
    // A fallback keeps the token, and the original stays uncached.
    const other = await original(
      pathOf(record, name, { thumb: '60x60', token }),
    );
    expect(other.status).toBe(200);
    expect(other.headers.get('cache-control')).toBe('private, no-store');

    const stranger = nextbase.client();
    await stranger.collection('users').signUp({
      email: 'bob@example.com',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    const theirs = await stranger.files.getToken();
    expect(
      (await get(pathOf(record, name, { thumb: '50x50', token: theirs })))
        .status,
    ).toBe(404);
  });

  it("removes a file's thumbnails with the file, the record and the collection", async () => {
    const posts = nextbase.client().collection('posts');
    const make = async () => {
      const { post, name } = await upload(
        await image(200, 200),
        'gone.png',
        'image/png',
      );
      for (const thumb of ['50x50', '100x100']) {
        expect((await get(pathOf(post, name, { thumb }))).status).toBe(200);
      }
      expect((await thumbsOf(post)).thumbs).toHaveLength(2);
      return post;
    };

    const replaced = await make();
    await posts.update(replaced?.id as string, {
      cover: fileOf(await image(10, 10), 'new.png', 'image/png'),
    });
    const after = await thumbsOf(replaced);
    expect(after.thumbs).toEqual([]);
    expect(after.entries).toHaveLength(1);

    const deleted = await make();
    await posts.delete(deleted?.id as string);
    await settle();
    await expect(
      readdir(
        join(dir, deleted?.collectionId as string, deleted?.id as string),
      ),
    ).rejects.toThrow();

    const kept = await make();
    const { id } = await admin.collections.getOne('posts');
    await admin.collections.delete('posts');
    await settle();
    expect(kept?.collectionId).toBe(id);
    await expect(readdir(join(dir, id))).rejects.toThrow();
  });
});

describe('thumbnails in an S3-compatible bucket', () => {
  let t: TestDatabase;
  let s3: FakeS3;
  let nextbase: NextBase;
  const pending: Promise<unknown>[] = [];
  const settle = async (): Promise<void> => {
    while (pending.length > 0) await Promise.all(pending.splice(0));
  };
  const puts = (key: string) =>
    s3.requests.filter((r) => r.split('?')[0] === `PUT /${s3.bucket}/${key}`)
      .length;

  const upload = async (bytes: Uint8Array) => {
    const nb = nextbase.client();
    const photo = await nb
      .collection('photos')
      .create({ img: fileOf(bytes, 'p.png', 'image/png') });
    const name = photo?.img as string;
    const key = `${photo?.collectionId}/${photo?.id}/${name}`;
    const url = (thumb: string) =>
      new URL(nb.files.getUrl(photo as RecordModel, name, { thumb }), origin);
    return { photo, name, key, url };
  };

  beforeAll(async () => {
    s3 = await startFakeS3();
    t = await createTestDatabase();
    nextbase = new NextBase({
      database: t.pool,
      storage: {
        s3: {
          bucket: s3.bucket,
          endpoint: s3.endpoint,
          region: 'us-east-1',
          accessKeyId: 'test',
          secretAccessKey: 'test',
          forcePathStyle: true,
        },
      },
      waitUntil: (promise) => pending.push(promise),
    });
    await nextbase.client({ superuser: true }).collections.create({
      name: 'photos',
      type: 'base',
      createRule: '',
      viewRule: '',
      deleteRule: '',
      fields: [{ name: 'img', type: 'file', thumbs: ['30x20'] }],
    });
  });
  afterEach(() => {
    Object.assign(thumbLimits, LIMITS);
  });
  afterAll(async () => {
    s3.hold = undefined;
    await settle();
    await nextbase.flush();
    await t.close();
    await s3.stop();
  });

  it('stores a thumbnail once and redirects to it', async () => {
    const { name, key, url } = await upload(await image(300, 300));
    const thumbKey = `${key.slice(0, key.lastIndexOf('/'))}/thumbs_${name}/30x20_${name}`;
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        nextbase.handle(new Request(url('30x20'))),
      ),
    );
    for (const response of responses) {
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get('location') ?? '');
      expect(decodeURIComponent(location.pathname)).toBe(
        `/${s3.bucket}/${thumbKey}`,
      );
    }
    expect(puts(thumbKey)).toBe(1);
    expect(s3.objects.get(thumbKey)?.contentType).toBe('image/png');
    const thumb = s3.objects.get(thumbKey)?.body as Buffer;
    const info = await sharp(thumb).metadata();
    expect([info.width, info.height]).toEqual([30, 20]);

    await nextbase.handle(new Request(url('30x20')));
    expect(puts(thumbKey)).toBe(1);

    // Sizes the field does not allow redirect to the original's URL.
    const other = url('31x20');
    expectFallback(
      await nextbase.handle(new Request(other)),
      other.pathname + other.search,
    );
  });

  it('serves the original while too busy, remembering nothing', async () => {
    thumbLimits.slots = 1;
    thumbLimits.waitMs = 50;
    const busy = await upload(await image(100, 100));
    const waiting = await upload(await image(100, 100));
    let release = (): void => {};
    s3.holdGets = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = s3.requests.length;
    try {
      // Reading its file is held, so the one slot stays taken.
      const first = nextbase.handle(new Request(busy.url('30x20')));
      await waitFor(
        () => s3.requests.slice(before).some((r) => r.startsWith('GET ')),
        "the file's GET",
      );
      const timedOut = waiting.url('30x20');
      const path = timedOut.pathname + timedOut.search;
      expectFallback(await nextbase.handle(new Request(timedOut)), path);
      thumbLimits.queued = 0;
      expectFallback(await nextbase.handle(new Request(timedOut)), path);
      s3.holdGets = undefined;
      release();
      expect((await first).status).toBe(302);
    } finally {
      s3.holdGets = undefined;
      release();
    }
    const later = await nextbase.handle(new Request(waiting.url('30x20')));
    expect(new URL(later.headers.get('location') ?? '').pathname).toContain(
      `/thumbs_${waiting.name}/30x20_`,
    );
  });

  it("deletes a record's thumbnails from the bucket", async () => {
    const { photo, url } = await upload(await image(100, 100));
    await nextbase.handle(new Request(url('100x100')));
    await nextbase.handle(new Request(url('30x20')));
    const ofRecord = () =>
      [...s3.objects.keys()].filter((k) => k.includes(photo?.id as string));
    expect(ofRecord()).toHaveLength(3);
    await nextbase
      .client()
      .collection('photos')
      .delete(photo?.id as string);
    await settle();
    expect(ofRecord()).toEqual([]);
  });

  it('deletes a thumbnail made while its file was being deleted', async () => {
    const { photo, url } = await upload(await image(100, 100));
    let release = (): void => {};
    s3.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = s3.requests.length;
    const response = nextbase.handle(new Request(url('30x20')));
    await waitFor(
      () => s3.requests.slice(before).some((r) => r.startsWith('PUT ')),
      "the thumbnail's PUT",
    );
    await nextbase
      .client()
      .collection('photos')
      .delete(photo?.id as string);
    await settle();
    s3.hold = undefined;
    release();
    expect((await response).status).toBe(404);
    expect(
      [...s3.objects.keys()].filter((k) => k.includes(photo?.id as string)),
    ).toEqual([]);
  });
});
