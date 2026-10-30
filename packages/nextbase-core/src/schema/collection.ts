import type {
  AuthCollection,
  AutodateField,
  Collection,
  Field,
  Index,
  Rule,
  TokenConfig,
  TokenType,
} from '@nextbasejs/client';
import { ApiError } from '../errors.ts';
import {
  ALPHANUMERIC,
  isId,
  LOWER_ALPHANUMERIC,
  newId,
  randomString,
} from '../random.ts';
import {
  DEFAULT_PASSWORD_MAX,
  DEFAULT_PASSWORD_MIN,
  NAME_PATTERN,
  parseEmailOptions,
  parseField,
  parsePasswordOptions,
} from './fields.ts';
import { Issues, isRecord, type Path, Reader } from './input.ts';

const DAY = 86_400;
const MAX_TOKEN_DURATION = 365 * DAY;
const SECRET_LENGTH = 50;
const MIN_SECRET_LENGTH = 30;
const MAX_SECRET_LENGTH = 255;

const RULES = [
  'listRule',
  'viewRule',
  'createRule',
  'updateRule',
  'deleteRule',
] as const;

const DEFAULT_TOKEN_DURATIONS: Readonly<Record<TokenType, number>> = {
  auth: 7 * DAY,
  verification: 3 * DAY,
  passwordReset: 30 * 60,
  emailChange: 30 * 60,
  file: 2 * 60,
};

const TOKEN_TYPES = Object.keys(DEFAULT_TOKEN_DURATIONS) as TokenType[];

export interface CollectionContext {
  /** Undefined when creating. */
  existing?: Collection | undefined;
  others: readonly Collection[];
}

/** Validates untrusted input and fills in defaults; throws a 400 listing every problem. */
export function parseCollection(
  input: unknown,
  context: CollectionContext,
): Collection {
  if (!isRecord(input)) {
    throw new ApiError(400, 'The collection must be a JSON object.');
  }
  const issues = new Issues();
  const r = new Reader(input, [], issues);
  const { existing, others } = context;

  const id = parseId(r, context);
  const type = existing?.type ?? r.string('type', 'base');
  if (type !== 'base' && type !== 'auth' && type !== 'view') {
    r.fail('type', 'validation_invalid_value', 'Must be base, auth or view.');
    throw invalid(issues);
  }
  if (existing && r.has('type') && r.input.type !== existing.type) {
    r.fail(
      'type',
      'validation_immutable',
      "A collection's type cannot change.",
    );
  }

  const name = r.string('name', existing?.name ?? '');
  if (existing?.system) {
    if (name !== existing.name) {
      r.fail(
        'name',
        'validation_immutable',
        'System collections cannot be renamed.',
      );
    }
  } else {
    checkCollectionName(name, r, others);
  }

  const view = type === 'view';
  if (view) {
    for (const key of ['fields', 'indexes']) {
      if (r.has(key)) {
        r.fail(
          key,
          'validation_read_only',
          "A view's fields come from its query, and views have no indexes.",
        );
      }
    }
  }
  // A view's fields are derived from its query when it is created.
  const fields = view
    ? (existing?.fields ?? [])
    : parseFields(r, type, id, context);
  const indexes = view ? [] : parseIndexes(r, fields, name, context);
  const rules = Object.fromEntries(
    RULES.map((key) => [key, parseRule(r, key, existing)]),
  ) as Record<(typeof RULES)[number], Rule>;
  if (view) {
    for (const key of ['createRule', 'updateRule', 'deleteRule'] as const) {
      if (rules[key] !== null) {
        r.fail(
          key,
          'validation_read_only',
          'Views are read-only, so this rule must be null.',
        );
      }
    }
  }
  const base = {
    id,
    name,
    system: existing?.system ?? false,
    fields,
    indexes,
    ...rules,
  };

  let collection: Collection;
  if (type === 'base') {
    collection = { ...base, type };
  } else if (type === 'view') {
    collection = {
      ...base,
      type,
      viewQuery: parseViewQuery(r, existing),
    };
  } else {
    const previous = existing?.type === 'auth' ? existing : undefined;
    collection = {
      ...base,
      type,
      authRule: parseRule(r, 'authRule', previous, ''),
      manageRule: parseRule(r, 'manageRule', previous),
      identityFields: parseIdentityFields(r, fields, indexes, previous),
      phoneSignIn: r.boolean('phoneSignIn', previous?.phoneSignIn ?? false),
      tokens: parseTokens(r, previous?.tokens),
    };
  }

  if (!issues.empty) throw invalid(issues);
  return collection;
}

