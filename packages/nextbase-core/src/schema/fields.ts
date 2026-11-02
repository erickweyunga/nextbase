import type {
  Collection,
  EmailField,
  Field,
  FieldType,
  PasswordField,
} from '@nextbasejs/client';
import { MAX_THUMBS, thumbSizeProblem } from '../files/thumbs.ts';
import { ALPHANUMERIC, LOWER_ALPHANUMERIC, randomString } from '../random.ts';
import { patternGenerator, UnsupportedPattern } from '../random-pattern.ts';
import { parseDate } from '../storable.ts';
import { type Issues, isRecord, type Path, Reader } from './input.ts';

/** Collection, field and index names: safe to quote, within Postgres's 63-byte limit. */
export const NAME_PATTERN: RegExp = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;

const FIELD_ID_PATTERN = /^[a-z0-9]{10}$/;

// Record JSON keys and Postgres system columns. Compared lowercased.
const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set([
  'expand',
  'collectionid',
  'collectionname',
  'tableoid',
  'xmin',
  'cmin',
  'xmax',
  'cmax',
  'ctid',
  'oid',
]);

// Filter keywords, which a filter reads as values rather than fields. The
// parser matches them exactly, so `True` stays a usable name.
const FILTER_KEYWORDS: ReadonlySet<string> = new Set(['true', 'false', 'null']);

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const DEFAULT_TEXT_MAX = 5000;
const DEFAULT_FILE_MAX_SIZE = 5 * 1024 * 1024;
const DEFAULT_JSON_MAX_SIZE = 1024 * 1024;
// Sanitizing runs at about 2 MB/s on the worst markup, so this bounds it to a
// quarter second.
const DEFAULT_EDITOR_MAX_SIZE = 512 * 1024;
/** How record ids are generated: what `newId` makes. */
export const ID_AUTOGENERATE_PATTERN = '[a-z0-9]{15}';
/** How auth records' token keys are generated. */
export const TOKEN_KEY_AUTOGENERATE_PATTERN = '[a-zA-Z0-9]{50}';
/** Values an autogeneratePattern is tried on against the field's other checks. */
const PATTERN_SAMPLES = 10;
// Length beats symbol mixes for guess resistance, and passwords are the only factor.
export const DEFAULT_PASSWORD_MIN = 15;
export const DEFAULT_PASSWORD_MAX = 256;
const MAX_PASSWORD_LENGTH = 1024;
const MAX_SELECT_VALUE_LENGTH = 255;
const MAX_FILES_PER_FIELD = 100;

const FIELD_TYPES = [
  'text',
  'number',
  'bool',
  'email',
  'phone',
  'url',
  'date',
  'autodate',
  'select',
  'relation',
  'file',
  'json',
  'editor',
  'geoPoint',
  'password',
] as const satisfies readonly FieldType[];

export interface FieldContext {
  /** Ids a relation may target, including its own collection's. */
  collectionIds: ReadonlySet<string>;
  /** The field this one replaces, matched by id. */
  existing?: Field | undefined;
}

/** `password` exists only as an auth system field. */
const USER_FIELD_TYPES: ReadonlySet<string> = new Set(
  FIELD_TYPES.filter((type) => type !== 'password'),
);

/** The password field of an auth collection, or undefined. */
export function passwordField(
  collection: Collection,
): PasswordField | undefined {
  return collection.fields.find(
    (f): f is PasswordField => f.type === 'password',
  );
}

/**
 * A random password for accounts created without one, such as through a provider or a phone.
 * It is never shown; the owner can set their own with a password reset.
 */
export function randomPassword(collection: Collection): string {
  const field = passwordField(collection);
  const length = field ? Math.min(Math.max(field.min, 64), field.max) : 64;
  return randomString(length, ALPHANUMERIC);
}

/** Whether a field is stored as a Postgres array column. */
export function isMultiple(field: Field): boolean {
  return (
    (field.type === 'select' ||
      field.type === 'relation' ||
      field.type === 'file') &&
    field.maxSelect > 1
  );
}

