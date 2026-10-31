import type { Collection } from '@nextbasejs/client';

// For migrations: renames an auth collection field inside rules, outside string literals and
// only where a segment resolves to that field. `@request.auth.<from>` is always renamed.

const IDENTIFIER =
  /@?[A-Za-z_][A-Za-z0-9_]*(:[A-Za-z_][A-Za-z0-9_]*)?(\.[A-Za-z0-9_]+(:[A-Za-z_][A-Za-z0-9_]*)?)*/y;
const NUMBER = /-?\d+(\.\d+)?(?![\w.])/y;

// Rules that do not tokenize are returned unchanged.
export function renameRuleField(
  rule: string,
  collection: Collection,
  collections: readonly Collection[],
  from: string,
  to: string,
  owns: (collection: Collection) => boolean,
): string {
  let out = '';
  let i = 0;
  while (i < rule.length) {
    const char = rule[i] as string;
    if (char === "'" || char === '"') {
      let j = i + 1;
      while (j < rule.length && rule[j] !== char) {
        if (rule[j] === '\\') j++;
        j++;
      }
      out += rule.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    NUMBER.lastIndex = i;
    const number = NUMBER.exec(rule);
    if (number) {
      out += number[0];
      i += number[0].length;
      continue;
    }
    IDENTIFIER.lastIndex = i;
    const identifier = IDENTIFIER.exec(rule);
    if (identifier) {
      out += renameIdentifier(
        identifier[0],
        collection,
        collections,
        from,
        to,
        owns,
      );
      i += identifier[0].length;
      continue;
    }
    out += char;
    i++;
  }
  return out;
}

function renameIdentifier(
  text: string,
  collection: Collection,
  collections: readonly Collection[],
  from: string,
  to: string,
  owns: (collection: Collection) => boolean,
): string {
  const segments = text.split('.');
  const names = segments.map((s) => s.split(':')[0] as string);
  const renamed = new Set<number>();
  const isField = (c: Collection | undefined, name: string): boolean =>
    c !== undefined && name === from && owns(c);

  // Walks a path from `start` in `current`, through relations.
  const walk = (current: Collection | undefined, start: number): void => {
    let here = current;
    for (let i = start; here && i < names.length; i++) {
      const name = names[i] as string;
      if (isField(here, name)) {
        renamed.add(i);
        return;
      }
      const field = here.fields.find((f) => f.name === name);
      if (field?.type === 'relation') {
        here = collections.find((c) => c.id === field.collectionId);
        continue;
      }
      const via = /^(.+)_via_(.+)$/.exec(name);
      here = via ? collections.find((c) => c.name === via[1]) : undefined;
    }
  };

  if (names[0] === '@request') {
    // The field is renamed in every auth collection that has it, so
    // `@request.auth.<field>` is it.
    if (names[1] === 'auth' && names[2] === from) renamed.add(2);
    if (names[1] === 'body' && isField(collection, names[2] as string)) {
      renamed.add(2);
    }
  } else if (names[0] === '@collection') {
    walk(
      collections.find((c) => c.name === names[1]),
      2,
    );
  } else if (!names[0]?.startsWith('@')) {
    walk(collection, 0);
  }
  if (renamed.size === 0) return text;
  return segments
    .map((segment, i) =>
      renamed.has(i) ? `${to}${segment.slice(from.length)}` : segment,
    )
    .join('.');
}
