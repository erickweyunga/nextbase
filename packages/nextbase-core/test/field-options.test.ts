import type { AuthCollection, Collection, Field } from '@nextbasejs/client';
import { DB, type Expression, type Params } from '@nextbasejs/dbx';
import { describe, expect, it } from 'vitest';
import type { Principal } from '../src/auth/principal.ts';
import { typegen } from '../src/cli/typegen.ts';
import { ApiError } from '../src/errors.ts';
import { compileFilter, ruleProblem } from '../src/filter/compiler.ts';
import { FilterError, parseFilter } from '../src/filter/parser.ts';
import { changeTemplate } from '../src/migrations/templates.ts';
import {
  MAX_GENERATED_LENGTH,
  patternGenerator,
  UnsupportedPattern,
} from '../src/random-pattern.ts';
import { MAX_HTML_DEPTH, sanitizeHtml } from '../src/records/html.ts';
import { Schema } from '../src/schema/cache.ts';
import { parseCollection } from '../src/schema/collection.ts';
import { withFieldDefaults } from '../src/schema/fields.ts';

const db = new DB({
  query: () => Promise.reject(new Error('no database')),
  connect: () => Promise.reject(new Error('no database')),
});

function built(expression: Expression | undefined): {
  sql: string;
  params: Params;
} {
  const params: Params = {};
  return { sql: expression?.build(db, params) ?? '', params };
}

function create(fields: unknown[], others: Collection[] = []): Collection {
  return parseCollection({ name: 'things', fields }, { others });
}

type Problems = Record<string, { code: string; message: string } | undefined>;

function errorsOf(fields: unknown[], others: Collection[] = []): Problems {
  try {
    create(fields, others);
  } catch (error) {
    if (error instanceof ApiError) return flatten(error.data, '');
    throw error;
  }
  throw new Error('Expected the collection to be invalid.');
}

// `{ fields: { 0: { name: {...} } } }` as `{ 'fields.0.name': {...} }`.
function flatten(data: unknown, prefix: string): Problems {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && !('code' in value)) {
      Object.assign(out, flatten(value, path));
    } else {
      out[path] = value;
    }
  }
  return out as Problems;
}

function field(collection: Collection, name: string): Field {
  const found = collection.fields.find((f) => f.name === name);
  if (!found) throw new Error(`No field ${name}.`);
  return found;
}

describe('presentable', () => {
  it('defaults to false on every field type, and is kept when set', () => {
    const users = parseCollection(
      { id: 'users0000000000', name: 'users', type: 'auth' },
      { others: [] },
    );
    const types = [
      { type: 'text' },
      { type: 'number' },
      { type: 'bool' },
      { type: 'email' },
      { type: 'phone' },
      { type: 'url' },
      { type: 'date' },
      { type: 'autodate' },
      { type: 'select', values: ['a'] },
      { type: 'relation', collectionId: users.id },
      { type: 'file' },
      { type: 'json' },
      { type: 'editor' },
      { type: 'geoPoint' },
    ];
    const plain = create(
      types.map((t, i) => ({ ...t, name: `f${i}` })),
      [users],
    );
    expect(plain.fields.every((f) => f.presentable === false)).toBe(true);
    const shown = create(
      types.map((t, i) => ({ ...t, name: `f${i}`, presentable: true })),
      [users],
    );
    expect(
      shown.fields.filter((f) => !f.system).every((f) => f.presentable),
    ).toBe(true);
  });

  it('can be set on system fields, unlike their other settings', () => {
    const users = parseCollection(
      { name: 'users', type: 'auth' },
      { others: [] },
    );
    const updated = parseCollection(
      {
        fields: users.fields.map((f) =>
          f.name === 'email'
            ? { ...f, presentable: true }
            : f.name === 'id'
              ? { ...f, presentable: true, min: 3 }
              : f,
        ),
      },
      { existing: users, others: [] },
    );
    expect(field(updated, 'email').presentable).toBe(true);
    expect(field(updated, 'id')).toMatchObject({ presentable: true, min: 15 });
  });

  it('rejects anything but a boolean', () => {
    expect(
      errorsOf([{ name: 'a', type: 'text', presentable: 'yes' }]),
    ).toMatchObject({
      'fields.0.presentable': { code: 'validation_invalid_type' },
    });
  });
});