/** Its rules stay `null`. */
export function superusersCollection(): AuthCollection {
  const tokens = parseTokens(new Reader({}, [], new Issues()), undefined);
  tokens.auth.duration = DAY;
  return {
    id: '_superusers',
    name: '_superusers',
    type: 'auth',
    system: true,
    fields: [...systemFields('auth'), ...defaultFields()],
    indexes: [],
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    authRule: '',
    manageRule: null,
    identityFields: ['email'],
    phoneSignIn: false,
    tokens,
  };
}

const MAX_VIEW_QUERY = 20_000;

function parseViewQuery(r: Reader, existing: Collection | undefined): string {
  const previous = existing?.type === 'view' ? existing.viewQuery : '';
  const query = r.string('viewQuery', previous).trim();
  if (query === '') {
    r.fail('viewQuery', 'validation_required', 'Cannot be blank.');
  } else if (query.length > MAX_VIEW_QUERY) {
    r.fail(
      'viewQuery',
      'validation_max_text_constraint',
      `Must be at most ${MAX_VIEW_QUERY} characters.`,
    );
  }
  return query;
}

function invalid(issues: Issues): ApiError {
  return new ApiError(400, 'Failed to validate the collection.', issues.data);
}

function parseId(r: Reader, { existing, others }: CollectionContext): string {
  if (existing) {
    if (r.has('id') && r.input.id !== existing.id) {
      r.fail('id', 'validation_immutable', "A collection's id cannot change.");
    }
    return existing.id;
  }
  const id = r.string('id', '');
  if (id === '') return newId();
  if (!isId(id)) {
    r.fail(
      'id',
      'validation_invalid_value',
      'Must be 15 lowercase letters or digits.',
    );
  } else if (others.some((c) => c.id === id)) {
    r.fail('id', 'validation_not_unique', 'Another collection has this id.');
  } else if (others.some((c) => c.name.toLowerCase() === id)) {
    // Collections are looked up by id or name, so one must not be the other.
    r.fail('id', 'validation_not_unique', 'Another collection has this name.');
  }
  return id;
}

function checkCollectionName(
  name: string,
  r: Reader,
  others: readonly Collection[],
): void {
  if (!NAME_PATTERN.test(name)) {
    r.fail(
      'name',
      'validation_invalid_name',
      'Must start with a letter and contain only letters, digits and underscores, up to 63 characters.',
    );
    return;
  }
  const lower = name.toLowerCase();
  if (others.some((c) => c.name.toLowerCase() === lower)) {
    r.fail(
      'name',
      'validation_not_unique',
      'Another collection has this name.',
    );
  } else if (others.some((c) => c.id === lower)) {
    // Collections are looked up by id or name, so one must not be the other.
    r.fail('name', 'validation_not_unique', 'Another collection has this id.');
  } else if (
    others.some((c) => c.indexes.some((i) => i.name.toLowerCase() === lower))
  ) {
    r.fail('name', 'validation_not_unique', 'An index has this name.');
  }
}

function parseRule(
  r: Reader,
  key: (typeof RULES)[number] | 'authRule' | 'manageRule',
  existing: Collection | undefined,
  fallback: Rule = null,
): Rule {
  const previous =
    existing && key in existing
      ? (existing[key as keyof Collection] as Rule)
      : fallback;
  const rule = r.stringOrNull(key, previous);
  if (existing?.system && rule !== previous) {
    r.fail(
      key,
      'validation_immutable',
      'System collection rules cannot change.',
    );
    return previous;
  }
  return rule;
}

function systemFields(type: Collection['type']): Field[] {
  const id: Field = {
    id: '_id',
    name: 'id',
    type: 'text',
    system: true,
    required: true,
    hidden: false,
    min: 15,
    max: 15,
    pattern: '^[a-z0-9]+$',
    primaryKey: true,
  };
  if (type === 'base') return [id];
  const flag = (name: string, id = `_${name}`): Field => ({
    id,
    name,
    type: 'bool',
    system: true,
    required: false,
    hidden: false,
  });
  return [
    id,
    {
      id: '_email',
      name: 'email',
      type: 'email',
      system: true,
      required: true,
      hidden: false,
      onlyDomains: [],
      exceptDomains: [],
    },
    flag('emailVisibility'),
    // Its id predates the rename from `verified`; ids never change.
    flag('emailVerified', '_verified'),
    {
      id: '_phone',
      name: 'phone',
      type: 'phone',
      system: true,
      required: false,
      hidden: false,
    },
    flag('phoneVerified'),
    {
      id: '_password',
      name: 'password',
      type: 'password',
      system: true,
      required: true,
      hidden: true,
      min: DEFAULT_PASSWORD_MIN,
      max: DEFAULT_PASSWORD_MAX,
    },
    {
      id: '_tokenKey',
      name: 'tokenKey',
      type: 'text',
      system: true,
      required: true,
      hidden: true,
      min: 30,
      max: 60,
      pattern: '',
      primaryKey: false,
    },
  ];
}