export function fieldNameProblem(name: string): string | undefined {
  if (!NAME_PATTERN.test(name)) {
    return 'Must start with a letter and contain only letters, digits and underscores, up to 63 characters.';
  }
  if (
    RESERVED_FIELD_NAMES.has(name.toLowerCase()) ||
    FILTER_KEYWORDS.has(name)
  ) {
    return `"${name}" is reserved.`;
  }
  return undefined;
}

function checkFieldName(name: string, path: Path, issues: Issues): void {
  const problem = fieldNameProblem(name);
  if (problem === undefined) return;
  issues.add(
    path,
    NAME_PATTERN.test(name)
      ? 'validation_reserved_name'
      : 'validation_invalid_name',
    problem,
  );
}

/** Undefined when the input is not a field at all; otherwise problems go to `issues`. */
export function parseField(
  input: unknown,
  path: Path,
  issues: Issues,
  context: FieldContext,
): Field | undefined {
  if (!isRecord(input)) {
    issues.add(path, 'validation_invalid_type', 'Must be an object.');
    return undefined;
  }
  const r = new Reader(input, path, issues);
  const { existing } = context;

  const type = r.string('type', '');
  if (!USER_FIELD_TYPES.has(type)) {
    r.fail(
      'type',
      'validation_invalid_value',
      `Must be one of: ${[...USER_FIELD_TYPES].join(', ')}.`,
    );
    return undefined;
  }
  if (existing && existing.type !== type) {
    r.fail(
      'type',
      'validation_type_change',
      "A field's type cannot change. Remove the field and add a new one instead.",
    );
    return undefined;
  }

  let id = r.string('id', '');
  if (id === '') {
    id = randomString(10, LOWER_ALPHANUMERIC);
  } else if (!existing && !FIELD_ID_PATTERN.test(id)) {
    r.fail(
      'id',
      'validation_invalid_value',
      'Must be 10 lowercase letters or digits.',
    );
  }

  const name = r.string('name', '');
  checkFieldName(name, [...path, 'name'], issues);

  const base = {
    id,
    name,
    system: false,
    required: r.boolean('required', false),
    hidden: r.boolean('hidden', false),
    presentable: r.boolean('presentable', false),
  };

  const fieldType = type as Exclude<FieldType, 'password'>;
  switch (fieldType) {
    case 'text': {
      const min = r.integer('min', 0, 0, MAX_SAFE);
      const max = r.integer('max', DEFAULT_TEXT_MAX, 1, MAX_SAFE);
      if (min > max)
        r.fail('min', 'validation_out_of_range', 'Must not exceed max.');
      const pattern = r.string('pattern', '');
      const validPattern = pattern === '' || checkPattern(pattern, r);
      const autogeneratePattern = r.string('autogeneratePattern', '');
      if (autogeneratePattern !== '') {
        checkAutogeneratePattern(r, autogeneratePattern, {
          min,
          max,
          pattern: validPattern ? pattern : '',
        });
      }
      return {
        ...base,
        type: 'text',
        min,
        max,
        pattern,
        autogeneratePattern,
        primaryKey: false,
      };
    }
    case 'number': {
      const min = r.numberOrNull('min', null);
      const max = r.numberOrNull('max', null);
      if (min !== null && max !== null && min > max) {
        r.fail('min', 'validation_out_of_range', 'Must not exceed max.');
      }
      return {
        ...base,
        type: 'number',
        min,
        max,
        onlyInt: r.boolean('onlyInt', false),
      };
    }
    case 'bool':
      return { ...base, type: 'bool' };
    case 'email':
      return { ...base, type: 'email', ...parseDomains(r) };
    case 'phone':
      return { ...base, type: 'phone' };
    case 'url':
      return { ...base, type: 'url', ...parseDomains(r) };
    case 'date': {
      const min = parseTimestamp(r, 'min');
      const max = parseTimestamp(r, 'max');
      if (min !== '' && max !== '' && Date.parse(min) > Date.parse(max)) {
        r.fail('min', 'validation_out_of_range', 'Must not be after max.');
      }
      return { ...base, type: 'date', min, max };
    }
    case 'autodate': {
      const onCreate = r.boolean('onCreate', true);
      const onUpdate = r.boolean('onUpdate', false);
      if (!onCreate && !onUpdate) {
        r.fail(
          'onCreate',
          'validation_required',
          'Set onCreate, onUpdate or both.',
        );
      }
      // The server sets the value, so a client can never leave it blank.
      return { ...base, required: false, type: 'autodate', onCreate, onUpdate };
    }
    case 'select': {
      const values = parseSelectValues(r);
      const maxSelect = r.integer(
        'maxSelect',
        1,
        1,
        Math.max(values.length, 1),
      );
      return { ...base, type: 'select', values, maxSelect };
    }
    case 'relation': {
      const collectionId = r.string('collectionId', '');
      if (!context.collectionIds.has(collectionId)) {
        r.fail(
          'collectionId',
          'validation_invalid_value',
          'Must be the id of an existing base or auth collection.',
        );
      } else if (
        existing?.type === 'relation' &&
        existing.collectionId !== collectionId
      ) {
        r.fail(
          'collectionId',
          'validation_type_change',
          "A relation's collection cannot change. Remove the field and add a new one instead.",
        );
      }
      const maxSelect = r.integer('maxSelect', 1, 1, MAX_SAFE);
      return {
        ...base,
        type: 'relation',
        collectionId,
        minSelect: r.integer('minSelect', 0, 0, maxSelect),
        maxSelect,
        cascadeDelete: r.boolean('cascadeDelete', false),
      };
    }
    case 'file': {
      const mimeTypes = r.strings('mimeTypes', []);
      mimeTypes.forEach((mime, i) => {
        if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime)) {
          issues.add(
            [...path, 'mimeTypes', i],
            'validation_invalid_value',
            'Must be a MIME type such as image/png.',
          );
        }
      });
      return {
        ...base,
        type: 'file',
        maxSelect: r.integer('maxSelect', 1, 1, MAX_FILES_PER_FIELD),
        maxSize: r.integer('maxSize', DEFAULT_FILE_MAX_SIZE, 1, MAX_SAFE),
        mimeTypes,
        protected: r.boolean('protected', false),
        thumbs: parseThumbs(r),
      };
    }
    case 'json':
      return {
        ...base,
        type: 'json',
        maxSize: r.integer('maxSize', DEFAULT_JSON_MAX_SIZE, 1, MAX_SAFE),
      };
    case 'editor':
      return {
        ...base,
        type: 'editor',
        maxSize: r.integer('maxSize', DEFAULT_EDITOR_MAX_SIZE, 1, MAX_SAFE),
        convertURLs: r.boolean('convertURLs', false),
      };
    case 'geoPoint':
      return { ...base, type: 'geoPoint' };
    default: {
      const unknown: never = fieldType;
      throw new Error(`Unknown field type: ${unknown}.`);
    }
  }
}

