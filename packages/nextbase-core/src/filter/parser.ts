/** Reported to the client as a 400. */
export class FilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilterError';
  }
}

export type Operator = '=' | '!=' | '>' | '>=' | '<' | '<=' | '~' | '!~';

export type Literal = string | number | boolean | null;

export type Operand =
  | { kind: 'literal'; value: Literal }
  /** `author.name`, or a `@request.*` / `@now` reference. */
  | {
      kind: 'identifier';
      path: string[];
      modifier: string | undefined;
      /** `@collection.members:m.user`: separate rows of the same collection. */
      alias?: string;
    };

export type Node =
  | { kind: 'logical'; op: '&&' | '||'; left: Node; right: Node }
  | {
      kind: 'comparison';
      op: Operator;
      /** `?=` and friends: any value matches, rather than every value. */
      any: boolean;
      left: Operand;
      right: Operand;
    };

const MAX_LENGTH = 3500;
const MAX_COMPARISONS = 200;
const MAX_DEPTH = 6;

type Token =
  | { kind: 'paren'; value: '(' | ')' }
  | { kind: 'logical'; value: '&&' | '||' }
  | { kind: 'operator'; value: Operator; any: boolean }
  | { kind: 'operand'; value: Operand };

const OPERATOR = /\??(!=|!~|>=|<=|=|>|<|~)/y;
const NUMBER = /-?\d+(\.\d+)?(?![\w.])/y;
// Segments after the first may start with a digit: JSON array indexes such as `items.0`.
const IDENTIFIER =
  /@?[A-Za-z_][A-Za-z0-9_]*(:[A-Za-z_][A-Za-z0-9_]*)?(\.[A-Za-z0-9_]+(:[A-Za-z_][A-Za-z0-9_]*)?)*/y;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const at = (pattern: RegExp): RegExpExecArray | null => {
    pattern.lastIndex = i;
    return pattern.exec(source);
  };
  while (i < source.length) {
    const char = source[i] as string;
    if (/\s/.test(char)) {
      i++;
    } else if (char === '(' || char === ')') {
      tokens.push({ kind: 'paren', value: char });
      i++;
    } else if (source.startsWith('&&', i) || source.startsWith('||', i)) {
      tokens.push({
        kind: 'logical',
        value: source.slice(i, i + 2) as '&&' | '||',
      });
      i += 2;
    } else if (char === "'" || char === '"') {
      let value = '';
      let j = i + 1;
      for (; j < source.length && source[j] !== char; j++) {
        if (source[j] === '\\' && j + 1 < source.length) j++;
        value += source[j];
      }
      if (j >= source.length) throw new FilterError('Unterminated string.');
      tokens.push({ kind: 'operand', value: { kind: 'literal', value } });
      i = j + 1;
    } else {
      const number = at(NUMBER);
      const operator = number ? null : at(OPERATOR);
      const identifier = number || operator ? null : at(IDENTIFIER);
      if (number) {
        tokens.push({
          kind: 'operand',
          value: { kind: 'literal', value: Number(number[0]) },
        });
        i += number[0].length;
      } else if (operator) {
        tokens.push({
          kind: 'operator',
          value: operator[1] as Operator,
          any: operator[0].startsWith('?'),
        });
        i += operator[0].length;
      } else if (identifier) {
        const [text] = identifier;
        i += text.length;
        tokens.push({ kind: 'operand', value: identifierOperand(text) });
      } else {
        throw new FilterError(
          `Unexpected character "${char}" at position ${i + 1}.`,
        );
      }
    }
  }
  return tokens;
}

const KEYWORDS: Readonly<Record<string, Literal>> = {
  true: true,
  false: false,
  null: null,
};

// `a.b:lower` has a modifier on its last segment; `@collection.x:alias.y` has
// an alias on the collection segment. A colon anywhere else is an error.
function identifierOperand(text: string): Operand {
  if (Object.hasOwn(KEYWORDS, text))
    return { kind: 'literal', value: KEYWORDS[text] as Literal };
  const path: string[] = [];
  let modifier: string | undefined;
  let alias: string | undefined;
  const segments = text.split('.');
  segments.forEach((segment, i) => {
    const [name = '', suffix] = segment.split(':');
    path.push(name);
    if (suffix === undefined) return;
    if (i === 1 && segments[0] === '@collection') alias = suffix;
    else if (i === segments.length - 1) modifier = suffix;
    else throw new FilterError(`Unexpected ":${suffix}" in "${text}".`);
  });
  return alias === undefined
    ? { kind: 'identifier', path, modifier }
    : { kind: 'identifier', path, modifier, alias };
}

/** Undefined for an empty expression; throws FilterError on syntax errors or exceeded limits. */
export function parseFilter(source: string): Node | undefined {
  if (source.length > MAX_LENGTH) {
    throw new FilterError(`Filters can be at most ${MAX_LENGTH} characters.`);
  }
  const tokens = tokenize(source);
  if (tokens.length === 0) return undefined;
  let position = 0;
  let comparisons = 0;

  const peek = (): Token | undefined => tokens[position];
  const fail = (expected: string): never => {
    const token = peek();
    throw new FilterError(
      token
        ? `Expected ${expected} at token ${position + 1}.`
        : `Expected ${expected} at the end of the filter.`,
    );
  };

  const operand = (): Operand => {
    const token = peek();
    if (token?.kind !== 'operand') return fail('a value or field');
    position++;
    return token.value;
  };

  const primary = (depth: number): Node => {
    const token = peek();
    if (token?.kind === 'paren' && token.value === '(') {
      if (depth >= MAX_DEPTH)
        throw new FilterError(
          `Parentheses can nest at most ${MAX_DEPTH} levels.`,
        );
      position++;
      const node = or(depth + 1);
      const close = peek();
      if (close?.kind !== 'paren' || close.value !== ')') fail('")"');
      position++;
      return node;
    }
    const left = operand();
    const op = peek();
    if (op?.kind !== 'operator') return fail('an operator such as = or ~');
    position++;
    const right = operand();
    if (++comparisons > MAX_COMPARISONS) {
      throw new FilterError(
        `Filters can have at most ${MAX_COMPARISONS} comparisons.`,
      );
    }
    return { kind: 'comparison', op: op.value, any: op.any, left, right };
  };

  const chain = (
    depth: number,
    op: '&&' | '||',
    next: (depth: number) => Node,
  ): Node => {
    let node = next(depth);
    for (;;) {
      const token = peek();
      if (token?.kind !== 'logical' || token.value !== op) return node;
      position++;
      node = { kind: 'logical', op, left: node, right: next(depth) };
    }
  };
  const and = (depth: number): Node => chain(depth, '&&', primary);
  const or = (depth: number): Node => chain(depth, '||', and);

  const node = or(0);
  if (position < tokens.length) fail('&&, || or the end of the filter');
  return node;
}
