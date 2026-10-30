import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import {
  ClientError,
  type NextBaseClient,
  type RecordModel,
} from '@nextbasejs/client';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NextBase } from '../src/index.ts';
import { type FakeS3, startFakeS3 } from './fake-s3.ts';
import { origin } from './http.ts';
import { createTestDatabase, type TestDatabase } from './postgres.ts';

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
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        get(pathOf(post, name, { thumb: '100x100f' })),
      ),
    );
    const bodies = await Promise.all(responses.map(bytesOf));
    for (const [i, response] of responses.entries()) {
      expect(response.status).toBe(200);
      expect(bodies[i]).toEqual(bodies[0]);
    }
    expect((await thumbsOf(post)).thumbs).toEqual([`100x100f_${name}`]);
  });

  it('serves the original for other sizes, files and images it cannot read', async () => {
    const png = await image(300, 300);
    const { post, name } = await upload(png, 'a.png', 'image/png');
    for (const thumb of ['123x45', '0x0', 'nonsense', '100X100']) {
      const response = await get(pathOf(post, name, { thumb }));
      expect(await bytesOf(response), thumb).toEqual(png);
    }

    const pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n',
      'latin1',
    );
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300"/></svg>',
    );
    const corrupt = await corruptPng();
    const huge = hugePng();
    for (const [bytes, filename, type, contentType] of [
      [pdf, 'doc.pdf', 'application/pdf', 'application/pdf'],
      [svg, 'logo.svg', 'image/svg+xml', 'application/octet-stream'],
      [corrupt, 'corrupt.png', 'image/png', 'image/png'],
      [huge, 'huge.png', 'image/png', 'image/png'],
    ] as const) {
      const file = await upload(bytes, filename, type);
      for (const thumb of ['100x100', '100x100', '50x50']) {
        const response = await get(pathOf(file.post, file.name, { thumb }));
        expect(response.status, filename).toBe(200);
        expect(response.headers.get('content-type'), filename).toBe(
          contentType,
        );
        expect(await bytesOf(response), filename).toEqual(bytes);
      }
      expect((await thumbsOf(file.post)).entries, filename).toEqual([
        file.name,
      ]);
    }

    // Each file's failure is logged once: stored files never change.
    const logged = await warnings();
    expect(logged).toHaveLength(2);
    expect(logged.map((l) => l.level)).toEqual([4, 4]);
    expect(logged.map((l) => l.error).sort()).toEqual([
      'Input image exceeds pixel limit',
      expect.stringContaining('png'),
    ]);
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

    // Sizes the field does not allow redirect to the original.
    const original = await nextbase.handle(new Request(url('31x20')));
    expect(
      decodeURIComponent(
        new URL(original.headers.get('location') ?? '').pathname,
      ),
    ).toBe(`/${s3.bucket}/${key}`);
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
    // Waits for the thumbnail's PUT to be held.
    while (!s3.requests.slice(before).some((r) => r.startsWith('PUT '))) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
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