export function parsePasswordOptions(
  r: Reader,
  field: PasswordField,
): PasswordField {
  const min = r.integer('min', field.min, 1, MAX_PASSWORD_LENGTH);
  const max = r.integer('max', field.max, 1, MAX_PASSWORD_LENGTH);
  if (min > max)
    r.fail('min', 'validation_out_of_range', 'Must not exceed max.');
  return { ...field, min, max };
}

export function parseEmailOptions(r: Reader, field: EmailField): EmailField {
  return {
    ...field,
    required: r.boolean('required', field.required),
    ...parseDomains(r, field),
  };
}

function checkPattern(pattern: string, r: Reader): boolean {
  try {
    new RegExp(pattern, 'u');
    return true;
  } catch {
    r.fail(
      'pattern',
      'validation_invalid_value',
      'Must be a valid regular expression.',
    );
    return false;
  }
}

// Generated values must pass the field's own checks. Lengths are known from the
// pattern; matching `pattern` is tried on samples, which catches most conflicts.
function checkAutogeneratePattern(
  r: Reader,
  autogeneratePattern: string,
  field: { min: number; max: number; pattern: string },
): void {
  const fail = (message: string): void =>
    r.fail('autogeneratePattern', 'validation_invalid_value', message);
  let generator: ReturnType<typeof patternGenerator>;
  try {
    generator = patternGenerator(autogeneratePattern);
  } catch (error) {
    if (!(error instanceof UnsupportedPattern)) throw error;
    fail(error.message);
    return;
  }
  const min = Math.max(field.min, 1);
  if (generator.minLength < min || generator.maxLength > field.max) {
    fail(
      `Generates values of ${generator.minLength} to ${generator.maxLength} characters, but the field takes ${min} to ${field.max}.`,
    );
    return;
  }
  if (field.pattern === '') return;
  const matches = new RegExp(field.pattern, 'u');
  for (let i = 0; i < PATTERN_SAMPLES; i++) {
    const value = generator.generate();
    if (!matches.test(value)) {
      fail(
        `Can generate values that do not match pattern, such as "${value}".`,
      );
      return;
    }
  }
}

