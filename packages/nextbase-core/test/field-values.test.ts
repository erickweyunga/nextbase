import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClientError,
  type Collection,
  type NextBaseClient,
  type RecordModel,
} from '@nextbasejs/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Migrations, NextBase } from '../src/index.ts';
import { createTestDatabase, type TestDatabase } from './postgres.ts';

const quiet = { logs: false, rateLimits: false } as const;

async function failure(promise: Promise<unknown>): Promise<ClientError> {
  const error = await promise.catch((e: unknown) => e);
  if (!(error instanceof ClientError)) throw new Error('Expected a failure.');
  return error;
}

// Haversine, as the filter computes it, to compare against.
function kilometres(
  [lonA, latA]: [number, number],
  [lonB, latB]: [number, number],
): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(latB - latA) / 2) ** 2 +
    Math.cos(rad(latA)) *
      Math.cos(rad(latB)) *
      Math.sin(rad(lonB - lonA) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const LONDON: [number, number] = [-0.1276, 51.5072];
const PARIS: [number, number] = [2.3522, 48.8566];
const NEW_YORK: [number, number] = [-74.006, 40.7128];
const DAR_ES_SALAAM: [number, number] = [39.2083, -6.7924];

describe('field types over real data', () => {
  let t: TestDatabase;
  let nb: NextBase;
  let admin: NextBaseClient;
  let users: Collection;

  // A superuser always gets the record back.
  const records = (name: string) => {
    const service = admin.collection(name);
    const found = <T>(record: T | null): T => {
      if (record === null) throw new Error('Expected a record.');
      return record;
    };
    return {
      create: async (body: Record<string, unknown>) =>
        found(await service.create(body)),
      update: async (id: string, body: Record<string, unknown>) =>
        found(await service.update(id, body)),
      getOne: (id: string) => service.getOne(id),
      getFullList: (options: { filter?: string; sort?: string }) =>
        service.getFullList(options),
      delete: (id: string) => service.delete(id),
    };
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    nb = new NextBase({ database: t.pool, ...quiet });
    admin = nb.client({ superuser: true });
    users = await admin.collections.create({
      name: 'users',
      type: 'auth',
      fields: [{ name: 'name', type: 'text', presentable: true }],
    });
  });

  afterAll(async () => {
    await nb.flush();
    await t.close();
  });

  it('round-trips presentable through the API', async () => {
    const stored = await admin.collections.getOne('users');
    expect(stored.fields.find((f) => f.name === 'name')).toMatchObject({
      presentable: true,
    });
    expect(stored.fields.find((f) => f.name === 'email')).toMatchObject({
      presentable: false,
    });
  });

  describe('minSelect', () => {
    let ids: string[];

    beforeAll(async () => {
      ids = [];
      for (let i = 0; i < 3; i++) {
        const user = await records('users').create({
          email: `u${i}@example.com`,
          password: 'a long enough password',
          passwordConfirm: 'a long enough password',
        });
        ids.push(user.id);
      }
      await admin.collections.create({
        name: 'teams',
        fields: [
          { name: 'title', type: 'text' },
          {
            name: 'optional',
            type: 'relation',
            collectionId: users.id,
            minSelect: 2,
            maxSelect: 3,
          },
          {
            name: 'mandatory',
            type: 'relation',
            collectionId: users.id,
            required: true,
            minSelect: 2,
            maxSelect: 3,
          },
        ],
      });
    });

    it('lets an empty value through unless required', async () => {
      const team = await records('teams').create({
        mandatory: ids.slice(0, 2),
      });
      expect(team.optional).toEqual([]);
      const error = await failure(records('teams').create({}));
      expect(error.data).toMatchObject({
        mandatory: { code: 'validation_required' },
      });
      expect(error.data).not.toHaveProperty('optional');
    });

    it('rejects too few on create and update', async () => {
      const short = await failure(
        records('teams').create({
          optional: [ids[0]],
          mandatory: [ids[0]],
        }),
      );
      expect(short.data).toMatchObject({
        optional: { code: 'validation_too_few', message: 'Select at least 2.' },
        mandatory: { code: 'validation_too_few' },
      });
      const team = await records('teams').create({
        optional: ids.slice(0, 2),
        mandatory: ids,
      });
      const update = await failure(
        records('teams').update(team.id, { 'optional-': [ids[0]] }),
      );
      expect(update.data).toMatchObject({
        optional: { code: 'validation_too_few' },
      });
      // Removing them all is fine for a field that is not required.
      await records('teams').update(team.id, { optional: [] });
    });

    it('lets deletes leave a relation short, until the record is written again', async () => {
      const extra = await records('users').create({
        email: 'extra@example.com',
        password: 'a long enough password',
        passwordConfirm: 'a long enough password',
      });
      const team = await records('teams').create({
        optional: [ids[0], extra.id],
        mandatory: [ids[1], ids[2]],
      });
      await records('users').delete(extra.id);
      const left = await records('teams').getOne(team.id);
      expect(left.optional).toEqual([ids[0]]);
      const error = await failure(
        records('teams').update(team.id, { title: 'renamed' }),
      );
      expect(error.data).toMatchObject({
        optional: { code: 'validation_too_few' },
      });
      await records('teams').update(team.id, {
        title: 'renamed',
        'optional+': ids[1],
      });
    });
  });

  describe('autogeneratePattern', () => {
    beforeAll(async () => {
      await admin.collections.create({
        name: 'invoices',
        createRule: '@request.body.code:isset = false',
        viewRule: '',
        fields: [
          {
            name: 'code',
            type: 'text',
            pattern: '^INV-[0-9]{6}$',
            autogeneratePattern: 'INV-\\d{6}',
          },
          { name: 'note', type: 'text' },
        ],
      });
    });

    it('generates a value on create when none is sent, or a blank one', async () => {
      const a = await records('invoices').create({});
      const b = await records('invoices').create({ code: '' });
      expect(a.code).toMatch(/^INV-\d{6}$/);
      expect(b.code).toMatch(/^INV-\d{6}$/);
    });

    it('keeps a value that is sent, which must still be valid', async () => {
      const sent = await records('invoices').create({ code: 'INV-000001' });
      expect(sent.code).toBe('INV-000001');
      const error = await failure(records('invoices').create({ code: 'nope' }));
      expect(error.data).toMatchObject({
        code: { code: 'validation_invalid_format' },
      });
    });

    it('generates nothing on update, and leaves the value out of @request.body', async () => {
      const record = await records('invoices').create({});
      const updated = await records('invoices').update(record.id, {
        code: '',
        note: 'x',
      });
      expect(updated.code).toBe('');
      // The create rule saw no code in the body, though one was generated.
      const anyone = nb.client();
      const created = await anyone.collection('invoices').create({});
      expect(created?.code).toMatch(/^INV-\d{6}$/);
    });
  });

  describe('editor', () => {
    beforeAll(async () => {
      await admin.collections.create({
        name: 'pages',
        listRule: '',
        fields: [
          { name: 'title', type: 'text' },
          { name: 'body', type: 'editor', maxSize: 200, required: true },
        ],
      });
    });

    it('stores sanitized HTML', async () => {
      const page = await records('pages').create({
        title: 'a',
        body: '<p onclick="x()">Hi <a href="javascript:alert(1)">there</a></p><script>alert(1)</script><img src="https://x.test/a.png" onerror="alert(1)">',
      });
      expect(page.body).toBe(
        '<p>Hi <a>there</a></p><img src="https://x.test/a.png" />',
      );
      const read = await records('pages').getOne(page.id);
      expect(read.body).toBe(page.body);
    });

    it('refuses deep nesting before sanitizing it', async () => {
      await admin.collections.create({
        name: 'notes',
        fields: [{ name: 'body', type: 'editor' }],
      });
      // About 500 KB, which took seconds to sanitize.
      const start = performance.now();
      const deep = await failure(
        records('notes').create({ body: '<b>'.repeat(170_000) }),
      );
      expect(performance.now() - start).toBeLessThan(1000);
      expect(deep.status).toBe(400);
      expect(deep.data).toMatchObject({
        body: { code: 'validation_invalid_value' },
      });
    });

    it('enforces maxSize and required', async () => {
      const big = await failure(
        records('pages').create({ body: `<p>${'x'.repeat(300)}</p>` }),
      );
      expect(big.data).toMatchObject({
        body: { code: 'validation_too_large' },
      });
      // Within the limit once the script is gone, but the input is checked first.
      const scripted = await failure(
        records('pages').create({
          body: `<p>ok</p><script>${'x'.repeat(250)}</script>`,
        }),
      );
      expect(scripted.data).toMatchObject({
        body: { code: 'validation_too_large' },
      });
      // Nothing left after sanitizing is blank.
      const empty = await failure(
        records('pages').create({ body: '<script>x</script>' }),
      );
      expect(empty.data).toMatchObject({
        body: { code: 'validation_required' },
      });
      const wrong = await failure(records('pages').create({ body: 5 }));
      expect(wrong.data).toMatchObject({
        body: { code: 'validation_invalid_type' },
      });
    });

    it('filters and sorts as text', async () => {
      await records('pages').create({
        title: 'b',
        body: '<p>Zebra crossing</p>',
      });
      await records('pages').create({ title: 'c', body: '<h1>Apple pie</h1>' });
      const found = await records('pages').getFullList({
        filter: 'body ~ "zebra"',
      });
      expect(found.map((p) => p.title)).toEqual(['b']);
      const sorted = await records('pages').getFullList({
        filter: 'title = "b" || title = "c"',
        sort: 'body',
      });
      expect(sorted.map((p) => p.title)).toEqual(['c', 'b']);
    });
  });

  describe('geoPoint', () => {
    const city = async (name: string, [lon, lat]: [number, number]) =>
      records('cities').create({ name, at: { lon, lat } });

    beforeAll(async () => {
      const cities = await admin.collections.create({
        name: 'cities',
        fields: [
          { name: 'name', type: 'text' },
          { name: 'at', type: 'geoPoint' },
        ],
      });
      await admin.collections.create({
        name: 'trips',
        fields: [
          { name: 'label', type: 'text' },
          { name: 'to', type: 'relation', collectionId: cities.id },
        ],
      });
      await city('London', LONDON);
      await city('Paris', PARIS);
      await city('New York', NEW_YORK);
      await city('Dar es Salaam', DAR_ES_SALAAM);
    });

    it('stores { lon, lat }, blank as zeros, from JSON or form text', async () => {
      const blank = await records('cities').create({ name: 'none' });
      expect(blank.at).toEqual({ lon: 0, lat: 0 });
      const text = await records('cities').create({
        name: 'text',
        at: '{"lon": 1.5, "lat": -2, "x": 3}',
      });
      expect(text.at).toEqual({ lon: 1.5, lat: -2 });
      const nulled = await records('cities').update(text.id, { at: null });
      expect(nulled.at).toEqual({ lon: 0, lat: 0 });
      await records('cities').delete(blank.id);
      await records('cities').delete(text.id);
    });

    it('rejects coordinates out of range and other shapes', async () => {
      const bad = async (at: unknown, code: string) => {
        const error = await failure(
          records('cities').create({ name: 'bad', at }),
        );
        expect(error.data, JSON.stringify(at)).toMatchObject({ at: { code } });
      };
      await bad({ lon: 180.1, lat: 0 }, 'validation_out_of_range');
      await bad({ lon: -180.1, lat: 0 }, 'validation_out_of_range');
      await bad({ lon: 0, lat: 90.5 }, 'validation_out_of_range');
      await bad({ lon: 0, lat: -91 }, 'validation_out_of_range');
      await bad({ lon: '1', lat: 0 }, 'validation_invalid_type');
      await bad({ lat: 0 }, 'validation_invalid_type');
      await bad([1, 2], 'validation_invalid_type');
      await bad('nope', 'validation_invalid_type');
      await bad(5, 'validation_invalid_type');
      // The edges are allowed.
      const edge = await records('cities').create({
        name: 'edge',
        at: { lon: 180, lat: -90 },
      });
      await records('cities').delete(edge.id);
    });

    it('fails a required field left at { lon: 0, lat: 0 }', async () => {
      await admin.collections.create({
        name: 'stops',
        fields: [{ name: 'at', type: 'geoPoint', required: true }],
      });
      for (const at of [undefined, { lon: 0, lat: 0 }, null]) {
        const error = await failure(records('stops').create({ at }));
        expect(error.data).toMatchObject({
          at: { code: 'validation_required' },
        });
      }
      const stop = await records('stops').create({
        at: { lon: 0, lat: 0.0001 },
      });
      expect(stop.at).toEqual({ lon: 0, lat: 0.0001 });
    });

    it('filters by coordinate', async () => {
      const names = (filter: string): Promise<string[]> =>
        records('cities')
          .getFullList({ filter, sort: 'name' })
          .then((rows: RecordModel[]) => rows.map((r) => r.name as string));
      expect(await names('at.lat > 45')).toEqual(['London', 'Paris']);
      expect(await names('at.lon < 0 && at.lat < 45')).toEqual(['New York']);
      expect(await names('at.lat < 0')).toEqual(['Dar es Salaam']);
    });

    it('computes geoDistance in kilometres, within 1% of known distances', async () => {
      // London to Paris is about 344 km, London to New York about 5570 km.
      expect(kilometres(LONDON, PARIS)).toBeCloseTo(343.5, 0);
      const near = (km: number) => [km * 0.99, km * 1.01];
      const within = async (from: [number, number], km: number) => {
        const [low, high] = near(km);
        return records('cities')
          .getFullList({
            filter: `geoDistance(at.lon, at.lat, ${from[0]}, ${from[1]}) > ${low} && geoDistance(at.lon, at.lat, ${from[0]}, ${from[1]}) < ${high}`,
          })
          .then((rows: RecordModel[]) => rows.map((r) => r.name));
      };
      expect(await within(LONDON, 344)).toEqual(['Paris']);
      expect(await within(LONDON, 5570)).toEqual(['New York']);
      expect(await within(PARIS, kilometres(PARIS, DAR_ES_SALAAM))).toEqual([
        'Dar es Salaam',
      ]);
      const close = await records('cities').getFullList({
        filter: `geoDistance(at.lon, at.lat, ${PARIS[0]}, ${PARIS[1]}) < 400`,
        sort: 'name',
      });
      expect(close.map((r) => r.name)).toEqual(['London', 'Paris']);
      // A point is zero from itself, never NaN from rounding.
      const self = await records('cities').getFullList({
        filter: `geoDistance(at.lon, at.lat, ${LONDON[0]}, ${LONDON[1]}) = 0`,
      });
      expect(self.map((r) => r.name)).toEqual(['London']);
    });

    it('reads geo points through a relation', async () => {
      const [paris] = await records('cities').getFullList({
        filter: 'name = "Paris"',
      });
      await records('trips').create({ label: 'short', to: paris?.id });
      await records('trips').create({ label: 'nowhere' });
      const trips = await records('trips').getFullList({
        filter: `geoDistance(to.at.lon, to.at.lat, ${LONDON[0]}, ${LONDON[1]}) < 500`,
      });
      expect(trips.map((r) => r.label)).toEqual(['short']);
    });

    it('cannot sort by a whole geo point', async () => {
      const error = await failure(
        records('cities').getFullList({ sort: 'at' }),
      );
      expect(error.status).toBe(400);
    });
  });

  it('loads collections stored before these settings with their defaults', async () => {
    await admin.collections.create({
      name: 'legacy',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'owner', type: 'relation', collectionId: users.id },
      ],
    });
    // Strips the new settings, as an older release stored them.
    await t.pool.query(
      `UPDATE nextbase._collections SET fields = (
         SELECT jsonb_agg(f - 'presentable' - 'autogeneratePattern' - 'minSelect' ORDER BY i)
         FROM jsonb_array_elements(fields) WITH ORDINALITY AS e(f, i)
       ) WHERE name = 'legacy'`,
    );
    const fresh = new NextBase({ database: t.pool, ...quiet });
    const legacy = await fresh
      .client({ superuser: true })
      .collections.getOne('legacy');
    expect(legacy.fields).toEqual([
      expect.objectContaining({
        name: 'id',
        presentable: false,
        autogeneratePattern: '[a-z0-9]{15}',
      }),
      expect.objectContaining({
        name: 'title',
        presentable: false,
        autogeneratePattern: '',
      }),
      expect.objectContaining({
        name: 'owner',
        presentable: false,
        minSelect: 0,
      }),
    ]);
    await fresh.flush();
  });
});

