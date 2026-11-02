// Random strings that match a regex, for text fields' autogeneratePattern.
// Only bounded patterns are supported, so every value has a known length range:
// literals, classes, `.`, groups, alternation, `?` and `{n}`/`{n,m}`.

/** Why a pattern cannot generate values. */
export class UnsupportedPattern extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedPattern';
  }
}

export interface PatternGenerator {
  /** In characters (code points). */
  readonly minLength: number;
  readonly maxLength: number;
  generate(): string;
}

type Range = readonly [number, number];

type Node =
  | { kind: 'chars'; ranges: Range[]; size: number }
  | { kind: 'seq'; items: Node[] }
  | { kind: 'alt'; options: Node[] }
  | { kind: 'repeat'; node: Node; min: number; max: number };

const MAX_DEPTH = 32;
// Generators need short patterns; long ones only cost time to parse and check.
const MAX_PATTERN_LENGTH = 1000;
// Nodes visited to generate one value.
const MAX_WORK = 100_000;
const EMPTY = 'Groups and repeated parts must be able to generate a character.';
/** Longer values are never needed, and a pattern could otherwise ask for millions. */
export const MAX_GENERATED_LENGTH = 5000;

// `.` generates letters and digits, not every character it matches.
const ANY: Range[] = [
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x61, 0x7a],
];
const DIGIT: Range[] = [[0x30, 0x39]];
const WORD: Range[] = [...ANY, [0x5f, 0x5f]];
const SPACE: Range[] = [
  [0x09, 0x0d],
  [0x20, 0x20],
];
// NUL and lone surrogates cannot be stored, so they are never generated.
const UNSTORABLE: Range[] = [
  [0, 0],
  [0xd800, 0xdfff],
];

/** Throws UnsupportedPattern for invalid, unbounded or otherwise ungeneratable patterns. */
export function patternGenerator(pattern: string): PatternGenerator {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new UnsupportedPattern(
      `Must be at most ${MAX_PATTERN_LENGTH} characters.`,
    );
  }
  try {
    new RegExp(pattern, 'u');
  } catch {
    throw new UnsupportedPattern('Must be a valid regular expression.');
  }
  const root = new Parser(pattern).parse();
  const [minLength, maxLength] = lengths(root);
  // Written so NaN fails too.
  if (!(maxLength <= MAX_GENERATED_LENGTH)) {
    throw new UnsupportedPattern(
      `Generates values of up to ${maxLength} characters; the limit is ${MAX_GENERATED_LENGTH}.`,
    );
  }
  // Parts that may generate nothing make the work outgrow the value's length.
  if (work(root) > MAX_WORK) {
    throw new UnsupportedPattern('Takes too many steps to generate a value.');
  }
  return {
    minLength,
    maxLength,
    generate: () => {
      const out: string[] = [];
      write(root, out);
      return out.join('');
    },
  };
}

class Parser {
  readonly #source: string;
  #i = 0;

  constructor(source: string) {
    // Anchors at the very start and end are implied: the whole value is generated.
    let end = source.length;
    if (source.endsWith('$') && !escapedAt(source, end - 1)) end--;
    this.#source = source.slice(0, end);
    if (this.#source.startsWith('^')) this.#i = 1;
  }

  parse(): Node {
    const node = this.#alternation(0);
    if (this.#i < this.#source.length) this.#unsupported(this.#peek());
    return node;
  }

  #peek(): string {
    return this.#source[this.#i] ?? '';
  }

  #unsupported(what: string): never {
    throw new UnsupportedPattern(
      `"${what}" is not supported for generating values; use literals, classes, groups, | and bounded repeats such as {8} or {4,8}.`,
    );
  }