/**
 * A stored field with the settings added since it was saved, at their defaults.
 * The system id and tokenKey fields describe how NextBase generates them.
 */
export function withFieldDefaults(stored: Field): Field {
  const field: Field = { ...stored, presentable: stored.presentable ?? false };
  if (field.type === 'text') {
    field.autogeneratePattern ??= field.primaryKey
      ? ID_AUTOGENERATE_PATTERN
      : field.system && field.name === 'tokenKey'
        ? TOKEN_KEY_AUTOGENERATE_PATTERN
        : '';
  } else if (field.type === 'relation') {
    field.minSelect ??= 0;
  }
  return field;
}

function parseDomains(
  r: Reader,
  fallback?: { onlyDomains: string[]; exceptDomains: string[] },
): { onlyDomains: string[]; exceptDomains: string[] } {
  const read = (key: 'onlyDomains' | 'exceptDomains'): string[] => {
    const domains = r
      .strings(key, fallback?.[key] ?? [])
      .map((d) => d.toLowerCase());
    domains.forEach((domain, i) => {
      if (
        !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
          domain,
        )
      ) {
        r.issues.add(
          [...r.path, key, i],
          'validation_invalid_value',
          'Must be a domain such as example.com.',
        );
      }
    });
    return domains;
  };
  const onlyDomains = read('onlyDomains');
  const exceptDomains = read('exceptDomains');
  if (onlyDomains.length > 0 && exceptDomains.length > 0) {
    r.fail(
      'exceptDomains',
      'validation_invalid_value',
      'Set onlyDomains or exceptDomains, not both.',
    );
  }
  return { onlyDomains, exceptDomains };
}

// Normalizes to the ISO form the API uses. Bounds compare by time, since years
// past 9999 or before 1 AD do not sort as text.
function parseTimestamp(r: Reader, key: 'min' | 'max'): string {
  const value = r.string(key, '');
  if (value === '') return '';
  const time = parseDate(value);
  if (Number.isNaN(time)) {
    r.fail(
      key,
      'validation_invalid_value',
      'Must be an ISO 8601 date, or empty.',
    );
    return '';
  }
  return new Date(time).toISOString();
}

function parseSelectValues(r: Reader): string[] {
  const values = r.strings('values', []);
  if (values.length === 0) {
    r.fail('values', 'validation_required', 'Add at least one value.');
  }
  const seen = new Set<string>();
  values.forEach((value, i) => {
    const path = [...r.path, 'values', i];
    if (value === '' || value.length > MAX_SELECT_VALUE_LENGTH) {
      r.issues.add(
        path,
        'validation_invalid_value',
        `Must be 1 to ${MAX_SELECT_VALUE_LENGTH} characters.`,
      );
    } else if (seen.has(value)) {
      r.issues.add(path, 'validation_not_unique', 'Values must be unique.');
    }
    seen.add(value);
  });
  return values;
}

// Duplicates are dropped, so each size is made and stored once.
function parseThumbs(r: Reader): string[] {
  const thumbs = r.strings('thumbs', []);
  thumbs.forEach((size, i) => {
    const problem = thumbSizeProblem(size);
    if (problem) {
      r.issues.add(
        [...r.path, 'thumbs', i],
        'validation_invalid_value',
        problem,
      );
    }
  });
  const unique = [...new Set(thumbs)];
  if (unique.length > MAX_THUMBS) {
    r.fail('thumbs', 'validation_too_many', `Add at most ${MAX_THUMBS} sizes.`);
  }
  return unique;
}
