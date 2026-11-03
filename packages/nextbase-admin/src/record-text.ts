import {
  type Collection,
  type Field,
  filter,
  type RecordModel,
} from '@nextbasejs/client';

const SEARCHABLE = new Set<Field['type']>(['text', 'email', 'url', 'phone']);

const LABELLED = new Set<Field['type']>(['text', 'email', 'url', 'phone']);

const FILTER_SYNTAX = /[=!<>~]/;

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

export function searchFilter(collection: Collection, query: string): string {
  const q = query.trim();
  if (q === '' || FILTER_SYNTAX.test(q)) return q;
  return collection.fields
    .filter((f) => SEARCHABLE.has(f.type) && !f.hidden)
    .map((f) => filter(`${f.name} ~ {:q}`, { q }))
    .join(' || ');
}

export function labelOf(
  collection: Collection | undefined,
  record: RecordModel,
): string {
  const field = collection?.fields.find(
    (f) =>
      LABELLED.has(f.type) &&
      !f.hidden &&
      f.name !== 'id' &&
      typeof record[f.name] === 'string' &&
      record[f.name] !== '',
  );
  return field ? String(record[field.name]) : record.id;
}

export function isImage(filename: string): boolean {
  return IMAGE.test(filename);
}

export function asList(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).filter(
    (v): v is string => typeof v === 'string' && v !== '',
  );
}