/** For a collection created without fields. */
function defaultFields(): AutodateField[] {
  const autodate = (name: string, onUpdate: boolean): AutodateField => ({
    id: randomString(10, LOWER_ALPHANUMERIC),
    name,
    type: 'autodate',
    system: false,
    required: false,
    hidden: false,
    onCreate: true,
    onUpdate,
  });
  return [autodate('created', false), autodate('updated', true)];
}

function parseFields(
  r: Reader,
  type: Collection['type'],
  selfId: string,
  { existing, others }: CollectionContext,
): Field[] {
  const systemById = new Map(
    (existing?.fields.filter((f) => f.system) ?? systemFields(type)).map(
      (f) => [f.id, f],
    ),
  );
  if (!r.has('fields')) {
    return existing?.fields ?? [...systemById.values(), ...defaultFields()];
  }
  const input = r.input.fields;
  if (!Array.isArray(input)) {
    r.fail('fields', 'validation_invalid_type', 'Must be an array.');
    return existing?.fields ?? [...systemById.values()];
  }

  // Relations need a table with a primary key to reference; views have none.
  const collectionIds = new Set([
    selfId,
    ...others.filter((c) => c.type !== 'view').map((c) => c.id),
  ]);
  const existingById = new Map(existing?.fields.map((f) => [f.id, f]));
  const parsed: { field: Field; path?: Path }[] = [];
  const ids = new Set<string>();

  input.forEach((item: unknown, i) => {
    const path = ['fields', i];
    const system = isRecord(item)
      ? matchSystemField(item, systemById)
      : undefined;
    const field = system
      ? parseSystemField(
          new Reader(item as Record<string, unknown>, path, r.issues),
          system,
        )
      : parseField(item, path, r.issues, {
          collectionIds,
          existing:
            isRecord(item) && typeof item.id === 'string'
              ? existingById.get(item.id)
              : undefined,
        });
    if (!field) return;
    if (ids.has(field.id)) {
      r.issues.add(
        [...path, 'id'],
        'validation_not_unique',
        'Another field has this id.',
      );
      return;
    }
    ids.add(field.id);
    parsed.push({ field, path });
  });

  // System fields cannot be removed: any left out are kept, first.
  const kept = [...systemById.values()].filter((f) => !ids.has(f.id));
  const all: { field: Field; path?: Path }[] = [
    ...kept.map((field) => ({ field })),
    ...parsed,
  ];

  const names = new Set<string>();
  for (const { field, path } of all) {
    const lower = field.name.toLowerCase();
    if (names.has(lower) && path) {
      r.issues.add(
        [...path, 'name'],
        'validation_not_unique',
        'Another field has this name.',
      );
    }
    names.add(lower);
  }
  return all.map(({ field }) => field);
}

// By id; or, for input without an id, by name, so `{ "name": "email", ... }` works.
function matchSystemField(
  item: Record<string, unknown>,
  systemById: ReadonlyMap<string, Field>,
): Field | undefined {
  if (typeof item.id === 'string') return systemById.get(item.id);
  return [...systemById.values()].find((f) => f.name === item.name);
}

// Other properties, which clients echo back, are ignored; a new name or type is an error.
function parseSystemField(r: Reader, field: Field): Field {
  if (r.has('name') && r.input.name !== field.name) {
    r.fail('name', 'validation_immutable', 'System fields cannot be renamed.');
  }
  if (r.has('type') && r.input.type !== field.type) {
    r.fail(
      'type',
      'validation_type_change',
      'System fields cannot change type.',
    );
  }
  if (field.type === 'email') return parseEmailOptions(r, field);
  if (field.type === 'password') return parsePasswordOptions(r, field);
  return field;
}