  #alternation(depth: number): Node {
    if (depth > MAX_DEPTH) {
      throw new UnsupportedPattern(
        `Groups can nest at most ${MAX_DEPTH} levels.`,
      );
    }
    const options = [this.#sequence(depth)];
    while (this.#peek() === '|') {
      this.#i++;
      options.push(this.#sequence(depth));
    }
    return options.length === 1
      ? (options[0] as Node)
      : { kind: 'alt', options };
  }

  #sequence(depth: number): Node {
    const items: Node[] = [];
    for (;;) {
      const char = this.#peek();
      if (char === '' || char === '|' || char === ')') break;
      items.push(this.#quantified(this.#atom(depth)));
    }
    return { kind: 'seq', items };
  }

  #quantified(node: Node): Node {
    const char = this.#peek();
    let min: number;
    let max: number;
    if (char === '?') {
      this.#i++;
      [min, max] = [0, 1];
    } else if (char === '*' || char === '+') {
      this.#unsupported(char);
    } else if (char === '{') {
      const match = /^\{(\d+)(,(\d*))?\}/.exec(this.#source.slice(this.#i));
      if (!match) this.#unsupported('{');
      if (match[2] !== undefined && match[3] === '')
        this.#unsupported(match[0]);
      min = Number(match[1]);
      max = match[3] === undefined ? min : Number(match[3]);
      // Larger repeats could only generate too long a value.
      if (max > MAX_GENERATED_LENGTH) {
        throw new UnsupportedPattern(
          `Repeats can be at most {${MAX_GENERATED_LENGTH}}.`,
        );
      }
      this.#i += match[0].length;
    } else {
      return node;
    }
    // Repeating what generates nothing would only loop.
    if (lengths(node)[1] === 0) throw new UnsupportedPattern(EMPTY);
    // Lazy and greedy repeats generate alike.
    if (this.#peek() === '?') this.#i++;
    return { kind: 'repeat', node, min, max };
  }

  #atom(depth: number): Node {
    const char = this.#peek();
    if (char === '(') {
      this.#i++;
      const rest = this.#source.slice(this.#i);
      if (rest.startsWith('?:')) {
        this.#i += 2;
      } else if (/^\?<[A-Za-z_$][\w$]*>/.test(rest)) {
        this.#i = this.#source.indexOf('>', this.#i) + 1;
      } else if (rest.startsWith('?')) {
        this.#unsupported(`(${rest.slice(0, 2)}`);
      }
      const node = this.#alternation(depth + 1);
      this.#i++; // The RegExp check guarantees the ")".
      if (lengths(node)[1] === 0) throw new UnsupportedPattern(EMPTY);
      return node;
    }
    if (char === '[') return this.#class();
    if (char === '.') {
      this.#i++;
      return chars(ANY);
    }
    if (char === '\\') {
      const ranges = this.#escape(false);
      return chars(ranges);
    }
    if ('^$*+?{'.includes(char)) this.#unsupported(char);
    const code = this.#source.codePointAt(this.#i) as number;
    this.#i += code > 0xffff ? 2 : 1;
    return chars([[code, code]]);
  }

  #class(): Node {
    this.#i++;
    if (this.#peek() === '^') this.#unsupported('[^');
    const ranges: Range[] = [];
    while (this.#peek() !== ']') {
      const from = this.#classAtom();
      if (
        this.#peek() === '-' &&
        this.#source[this.#i + 1] !== ']' &&
        from.length === 1 &&
        from[0]?.[0] === from[0]?.[1]
      ) {
        this.#i++;
        const to = this.#classAtom();
        // The RegExp check rejects ranges out of order or with a class end.
        ranges.push([(from[0] as Range)[0], (to[0] as Range)[0]]);
      } else {
        ranges.push(...from);
      }
    }
    this.#i++;
    return chars(ranges);
  }

  #classAtom(): Range[] {
    if (this.#peek() === '\\') return this.#escape(true);
    const code = this.#source.codePointAt(this.#i) as number;
    this.#i += code > 0xffff ? 2 : 1;
    return [[code, code]];
  }

  #escape(inClass: boolean): Range[] {
    const char = this.#source[this.#i + 1] ?? '';
    this.#i += 2;
    const single = (code: number): Range[] => [[code, code]];
    switch (char) {
      case 'd':
        return DIGIT;
      case 'w':
        return WORD;
      case 's':
        return SPACE;
      case 'n':
        return single(0x0a);
      case 'r':
        return single(0x0d);
      case 't':
        return single(0x09);
      case 'f':
        return single(0x0c);
      case 'v':
        return single(0x0b);
      case 'x':
      case 'u': {
        const rest = this.#source.slice(this.#i);
        const match =
          char === 'x'
            ? /^[0-9A-Fa-f]{2}/.exec(rest)
            : (/^\{([0-9A-Fa-f]+)\}/.exec(rest) ??
              /^[0-9A-Fa-f]{4}/.exec(rest));
        if (!match) this.#unsupported(`\\${char}`);
        this.#i += match[0].length;
        return single(Number.parseInt(match[1] ?? match[0], 16));
      }
      case 'b':
        // A backspace inside a class, a word boundary outside one.
        if (inClass) return single(0x08);
        return this.#unsupported('\\b');
      default:
        // Escaped syntax characters stand for themselves; \D, \p, \1 and the rest do not generate.
        if (/^[\^$\\.*+?()[\]{}|/-]$/.test(char)) {
          return single(char.charCodeAt(0));
        }
        return this.#unsupported(`\\${char}`);
    }
  }
}