describe('migration files with the new field settings', () => {
  const databases: TestDatabase[] = [];
  const instances: NextBase[] = [];
  let dir: string;

  afterAll(async () => {
    for (const nextbase of instances) await nextbase.flush();
    for (const t of databases) await t.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('rebuild the same collections elsewhere', async () => {
    dir = await mkdtemp(join(tmpdir(), 'nextbase-field-migrations-'));
    const instance = async (migrations: Migrations) => {
      const t = await createTestDatabase();
      databases.push(t);
      const nextbase = new NextBase({ database: t.pool, migrations, ...quiet });
      instances.push(nextbase);
      return nextbase;
    };
    const source = await instance({ dir, files: {}, automigrate: true });
    const admin = source.client({ superuser: true });
    const users = await admin.collections.create({
      name: 'members',
      type: 'auth',
    });
    const places = await admin.collections.create({
      name: 'places',
      fields: [
        {
          name: 'code',
          type: 'text',
          presentable: true,
          autogeneratePattern: '[A-Z]{4}',
        },
        { name: 'body', type: 'editor', maxSize: 1000, convertURLs: true },
        { name: 'at', type: 'geoPoint', required: true },
        {
          name: 'crew',
          type: 'relation',
          collectionId: users.id,
          minSelect: 1,
          maxSelect: 4,
        },
      ],
    });
    // A change to the new settings alone also writes a migration.
    await admin.collections.update(places.id, {
      fields: places.fields.map((f) =>
        f.name === 'crew' ? { ...f, minSelect: 2, presentable: true } : f,
      ),
    });

    const mod = (await import(`${join(dir, 'index.ts')}?v=${Date.now()}`)) as {
      default: Migrations;
    };
    const replay = await instance({ ...mod.default, automigrate: false });
    await replay.migrate();
    const list = async (nextbase: NextBase) =>
      (await nextbase.client({ superuser: true }).collections.getFullList())
        .filter((c) => !c.system)
        .map((c) => ({ ...c, tokens: undefined }));
    const replayed = await list(replay);
    expect(replayed).toEqual(await list(source));
    expect(
      replayed
        .find((c) => c.name === 'places')
        ?.fields.find((f) => f.name === 'crew'),
    ).toMatchObject({ minSelect: 2, presentable: true });
  });
});