function parseIndexes(
  r: Reader,
  fields: readonly Field[],
  collectionName: string,
  { existing, others }: CollectionContext,
): Index[] {
  // Revalidated so an index on a removed field is reported, not silently dropped.
  const input: unknown = r.has('indexes')
    ? r.input.indexes
    : (existing?.indexes ?? []);
  if (!Array.isArray(input)) {
    r.fail('indexes', 'validation_invalid_type', 'Must be an array.');
    return [];
  }
  const fieldIds = new Set(fields.map((f) => f.id));
  const taken = new Set([
    collectionName.toLowerCase(),
    ...others.map((c) => c.name.toLowerCase()),
    ...others.flatMap((c) => c.indexes.map((i) => i.name.toLowerCase())),
  ]);

  const indexes: Index[] = [];
  input.forEach((item: unknown, i) => {
    const path = ['indexes', i];
    if (!isRecord(item)) {
      r.issues.add(path, 'validation_invalid_type', 'Must be an object.');
      return;
    }
    const ir = new Reader(item, path, r.issues);
    const name = ir.string('name', '');
    if (!NAME_PATTERN.test(name)) {
      ir.fail(
        'name',
        'validation_invalid_name',
        'Must start with a letter and contain only letters, digits and underscores, up to 63 characters.',
      );
    } else if (taken.has(name.toLowerCase())) {
      ir.fail(
        'name',
        'validation_not_unique',
        'Another index or collection has this name.',
      );
    }
    taken.add(name.toLowerCase());

    const indexFields = ir.strings('fields', []);
    if (indexFields.length === 0) {
      ir.fail('fields', 'validation_required', 'Add at least one field.');
    }
    indexFields.forEach((fieldId, j) => {
      if (!fieldIds.has(fieldId)) {
        r.issues.add(
          [...path, 'fields', j],
          'validation_invalid_value',
          'Must be the id of a field of this collection.',
        );
      } else if (indexFields.indexOf(fieldId) !== j) {
        r.issues.add(
          [...path, 'fields', j],
          'validation_not_unique',
          'Fields must be unique.',
        );
      }
    });
    const unique = ir.boolean('unique', false);
    const type = ir.string('type', 'btree');
    if (type !== 'btree' && type !== 'trigram') {
      ir.fail('type', 'validation_invalid_value', 'Must be btree or trigram.');
    } else if (type === 'trigram') {
      if (unique)
        ir.fail(
          'unique',
          'validation_invalid_value',
          'Trigram indexes cannot be unique.',
        );
      indexFields.forEach((fieldId, j) => {
        const field = fields.find((f) => f.id === fieldId);
        const text =
          field?.type === 'text' ||
          field?.type === 'email' ||
          field?.type === 'url' ||
          (field?.type === 'select' && field.maxSelect === 1);
        if (field && !text) {
          r.issues.add(
            [...path, 'fields', j],
            'validation_invalid_value',
            'Trigram indexes apply to text fields.',
          );
        }
      });
    }
    indexes.push({
      name,
      unique,
      fields: indexFields,
      type: type === 'trigram' ? 'trigram' : 'btree',
    });
  });
  return indexes;
}

function parseIdentityFields(
  r: Reader,
  fields: readonly Field[],
  indexes: readonly Index[],
  existing: AuthCollection | undefined,
): string[] {
  const names = r.strings(
    'identityFields',
    existing?.identityFields ?? ['email'],
  );
  if (names.length === 0) {
    r.fail('identityFields', 'validation_required', 'Add at least one field.');
  }
  names.forEach((name, i) => {
    const path = ['identityFields', i];
    const field = fields.find((f) => f.name === name);
    if (
      !field ||
      (field.type !== 'email' &&
        field.type !== 'phone' &&
        field.type !== 'text')
    ) {
      r.issues.add(
        path,
        'validation_invalid_value',
        'Must be the name of an email, phone or text field.',
      );
    } else if (names.indexOf(name) !== i) {
      r.issues.add(path, 'validation_not_unique', 'Fields must be unique.');
    } else if (
      // The system email and phone fields always have unique indexes.
      field.id !== '_email' &&
      field.id !== '_phone' &&
      !indexes.some(
        (x) => x.unique && x.fields.length === 1 && x.fields[0] === field.id,
      )
    ) {
      r.issues.add(
        path,
        'validation_invalid_value',
        'The field needs a unique index of its own.',
      );
    }
  });
  return names;
}

function parseTokens(
  r: Reader,
  existing: Record<TokenType, TokenConfig> | undefined,
): Record<TokenType, TokenConfig> {
  const input: unknown = r.has('tokens') ? r.input.tokens : {};
  if (!isRecord(input)) {
    r.fail('tokens', 'validation_invalid_type', 'Must be an object.');
  }
  const configs = {} as Record<TokenType, TokenConfig>;
  for (const type of TOKEN_TYPES) {
    const previous = existing?.[type];
    const item = isRecord(input) ? input[type] : undefined;
    const path = ['tokens', type];
    if (item !== undefined && !isRecord(item)) {
      r.issues.add(path, 'validation_invalid_type', 'Must be an object.');
    }
    const tr = new Reader(isRecord(item) ? item : {}, path, r.issues);
    const secret = tr.string(
      'secret',
      previous?.secret ?? randomString(SECRET_LENGTH, ALPHANUMERIC),
    );
    if (
      secret.length < MIN_SECRET_LENGTH ||
      secret.length > MAX_SECRET_LENGTH
    ) {
      tr.fail(
        'secret',
        'validation_invalid_value',
        `Must be ${MIN_SECRET_LENGTH} to ${MAX_SECRET_LENGTH} characters.`,
      );
    }
    const duration = tr.integer(
      'duration',
      previous?.duration ?? DEFAULT_TOKEN_DURATIONS[type],
      1,
      MAX_TOKEN_DURATION,
    );
    configs[type] = { secret, duration };
  }
  return configs;
}