describe('relation minSelect', () => {
  const users = parseCollection(
    { id: 'users0000000000', name: 'users', type: 'auth' },
    { others: [] },
  );
  const relation = (options: Record<string, unknown>) => ({
    name: 'members',
    type: 'relation',
    collectionId: users.id,
    ...options,
  });

  it('defaults to 0 and may be up to maxSelect', () => {
    expect(field(create([relation({})], [users]), 'members')).toMatchObject({
      minSelect: 0,
      maxSelect: 1,
    });
    expect(
      field(
        create([relation({ minSelect: 3, maxSelect: 3 })], [users]),
        'members',
      ),
    ).toMatchObject({ minSelect: 3, maxSelect: 3 });
  });

  it('rejects a negative value, a fraction or one above maxSelect', () => {
    for (const minSelect of [-1, 1.5, 4]) {
      expect(
        errorsOf([relation({ minSelect, maxSelect: 3 })], [users]),
      ).toHaveProperty(['fields.0.minSelect']);
    }
  });
});

describe('text autogeneratePattern', () => {
  it('defaults to off', () => {
    expect(
      field(create([{ name: 'code', type: 'text' }]), 'code'),
    ).toMatchObject({ autogeneratePattern: '' });
  });

  it('accepts bounded patterns that fit the field', () => {
    const things = create([
      {
        name: 'code',
        type: 'text',
        min: 6,
        max: 12,
        pattern: '^[A-Z]{3}-\\d+$',
        autogeneratePattern: '[A-Z]{3}-\\d{2,8}',
      },
    ]);
    expect(field(things, 'code')).toMatchObject({
      autogeneratePattern: '[A-Z]{3}-\\d{2,8}',
    });
  });

  it.each([
    ['[a-z]+', '"+"'],
    ['[a-z]*', '"*"'],
    ['[a-z]{3,}', '{3,}'],
    ['[^a-z]{4}', '[^'],
    ['\\D{4}', '\\D'],
    ['\\w{3}\\b', '\\b'],
    ['(?=a)abc', '(?='],
    ['(a)\\1', '\\1'],
    ['\\p{L}{3}', '\\p'],
    ['ab^c', '"^"'],
  ])('rejects the unsupported pattern %s', (pattern, mention) => {
    const errors = errorsOf([
      { name: 'code', type: 'text', autogeneratePattern: pattern },
    ]);
    expect(errors['fields.0.autogeneratePattern']).toMatchObject({
      code: 'validation_invalid_value',
    });
    expect(errors['fields.0.autogeneratePattern']?.message).toContain(
      mention.replaceAll('"', ''),
    );
  });

  it('rejects invalid regexes, and ones whose values the field would refuse', () => {
    const problem = (options: Record<string, unknown>): string | undefined =>
      errorsOf([{ name: 'code', type: 'text', ...options }])[
        'fields.0.autogeneratePattern'
      ]?.message;
    expect(problem({ autogeneratePattern: '[a-z' })).toBe(
      'Must be a valid regular expression.',
    );
    expect(problem({ max: 5, autogeneratePattern: '[a-z]{3,6}' })).toContain(
      'Generates values of 3 to 6 characters',
    );
    expect(problem({ min: 4, autogeneratePattern: '[a-z]{3}' })).toContain(
      'the field takes 4 to 5000',
    );
    // Values must not be blank.
    expect(problem({ autogeneratePattern: '(ab)?' })).toContain(
      'Generates values of 0 to 2',
    );
    expect(
      problem({ pattern: '^\\d+$', autogeneratePattern: '[a-z]{8}' }),
    ).toMatch(
      /^Can generate values that do not match pattern, such as "[a-z]{8}"\.$/,
    );
    expect(
      problem({ autogeneratePattern: `[a-z]{${MAX_GENERATED_LENGTH}}b` }),
    ).toContain('the limit is 5000');
    expect(
      problem({ autogeneratePattern: `[a-z]{${MAX_GENERATED_LENGTH + 1}}` }),
    ).toContain('at most {5000}');
  });

  it('rejects, quickly, patterns that would hang or slow down generating', () => {
    const huge = `1${'0'.repeat(400)}`;
    const start = performance.now();
    for (const [pattern, mention] of [
      [`a(){${huge}}`, 'must be able to generate a character'],
      ['(?:(){1e400}|a{6000})', 'valid regular expression'],
      [`(?:(){${huge}}|a{6000})`, 'must be able to generate a character'],
      ['a((){100000}){100000}', 'must be able to generate a character'],
      ['a(){99999999}', 'must be able to generate a character'],
      ['a(?:){5}', 'must be able to generate a character'],
      [`a{${huge}}`, 'at most {5000}'],
      [`(?:a{6000}|b){0}`, 'at most {5000}'],
      [`a(?:b?){${Number.MAX_SAFE_INTEGER + 2}}`, 'at most {5000}'],
      // Within the length limit, but each character takes 60 steps.
      [`a(?:${'('.repeat(29)}b${'|)'.repeat(29)}){4999}`, 'too many steps'],
      // Each character walks the class's 300 ranges.
      [
        `[${Array.from({ length: 300 }, (_, i) => String.fromCodePoint(0x4e00 + i * 2)).join('')}]{5000}`,
        'too many steps',
      ],
      [`(?:${Array(300000).fill('a').join('|')})`, 'at most 1000 characters'],
      [
        `[${Array.from({ length: 240000 }, (_, i) => String.fromCodePoint(0x10000 + i * 2)).join('')}]{5000}`,
        'at most 1000 characters',
      ],
    ]) {
      // A field pattern makes the check generate sample values too.
      const errors = errorsOf([
        {
          name: 'code',
          type: 'text',
          pattern: '^.*$',
          autogeneratePattern: pattern,
        },
      ]);
      expect(
        errors['fields.0.autogeneratePattern']?.message,
        pattern,
      ).toContain(mention);
    }
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('describes how the system id and tokenKey fields are generated', () => {
    const users = parseCollection(
      { name: 'users', type: 'auth' },
      { others: [] },
    );
    expect(field(users, 'id')).toMatchObject({
      autogeneratePattern: '[a-z0-9]{15}',
    });
    expect(field(users, 'tokenKey')).toMatchObject({
      autogeneratePattern: '[a-zA-Z0-9]{50}',
    });
  });
});

describe('patternGenerator', () => {
  it.each([
    ['[a-z0-9]{15}', 15, 15],
    ['^INV-\\d{4}$', 8, 8],
    ['(?:ab|cde){2}', 4, 6],
    ['(?<year>20\\d{2})-[01]\\d', 7, 7],
    ['x.?y', 2, 3],
    ['[\\w.-]{1,5}@ex\\.com', 8, 12],
    ['\\x41\\u0042\\u{1F600}[\\t ]', 4, 4],
    ['[a-c]{2}?', 2, 2],
    ['(a|){5000}', 0, 5000],
    ['((a?){70}){70}', 0, 4900],
  ])('generates values matching %s', (pattern, min, max) => {
    const generator = patternGenerator(pattern);
    expect([generator.minLength, generator.maxLength]).toEqual([min, max]);
    const regex = new RegExp(`^(?:${pattern.replace(/^\^|\$$/g, '')})$`, 'u');
    for (let i = 0; i < 200; i++) {
      const value = generator.generate();
      expect(value).toMatch(regex);
      expect([...value].length).toBeGreaterThanOrEqual(min);
      expect([...value].length).toBeLessThanOrEqual(max);
    }
  });

  it('chooses evenly among the characters of a class', () => {
    const generator = patternGenerator('[ab]');
    let a = 0;
    for (let i = 0; i < 2000; i++) if (generator.generate() === 'a') a++;
    // Far outside chance for a fair coin: 1000 +- 150 is about 6.7 sigma.
    expect(a).toBeGreaterThan(850);
    expect(a).toBeLessThan(1150);
  });

  it('never generates NUL or lone surrogates', () => {
    const generator = patternGenerator('[\\u0000-\\u0001\\ud800-\\udfff]');
    for (let i = 0; i < 50; i++) expect(generator.generate()).toBe('\u0001');
    expect(() => patternGenerator('\\x00')).toThrow(UnsupportedPattern);
  });
});

describe('editor fields', () => {
  it('default to 512 KiB, keep convertURLs, and need a positive maxSize', () => {
    expect(field(create([{ name: 'body', type: 'editor' }]), 'body')).toEqual({
      id: expect.any(String),
      name: 'body',
      type: 'editor',
      system: false,
      required: false,
      hidden: false,
      presentable: false,
      maxSize: 512 * 1024,
      convertURLs: false,
    });
    expect(
      field(
        create([
          { name: 'body', type: 'editor', maxSize: 100, convertURLs: true },
        ]),
        'body',
      ),
    ).toMatchObject({ maxSize: 100, convertURLs: true });
    expect(
      errorsOf([{ name: 'body', type: 'editor', maxSize: 0 }]),
    ).toHaveProperty(['fields.0.maxSize']);
  });
});

describe('sanitizeHtml', () => {
  it('keeps the formatting rich-text editors produce', () => {
    const html = [
      '<h1>Title</h1><h3>Sub</h3>',
      '<p>Some <strong>bold</strong>, <em>italic</em>, <u>under</u>, <s>gone</s>, <sub>2</sub><sup>3</sup> and <code>code</code>.<br /></p>',
      '<blockquote><p>Quote</p></blockquote>',
      '<pre><code class="language-ts">const a = 1;</code></pre>',
      '<ul><li>one</li></ul><ol start="3"><li>three</li></ol>',
      '<p><a href="https://example.com/a?b=1" title="Ex" target="_blank" rel="noopener noreferrer">link</a> <a href="mailto:a@example.com">mail</a> <a href="/relative">rel</a></p>',
      '<figure><img src="https://example.com/a.png" alt="A" width="10" height="20" /><figcaption>Cap</figcaption></figure>',
      '<table><thead><tr><th scope="col">H</th></tr></thead><tbody><tr><td colspan="2">C</td></tr></tbody></table>',
      '<hr />',
    ].join('');
    expect(sanitizeHtml(html)).toBe(html);
  });

  it('strips scripts, event handlers, styles and dangerous URLs', () => {
    const cases: [string, string][] = [
      ['<p>a<script>alert(1)</script>b</p>', '<p>ab</p>'],
      [
        '<img src="https://x.test/a.png" onerror="alert(1)">',
        '<img src="https://x.test/a.png" />',
      ],
      ['<p onclick="alert(1)" onmouseover="x()">hi</p>', '<p>hi</p>'],
      ['<a href="javascript:alert(1)">x</a>', '<a>x</a>'],
      ['<a href="  JaVaScRiPt:alert(1)">x</a>', '<a>x</a>'],
      ['<a href="jav&#x09;ascript:alert(1)">x</a>', '<a>x</a>'],
      ['<a href="data:text/html,<script>alert(1)</script>">x</a>', '<a>x</a>'],
      ['<a href="vbscript:msgbox(1)">x</a>', '<a>x</a>'],
      ['<img src="data:image/png;base64,AAAA">', '<img />'],
      ['<img src="javascript:alert(1)">', '<img />'],
      ['<p style="background:url(javascript:alert(1))">x</p>', '<p>x</p>'],
      ['<style>p{color:red}</style><p>x</p>', '<p>x</p>'],
      ['<iframe src="https://evil.test"></iframe>x', 'x'],
      ['<object data="x"></object><embed src="x">x', 'x'],
      ['<svg><script>alert(1)</script></svg>x', 'x'],
      [
        '<math><mtext><img src=x onerror=alert(1)></mtext></math>',
        '<img src="x" />',
      ],
      ['<form action="https://evil.test"><input name="a"></form>x', 'x'],
      ['<p class="evil" id="clobber">x</p>', '<p>x</p>'],
      [
        '<base href="https://evil.test"><meta http-equiv="refresh" content="0">x',
        'x',
      ],
      ['<a href="//evil.test">x</a>', '<a>x</a>'],
      [
        '<a href="https://x.test" target="_top">x</a>',
        '<a href="https://x.test">x</a>',
      ],
      ['<!-- <script>alert(1)</script> -->x', 'x'],
    ];
    for (const [input, output] of cases) {
      expect(sanitizeHtml(input), input).toBe(output);
    }
  });

  it('makes links that open a new tab unable to reach back', () => {
    expect(
      sanitizeHtml(
        '<a href="https://x.test" target="_blank" rel="nofollow">x</a>',
      ),
    ).toBe(
      '<a href="https://x.test" target="_blank" rel="nofollow noopener noreferrer">x</a>',
    );
  });

  it('refuses deep nesting quickly, however large', () => {
    const deep = '<b>'.repeat(MAX_HTML_DEPTH);
    expect(sanitizeHtml(`${deep}x`)).toBe(
      `${deep}x${'</b>'.repeat(MAX_HTML_DEPTH)}`,
    );
    expect(sanitizeHtml(`${deep}<b>x`)).toBeNull();
    // Each took seconds when the parser's cost grew with its open elements.
    const start = performance.now();
    for (const unit of ['<b>', '<x>', '<table><tr><td>', '<div><span>']) {
      expect(
        sanitizeHtml(unit.repeat(Math.ceil(1e6 / unit.length))),
        unit,
      ).toBeNull();
    }
    expect(sanitizeHtml('<b>'.repeat(11_000_000))).toBeNull();
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('sanitizes at the deepest nesting in linear time', () => {
    const deep = '<b>'.repeat(MAX_HTML_DEPTH - 1);
    const start = performance.now();
    for (const unit of ['<i>a</i>', '</x>', '<br>', '</p>', '<']) {
      sanitizeHtml(deep + unit.repeat(Math.ceil((512 * 1024) / unit.length)));
    }
    expect(performance.now() - start).toBeLessThan(5000);
  });
});

describe('geoPoint fields', () => {
  it('have no settings of their own', () => {
    expect(field(create([{ name: 'at', type: 'geoPoint' }]), 'at')).toEqual({
      id: expect.any(String),
      name: 'at',
      type: 'geoPoint',
      system: false,
      required: false,
      hidden: false,
      presentable: false,
    });
  });
});

describe('collections stored before these settings', () => {
  it('load with their defaults', () => {
    const legacy = (value: Record<string, unknown>) =>
      withFieldDefaults(value as unknown as Field);
    const base = {
      id: 'abcdefghij',
      name: 'a',
      system: false,
      required: false,
      hidden: false,
    };
    expect(legacy({ ...base, type: 'bool' })).toEqual({
      ...base,
      type: 'bool',
      presentable: false,
    });
    expect(
      legacy({
        ...base,
        type: 'text',
        min: 0,
        max: 10,
        pattern: '',
        primaryKey: false,
      }),
    ).toMatchObject({ presentable: false, autogeneratePattern: '' });
    expect(
      legacy({
        ...base,
        id: '_id',
        name: 'id',
        system: true,
        type: 'text',
        primaryKey: true,
      }),
    ).toMatchObject({ autogeneratePattern: '[a-z0-9]{15}' });
    expect(
      legacy({
        ...base,
        id: '_tokenKey',
        name: 'tokenKey',
        system: true,
        type: 'text',
        primaryKey: false,
      }),
    ).toMatchObject({ autogeneratePattern: '[a-zA-Z0-9]{50}' });
    expect(
      legacy({
        ...base,
        type: 'relation',
        collectionId: 'x',
        maxSelect: 2,
        cascadeDelete: false,
      }),
    ).toMatchObject({ minSelect: 0, presentable: false });
    // Settings already stored are kept.
    expect(legacy({ ...base, type: 'bool', presentable: true })).toMatchObject({
      presentable: true,
    });
  });
});

describe('geoDistance and geo point filters', () => {
  const places = parseCollection(
    {
      id: 'places000000000',
      name: 'places',
      fields: [
        { name: 'name', type: 'text' },
        { name: 'at', type: 'geoPoint' },
        { name: 'body', type: 'editor' },
        { name: 'tags', type: 'select', values: ['a', 'b'], maxSelect: 2 },
      ],
    },
    { others: [] },
  );
  const visits = parseCollection(
    {
      id: 'visits000000000',
      name: 'visits',
      fields: [
        { name: 'place', type: 'relation', collectionId: places.id },
        {
          name: 'places',
          type: 'relation',
          collectionId: places.id,
          maxSelect: 5,
        },
      ],
    },
    { others: [places] },
  );
  const schema = new Schema(1, [places, visits]);
  const superuser: Principal = { superuser: true };
  const compile = (source: string, collection: Collection = places) =>
    compileFilter(source, collection, 't', {
      schema,
      principal: superuser,
      request: {
        method: 'GET',
        query: { lat: '48.85' },
        headers: {},
        body: {},
      },
      mode: 'filter',
    });
  const problem = (source: string, collection: Collection = places) => {
    try {
      compile(source, collection);
    } catch (error) {
      if (error instanceof FilterError) return error.message;
      throw error;
    }
    return undefined;
  };

  it('parses calls with arguments', () => {
    expect(parseFilter('geoDistance(at.lon, at.lat, 1, -2.5) < 10')).toEqual({
      kind: 'comparison',
      op: '<',
      any: false,
      left: {
        kind: 'call',
        name: 'geoDistance',
        args: [
          { kind: 'identifier', path: ['at', 'lon'], modifier: undefined },
          { kind: 'identifier', path: ['at', 'lat'], modifier: undefined },
          { kind: 'literal', value: 1 },
          { kind: 'literal', value: -2.5 },
        ],
      },
      right: { kind: 'literal', value: 10 },
    });
    expect(() => parseFilter('geoDistance(1, 2')).toThrow(FilterError);
    expect(() => parseFilter('geoDistance(1,, 2) < 1')).toThrow(FilterError);
  });

  it('compiles to plain SQL with every value bound', () => {
    const { sql, params } = built(
      compile('geoDistance(at.lon, at.lat, 2.35, 48.85) < 400'),
    );
    expect(Object.values(params)).toEqual([2.35, 48.85, 400]);
    expect(sql).toContain('asin(');
    expect(sql).toContain(`("t"."at" ->> 'lon')::double precision`);
    expect(compile('400 > geoDistance(at.lon, at.lat, 0, 0)')).toBeDefined();
    expect(compile('at.lat > 10 && at.lon <= -3')).toBeDefined();
    expect(
      compile('geoDistance(place.at.lon, place.at.lat, 0, 0) < 5', visits),
    ).toBeDefined();
    expect(compile('body ~ "hello" && body:lower = "x"')).toBeDefined();
  });

  it('rejects what it cannot compute', () => {
    expect(problem('geoDistance(1, 2, 3) < 1')).toContain('takes 4 arguments');
    expect(problem('distance(1, 2, 3, 4) < 1')).toBe(
      'Unknown function "distance".',
    );
    expect(problem('geoDistance(name, 2, 3, 4) < 1')).toContain('Argument 1');
    expect(problem('geoDistance(1, "x", 3, 4) < 1')).toBe(
      '"x" is not a valid number value.',
    );
    expect(problem('geoDistance(1, 2, true, 4) < 1')).toContain('Argument 3');
    expect(
      problem('geoDistance(geoDistance(1, 2, 3, 4), 2, 3, 4) < 1'),
    ).toContain('Argument 1');
    expect(
      problem('geoDistance(places.at.lon, places.at.lat, 0, 0) < 5', visits),
    ).toContain('Argument 1');
    expect(problem('geoDistance(1, 2, 3, 4) ~ "1"')).toContain('~');
    expect(problem('geoDistance(1, 2, 3, 4) = name')).toBe(
      'Both sides of a comparison must have the same type.',
    );
    expect(problem('at = ""')).toContain('compare at.lon or at.lat');
    expect(problem('at.x > 1')).toContain('compare at.lon or at.lat');
    expect(problem('at.lat:lower = 1')).toContain(':lower');
  });

  it('reads coordinates of the signed-in record in rules', () => {
    const users = parseCollection(
      {
        id: 'users0000000000',
        name: 'users',
        type: 'auth',
        fields: [{ name: 'home', type: 'geoPoint' }],
      },
      { others: [] },
    ) as AuthCollection;
    const withUsers = new Schema(1, [places, users]);
    const rule = (source: string, principal: Principal) =>
      compileFilter(source, places, 't', {
        schema: withUsers,
        principal,
        request: { method: 'GET', query: {}, headers: {}, body: {} },
        mode: 'rule',
      });
    const ann: Principal = {
      superuser: false,
      collection: users,
      record: { id: 'ann000000000000', home: { lon: 39.28, lat: -6.82 } },
    };
    expect(
      Object.values(
        built(
          rule(
            'geoDistance(at.lon, at.lat, @request.auth.home.lon, @request.auth.home.lat) < 10',
            ann,
          ),
        ).params,
      ),
    ).toEqual([39.28, -6.82, 10]);
    expect(
      built(
        rule('geoDistance(at.lon, at.lat, @request.auth.home.lon, 0) < 1', {
          superuser: false,
        }),
      ).sql,
    ).toContain('NULL::double precision');
    expect(() => rule('@request.auth.home = 1', ann)).toThrow(
      'compare @request.auth.home.lon or .lat',
    );
  });

  it('refuses rules with a schema field that may not be numeric', () => {
    const users = parseCollection(
      {
        id: 'users0000000000',
        name: 'users',
        type: 'auth',
        fields: [
          { name: 'nickname', type: 'text' },
          { name: 'active', type: 'bool' },
          { name: 'lat', type: 'number' },
          { name: 'home', type: 'geoPoint' },
        ],
      },
      { others: [] },
    );
    const withUsers = new Schema(1, [places, users]);
    const check = (rule: string) => ruleProblem(rule, places, withUsers);
    for (const arg of [
      '@request.auth.nickname',
      '@request.auth.active',
      '@request.auth.collectionId',
      '@request.body.name',
    ]) {
      expect(
        check(`geoDistance(at.lon, at.lat, 0, ${arg}) < 1`),
        arg,
      ).toContain('Argument 4');
    }
    for (const arg of [
      '@request.auth.lat',
      '@request.auth.home.lat',
      '@request.body.unknown',
      '@request.query.lat',
      '@request.headers.x_lat',
    ]) {
      expect(
        check(`geoDistance(at.lon, at.lat, 0, ${arg}) < 1`),
        arg,
      ).toBeUndefined();
    }
  });
});

describe('@request.auth values', () => {
  it('refuses a key after collectionId and collectionName', () => {
    const users = parseCollection(
      { id: 'users0000000000', name: 'users', type: 'auth' },
      { others: [] },
    );
    const posts = parseCollection(
      { id: 'posts0000000000', name: 'posts' },
      { others: [] },
    );
    const schema = new Schema(1, [posts, users]);
    expect(
      ruleProblem('@request.auth.collectionName = "users"', posts, schema),
    ).toBeUndefined();
    for (const value of [
      '@request.auth.collectionId.x',
      '@request.auth.collectionName.anything',
    ]) {
      expect(ruleProblem(`${value} = "users"`, posts, schema), value).toBe(
        `"${value}" is not a supported @request value.`,
      );
    }
  });
});

describe('typegen', () => {
  it('types editor fields as strings and geo points as objects', () => {
    const types = typegen([
      create([
        { name: 'body', type: 'editor' },
        { name: 'at', type: 'geoPoint' },
      ]),
    ]);
    expect(types).toContain(
      '  body: string;\n  at: { lon: number; lat: number };',
    );
  });
});

describe('migration files', () => {
  it('carry the new settings in changes', () => {
    const users = parseCollection(
      { id: 'users0000000000', name: 'users', type: 'auth' },
      { others: [] },
    );
    const before = create([{ name: 'title', type: 'text' }], [users]);
    const after = parseCollection(
      {
        fields: [
          ...before.fields.map((f) =>
            f.name === 'title'
              ? { ...f, presentable: true, autogeneratePattern: '[a-z]{8}' }
              : f,
          ),
          { name: 'body', type: 'editor', maxSize: 1000, convertURLs: true },
          { name: 'at', type: 'geoPoint' },
          {
            name: 'members',
            type: 'relation',
            collectionId: users.id,
            minSelect: 2,
            maxSelect: 3,
          },
        ],
      },
      { existing: before, others: [users] },
    );
    const file = changeTemplate(before, after) as string;
    expect(file).toContain('"presentable": true');
    expect(file).toContain('"autogeneratePattern": "[a-z]{8}"');
    expect(file).toContain('"convertURLs": true');
    expect(file).toContain('"type": "geoPoint"');
    expect(file).toContain('"minSelect": 2');
  });
});