function escapedAt(source: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && source[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
}

// Sorted, merged and without unstorable characters, so each is equally likely.
function chars(input: readonly Range[]): Node {
  const sorted = [...input].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [from, to] of sorted) {
    const last = merged.at(-1);
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  let ranges: Range[] = merged;
  for (const [from, to] of UNSTORABLE) {
    ranges = ranges.flatMap(([a, b]): Range[] => {
      if (b < from || a > to) return [[a, b]];
      const parts: Range[] = [];
      if (a < from) parts.push([a, from - 1]);
      if (b > to) parts.push([to + 1, b]);
      return parts;
    });
  }
  const size = ranges.reduce((sum, [a, b]) => sum + b - a + 1, 0);
  if (size === 0) {
    throw new UnsupportedPattern('A character class matches nothing storable.');
  }
  return { kind: 'chars', ranges, size };
}

function lengths(node: Node): [number, number] {
  switch (node.kind) {
    case 'chars':
      return [1, 1];
    case 'seq':
      return node.items
        .map(lengths)
        .reduce(([min, max], [a, b]) => [min + a, max + b], [0, 0]);
    case 'alt': {
      // A loop, as spreading many options overflows the call stack.
      return node.options
        .map(lengths)
        .reduce(
          ([min, max], [a, b]) => [Math.min(min, a), Math.max(max, b)],
          [Infinity, 0],
        );
    }
    case 'repeat': {
      const [a, b] = lengths(node.node);
      return [a * node.min, b * node.max];
    }
    default: {
      const unknown: never = node;
      throw new Error(`Unknown node: ${JSON.stringify(unknown)}.`);
    }
  }
}

// The most nodes write visits for the node.
function work(node: Node): number {
  switch (node.kind) {
    // Picking a character walks the class's ranges.
    case 'chars':
      return node.ranges.length;
    case 'seq':
      return node.items.reduce((sum, item) => sum + work(item), 1);
    case 'alt':
      return (
        1 + node.options.reduce((max, option) => Math.max(max, work(option)), 0)
      );
    case 'repeat':
      return 1 + node.max * work(node.node);
    default: {
      const unknown: never = node;
      throw new Error(`Unknown node: ${JSON.stringify(unknown)}.`);
    }
  }
}

function write(node: Node, out: string[]): void {
  switch (node.kind) {
    case 'chars': {
      let n = randomInt(node.size);
      for (const [a, b] of node.ranges) {
        if (n <= b - a) {
          out.push(String.fromCodePoint(a + n));
          return;
        }
        n -= b - a + 1;
      }
      return;
    }
    case 'seq':
      for (const item of node.items) write(item, out);
      return;
    case 'alt':
      write(node.options[randomInt(node.options.length)] as Node, out);
      return;
    case 'repeat': {
      const count = node.min + randomInt(node.max - node.min + 1);
      for (let i = 0; i < count; i++) write(node.node, out);
      return;
    }
    default: {
      const unknown: never = node;
      throw new Error(`Unknown node: ${JSON.stringify(unknown)}.`);
    }
  }
}

// Uniform in [0, n), by rejection sampling, from a cryptographic source.
function randomInt(n: number): number {
  if (n <= 1) return 0;
  const limit = 2 ** 32 - (2 ** 32 % n);
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    const value = buffer[0] as number;
    if (value < limit) return value % n;
  }
}
