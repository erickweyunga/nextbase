import type { Collection, Field } from "@nextbasejs/client";
import { type Expression, exp, type Params } from "@nextbasejs/dbx";
import type { Principal } from "../auth/principal.ts";
import { table } from "../db/system.ts";
import type { Schema } from "../schema/cache.ts";
import { isMultiple } from "../schema/fields.ts";
import {
  hasNul,
  isStorableTime,
  parseDate,
  timestampParam,
} from "../storable.ts";
import {
  FilterError,
  type Literal,
  type Node,
  type Operand,
  type Operator,
  parseFilter,
} from "./parser.ts";

/** What rules can read through `@request.*`. */
export interface RequestInfo {
  method: string;
  query: Record<string, string>;
  /** Lowercased header names. */
  headers: Record<string, string>;
  /** Normalized create or update values. */
  body: Record<string, unknown>;
}

export interface FilterContext {
  schema: Schema;
  principal: Principal;
  request: RequestInfo;
  /**
   * `filter` is untrusted: no hidden fields, and related paths only see records
   * the caller may view. `rule` is a trusted superuser-written rule.
   */
  mode: "filter" | "rule";
}

const MAX_PATH_DEPTH = 6;

type SqlType = "text" | "number" | "bool" | "date";

const CASTS: Record<SqlType, string> = {
  text: "text",
  number: "double precision",
  bool: "boolean",
  date: "timestamptz",
};

/** A missing request value, e.g. `@request.auth.id` when signed out. */
const BLANK = Symbol("blank");

/** A literal, a `@request.*` value or a date macro. */
interface Constant {
  kind: "constant";
  value: unknown;
  /** Undefined when it adapts to the other operand. */
  type: SqlType | undefined;
}

interface RelationStep {
  field: Field & { type: "relation" };
  target: Collection;
  /** `comments_via_post`: the comments whose `post` points here. */
  back: boolean;
}

interface Path {
  kind: "path";
  /** SQL alias of the starting rows. */
  root: string;
  steps: RelationStep[];
  collection: Collection;
  field: Field;
  /** `meta.address.city` */
  jsonKeys: string[];
  modifier: "length" | "lower" | undefined;
  /** `comments_via_post:length` */
  count: boolean;
  /**
   * SQL for the values in place of a column: a `@request.auth.<field>` with
   * several values, bound as an array.
   */
  source?: string;
}

type Resolved = Constant | Path;

/**
 * Every value is bound and every name comes from the schema. Undefined for an
 * empty expression; throws FilterError for anything invalid.
 */
export function compileFilter(
  source: string,
  collection: Collection,
  alias: string,
  context: FilterContext,
): Expression | undefined {
  const node = parseFilter(source);
  if (!node) return undefined;
  const compiler = new Compiler(context);
  return exp(compiler.compile(node, collection, alias), compiler.params);
}

/** The problem compiling a stored rule, or undefined when valid. */
export function ruleProblem(
  rule: string | null,
  collection: Collection,
  schema: Schema,
): string | undefined {
  if (rule === null || rule === "") return undefined;
  // What `@request.auth.<field>` is depends on the caller's collection, so
  // the rule is compiled signed out and signed in to each auth collection.
  const principals: Principal[] = [{ superuser: false }];
  if (rule.includes("@request.auth")) {
    for (const c of schema.collections) {
      if (c.type === "auth")
        principals.push({ superuser: false, collection: c, record: {} });
    }
  }
  try {
    for (const principal of principals) {
      compileFilter(rule, collection, "t0", {
        schema,
        principal,
        request: { method: "GET", query: {}, headers: {}, body: {} },
        mode: "rule",
      });
    }
    return undefined;
  } catch (error) {
    if (error instanceof FilterError) return error.message;
    throw error;
  }
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

class Compiler {
  readonly params: Params = {};
  readonly #context: FilterContext;
  #aliases: number;
  /** One joined row variable per `@collection` reference and alias. */
  readonly #joined = new Map<
    string,
    { alias: string; collection: Collection }
  >();

  constructor(context: FilterContext, firstAlias = 0) {
    this.#context = context;
    this.#aliases = firstAlias;
  }

  /**
   * With `@collection` references, holds when some row combination satisfies it;
   * an empty collection contributes a NULL row so the rest still counts.
   */
  compile(node: Node, collection: Collection, alias: string): string {
    const sql = this.#node(node, collection, alias);
    if (this.#joined.size === 0) return sql;
    const joins = [...this.#joined.values()].map(
      ({ alias: a, collection: c }) =>
        `LEFT JOIN {{${table(c.name)}}} ${quote(a)} ON TRUE`,
    );
    return `EXISTS (SELECT 1 FROM (SELECT 1) AS "nb_one" ${joins.join(" ")} WHERE ${sql})`;
  }

  #node(node: Node, collection: Collection, alias: string): string {
    if (node.kind === "logical") {
      const op = node.op === "&&" ? "AND" : "OR";
      return `(${this.#node(node.left, collection, alias)} ${op} ${this.#node(node.right, collection, alias)})`;
    }
    let left = this.#resolve(node.left, collection, alias);
    let right = this.#resolve(node.right, collection, alias);
    let op = node.op;
    // Paths go on the left, so `"x" = title` compiles like `title = "x"`.
    if (left.kind === "constant" && right.kind === "path") {
      if (op === "~" || op === "!~")
        throw new FilterError(`The field must be on the left of ${op}.`);
      [left, right] = [right, left];
      op = MIRRORED[op];
    }
    if (left.kind === "constant")
      return this.#compareConstants(left, op, right as Constant);
    return this.#comparePath(left, op, node.any, right);
  }

  #bind(value: unknown, type: SqlType | undefined): string {
    const name = `f${Object.keys(this.params).length}`;
    this.params[name] = value;
    return type ? `{:${name}}::${CASTS[type]}` : `{:${name}}`;
  }

  #alias(): string {
    this.#aliases++;
    return `f${this.#aliases}`;
  }

  #resolve(operand: Operand, collection: Collection, alias: string): Resolved {
    if (operand.kind === "literal") {
      return {
        kind: "constant",
        value: operand.value === null ? BLANK : operand.value,
        type: undefined,
      };
    }
    const [head = "", ...rest] = operand.path;
    if (head === "@collection") return this.#resolveCollection(operand, rest);
    if (head.startsWith("@"))
      return this.#resolveSpecial(operand, head, rest, collection);
    return this.#resolvePath(operand.path, operand.modifier, collection, alias);
  }

  #resolveCollection(
    operand: Operand & { kind: "identifier" },
    rest: string[],
  ): Path {
    if (this.#context.mode === "filter")
      throw new FilterError("Filters cannot read @collection values.");
    const [name = "", ...fieldPath] = rest;
    const collection = this.#context.schema.collections.find(
      (c) => c.name === name,
    );
    if (!collection)
      throw new FilterError(`Unknown collection "${name}" in @collection.`);
    // A view's query must run as the view role, and rules run as NextBase.
    if (collection.type === "view")
      throw new FilterError(
        `@collection cannot read the view collection "${name}".`,
      );
    if (fieldPath.length === 0)
      throw new FilterError(`@collection.${name} needs a field.`);
    const key = `${collection.id}:${operand.alias ?? ""}`;
    let joined = this.#joined.get(key);
    if (!joined) {
      joined = { alias: `c${this.#joined.size + 1}`, collection };
      this.#joined.set(key, joined);
    }
    return this.#resolvePath(
      fieldPath,
      operand.modifier,
      collection,
      joined.alias,
    );
  }

  #resolvePath(
    names: string[],
    modifier: string | undefined,
    collection: Collection,
    root: string,
  ): Path {
    const { mode, schema, principal } = this.#context;
    if (names.length > MAX_PATH_DEPTH)
      throw new FilterError(
        `Field paths can be at most ${MAX_PATH_DEPTH} levels deep.`,
      );
    const unknown = (i: number): FilterError =>
      new FilterError(`Unknown field "${names.slice(0, i + 1).join(".")}".`);
    const offLimits = (field: Field): boolean =>
      mode === "filter" && field.hidden && !principal.superuser;
    const path = (
      current: Collection,
      field: Field,
      steps: RelationStep[],
      jsonKeys: string[],
    ): Path => ({
      kind: "path",
      root,
      steps,
      collection: current,
      field,
      jsonKeys,
      modifier: undefined,
      count: false,
    });

    const steps: RelationStep[] = [];
    let current = collection;
    for (let i = 0; i < names.length; i++) {
      const name = names[i] as string;
      const last = i === names.length - 1;
      const field = current.fields.find((f) => f.name === name);

      if (!field) {
        const back = schema.backRelation(current, name);
        if (!back || offLimits(back.field)) throw unknown(i);
        steps.push({ field: back.field, target: back.source, back: true });
        current = back.source;
        // A back-relation compares related ids, or counts them with :length.
        if (last) {
          const id = current.fields.find((f) => f.name === "id") as Field;
          if (modifier !== undefined && modifier !== "length")
            throw new FilterError(`Unknown modifier ":${modifier}".`);
          return {
            ...path(current, id, steps, []),
            count: modifier === "length",
          };
        }
        continue;
      }
      if (field.type === "password" || field.name === "tokenKey")
        throw new FilterError(`"${name}" cannot be used in filters.`);
      if (offLimits(field)) throw unknown(i);
      if (field.type === "json")
        return this.#finishPath(
          path(current, field, steps, names.slice(i + 1)),
          modifier,
        );
      if (last)
        return this.#finishPath(path(current, field, steps, []), modifier);
      if (field.type !== "relation")
        throw new FilterError(
          `"${name}" is not a relation, so it has no fields.`,
        );
      const target = schema.find(field.collectionId);
      if (!target)
        throw new FilterError(`The collection of "${name}" no longer exists.`);
      steps.push({ field, target, back: false });
      current = target;
    }
    throw unknown(names.length - 1);
  }

  #finishPath(path: Path, modifier: string | undefined): Path {
    if (modifier === undefined) return path;
    if (modifier !== "length" && modifier !== "lower")
      throw new FilterError(`Unknown modifier ":${modifier}".`);
    if (modifier === "length" && !isMultiple(path.field)) {
      throw new FilterError(
        `:length applies to fields with several values, not "${path.field.name}".`,
      );
    }
    if (
      modifier === "lower" &&
      path.field.type !== "json" &&
      sqlType(path.field) !== "text"
    ) {
      throw new FilterError(
        `:lower applies to text fields, not "${path.field.name}".`,
      );
    }
    return { ...path, modifier };
  }

  #resolveSpecial(
    operand: Operand & { kind: "identifier" },
    head: string,
    rest: string[],
    collection: Collection,
  ): Resolved {
    const { request, mode } = this.#context;
    const text = (value: unknown): Constant => ({
      kind: "constant",
      value: typeof value === "string" ? value : BLANK,
      type: typeof value === "string" ? "text" : undefined,
    });
    const macro = MACROS[head];
    if (macro && rest.length === 0) {
      return { kind: "constant", value: macro(new Date()), type: "date" };
    }
    if (head !== "@request")
      throw new FilterError(`Unknown reference "${head}".`);
    if (mode === "filter")
      throw new FilterError("Filters cannot read @request values.");
    const [section, name, ...extra] = rest;
    const modifier = operand.modifier;
    const unknownModifier = (): FilterError =>
      new FilterError(`Unknown modifier ":${modifier}".`);
    if (section === "method" && name === undefined) {
      if (modifier !== undefined) throw unknownModifier();
      return text(request.method);
    }
    if (name === undefined || extra.length > 0) {
      throw new FilterError(
        `"${operand.path.join(".")}" is not a supported @request value.`,
      );
    }
    if (section === "auth") return this.#resolveAuth(name, modifier);
    if (section === "query" || section === "headers") {
      if (modifier !== undefined) throw unknownModifier();
      return section === "query"
        ? text(request.query[name])
        : text(request.headers[name.toLowerCase().replaceAll("_", "-")]);
    }
    if (section === "body") {
      const present = Object.hasOwn(request.body, name);
      if (modifier === "isset")
        return { kind: "constant", value: present, type: "bool" };
      if (modifier !== undefined)
        throw new FilterError(`Unknown modifier ":${modifier}".`);
      const field = collection.fields.find((f) => f.name === name);
      // Checked before presence, so saving the rule already fails.
      if (field && isMultiple(field))
        throw new FilterError(
          `@request.body.${name} has several values and cannot be compared.`,
        );
      if (!present) return { kind: "constant", value: BLANK, type: undefined };
      return {
        kind: "constant",
        value: request.body[name],
        type: field ? sqlType(field) : undefined,
      };
    }
    throw new FilterError(
      `"${operand.path.join(".")}" is not a supported @request value.`,
    );
  }

  /**
   * A field of the signed-in record. The name must belong to some auth
   * collection, so a typo, or a field renamed or deleted from under a rule,
   * fails when the schema is saved instead of reading as blank. As elsewhere
   * in rules, hidden fields can be read. A field with several values compares
   * like a field of the record with several values.
   */
  #resolveAuth(name: string, modifier: string | undefined): Resolved {
    const { principal, schema } = this.#context;
    const { record, collection } = principal;
    const blank: Constant = { kind: "constant", value: BLANK, type: undefined };
    if (name === "collectionId" || name === "collectionName") {
      if (modifier !== undefined)
        throw new FilterError(`Unknown modifier ":${modifier}".`);
      const value = name === "collectionId" ? collection?.id : collection?.name;
      return value === undefined
        ? blank
        : { kind: "constant", value, type: "text" };
    }
    const field = collection?.fields.find((f) => f.name === name);
    const known = schema.collections.flatMap((c) =>
      c.type === "auth" ? c.fields.filter((f) => f.name === name) : [],
    );
    if (field) known.push(field);
    if (known.length === 0)
      throw new FilterError(
        `Unknown field "${name}" in @request.auth: no auth collection has it.`,
      );
    if (known.some((f) => f.type === "password" || f.name === "tokenKey"))
      throw new FilterError(`"${name}" cannot be used in filters.`);
    if (known.some((f) => f.type === "json"))
      throw new FilterError(
        `@request.auth.${name} is a JSON field, which rules cannot compare.`,
      );

    // Signed out, or signed in to a collection without the field.
    if (!record || !collection || !field) {
      if (modifier === "length")
        return { kind: "constant", value: 0, type: "number" };
      if (modifier !== undefined && modifier !== "lower")
        throw new FilterError(`Unknown modifier ":${modifier}".`);
      return blank;
    }
    if (isMultiple(field)) {
      const value = record[name];
      return this.#finishPath(
        {
          kind: "path",
          root: "",
          steps: [],
          collection,
          field,
          jsonKeys: [],
          modifier: undefined,
          count: false,
          source: `${this.#bind(Array.isArray(value) ? value : [], undefined)}::text[]`,
        },
        modifier,
      );
    }
    if (modifier !== undefined)
      throw new FilterError(
        `:${modifier} does not apply to @request.auth.${name}.`,
      );
    return {
      kind: "constant",
      value: record[name] ?? BLANK,
      type: sqlType(field),
    };
  }

  #compareConstants(left: Constant, op: Operator, right: Constant): string {
    const type =
      left.type ??
      right.type ??
      jsType(left.value) ??
      jsType(right.value) ??
      "text";
    const l = this.#bind(coerce(left.value, type, false), type);
    // A text value matched like a field, such as `@request.auth.name ~ "a"`.
    if ((op === "~" || op === "!~") && type === "text")
      return this.#compareColumn(l, type, false, op, right);
    const r = this.#bind(coerce(right.value, type, false), type);
    return this.#operator(l, type, op, r, true);
  }

  #compareColumn(
    sql: string,
    type: SqlType,
    nullable: boolean,
    op: Operator,
    right: Constant | { sql: string; type: SqlType; nullable: boolean },
  ): string {
    if ("sql" in right) {
      if (right.type !== type)
        throw new FilterError(
          "Both sides of a comparison must have the same type.",
        );
      if (op === "~" || op === "!~")
        throw new FilterError(`The right side of ${op} must be a value.`);
      return this.#operator(
        sql,
        type,
        op,
        right.sql,
        nullable || right.nullable,
      );
    }
    if (op === "~" || op === "!~") {
      if (type !== "text")
        throw new FilterError(`${op} applies to text fields.`);
      const value = right.value === BLANK ? "" : String(right.value);
      if (hasNul(value))
        throw new FilterError("Values cannot contain NUL characters.");
      // A value without % matches anywhere; with %, it is the pattern itself,
      // in which a backslash escapes the next character.
      const pattern = value.includes("%")
        ? value
        : `%${value.replace(/[\\%_]/g, "\\$&")}%`;
      if ((/\\+$/.exec(pattern)?.[0].length ?? 0) % 2 === 1)
        throw new FilterError(
          `A ${op} pattern cannot end with a backslash that escapes nothing.`,
        );
      // Bare column so a trigram index can serve it; COALESCE only when nullable,
      // so `!~` keeps NULL rows.
      const subject = nullable ? `COALESCE(${sql}, '')` : sql;
      return `${subject} ${op === "!~" ? "NOT ILIKE" : "ILIKE"} ${this.#bind(pattern, "text")} ESCAPE '\\'`;
    }
    const value = coerce(right.value, type, nullable);
    if (value === null && op === "=") return `${sql} IS NULL`;
    if (value === null && op === "!=") return `${sql} IS NOT NULL`;
    // Against a non-NULL value only `!=` needs the NULL-safe form.
    return this.#operator(
      sql,
      type,
      op,
      this.#bind(value, type),
      nullable && op === "!=",
    );
  }

  // Plain `=`/`<>` when not nullable: a btree index can serve them, unlike
  // IS [NOT] DISTINCT FROM.
  #operator(
    left: string,
    type: SqlType,
    op: Operator,
    right: string,
    nullable: boolean,
  ): string {
    if (op === "=")
      return nullable
        ? `${left} IS NOT DISTINCT FROM ${right}`
        : `${left} = ${right}`;
    if (op === "!=")
      return nullable
        ? `${left} IS DISTINCT FROM ${right}`
        : `${left} <> ${right}`;
    if (op === "~" || op === "!~")
      throw new FilterError(`${op} applies to text fields.`);
    if (type === "bool")
      throw new FilterError(`${op} does not apply to booleans.`);
    return `${left} ${op} ${right}`;
  }

  #comparePath(
    left: Path,
    op: Operator,
    any: boolean,
    right: Resolved,
  ): string {
    if (right.kind === "path" && needsSubquery(right)) {
      if (op === "~" || op === "!~")
        throw new FilterError(`The right side of ${op} must be a value.`);
      // The side walked in a subquery goes on the left.
      if (!needsSubquery(left)) {
        [left, right] = [right, left];
        op = MIRRORED[op];
      }
    }
    // JSON values take the type of what they are compared with.
    const rightType =
      right.kind === "constant"
        ? jsType(right.value)
        : right.field.type === "json"
          ? undefined
          : pathType(right, "text");
    const leftType = pathType(left, rightType ?? "text");

    // A field compared with blank: `tags = ""` means "has no values".
    if (
      isPlural(left) &&
      left.steps.length === 0 &&
      right.kind === "constant" &&
      (right.value === BLANK || right.value === "") &&
      (op === "=" || op === "!=")
    ) {
      return `cardinality(${this.#column(left, left.root, leftType)}) ${op === "=" ? "=" : ">"} 0`;
    }

    // A field compared with a value: `tags ?= "news"` means "has this value".
    // It is written as array containment, which the field's GIN index can
    // serve. Multi-value columns are never NULL, so neither is the result.
    if (
      any &&
      op === "=" &&
      isPlural(left) &&
      left.steps.length === 0 &&
      leftType === "text" &&
      left.modifier !== "lower" &&
      right.kind === "constant" &&
      right.value !== BLANK &&
      right.value !== null
    ) {
      const value = this.#bind(coerce(right.value, "text", false), "text");
      return `${this.#column(left, left.root, leftType)} @> ARRAY[${value}]`;
    }

    const leftValues = needsSubquery(left)
      ? this.#values(left, leftType)
      : undefined;
    const rightValues =
      right.kind === "path" && needsSubquery(right)
        ? this.#values(right, pathType(right, leftType))
        : undefined;
    const other =
      right.kind === "path"
        ? {
            sql:
              rightValues?.element ??
              this.#column(right, right.root, pathType(right, leftType)),
            type: pathType(right, leftType),
            nullable: isNullable(right),
          }
        : right;
    const condition = this.#compareColumn(
      leftValues?.element ?? this.#column(left, left.root, leftType),
      leftType,
      isNullable(left),
      op,
      other,
    );
    if (!leftValues) return condition;

    // Correlated subquery over every value pair. ?op: some pair matches.
    // op: both sides have values and every pair matches.
    const sides = rightValues ? [leftValues, rightValues] : [leftValues];
    const exists = (from: string[], conditions: string[]): string =>
      `EXISTS (SELECT 1 FROM ${from.join(", ")} WHERE ${conditions.join(" AND ") || "TRUE"})`;
    const from = sides.flatMap((side) => side.from);
    const joins = sides.flatMap((side) => side.joins);
    // With at most one value on each side, such as `author.name`, there is at
    // most one pair, so "every pair matches" is the same as "a pair matches".
    // That form is a plain lookup Postgres can serve with indexes, where the
    // every-pair form checks every row.
    const paths = right.kind === "path" && rightValues ? [left, right] : [left];
    if (any || paths.every(isSingleValued)) {
      return exists(from, [...joins, condition]);
    }
    const nonEmpty = sides.map((side) => exists(side.from, side.joins));
    return `(${[
      ...nonEmpty,
      `NOT ${exists(from, [...joins, `NOT COALESCE(${condition}, false)`])}`,
    ].join(" AND ")})`;
  }

  #values(
    path: Path,
    type: SqlType,
  ): { from: string[]; joins: string[]; element: string } {
    const { from, joins, last } = this.#chain(path.steps, path.root);
    if (!isPlural(path)) {
      return {
        from,
        joins,
        element: this.#column({ ...path, steps: [] }, last, type),
      };
    }
    const values = this.#alias();
    const column = path.source ?? `${quote(last)}.${quote(path.field.name)}`;
    const source = `unnest(${column}) AS ${quote(values)}("v")`;
    if (from.length === 0) from.push(source);
    else from[from.length - 1] += ` CROSS JOIN LATERAL ${source}`;
    const element = `${quote(values)}."v"`;
    // :lower on a field with several values lowers each value.
    return {
      from,
      joins,
      element: path.modifier === "lower" ? `lower(${element})` : element,
    };
  }

  #chain(
    steps: RelationStep[],
    root: string,
  ): { from: string[]; joins: string[]; last: string } {
    const from: string[] = [];
    const joins: string[] = [];
    let previous = root;
    for (const step of steps) {
      const next = this.#alias();
      from.push(`{{${table(step.target.name)}}} ${quote(next)}`);
      const field = quote(step.field.name);
      if (!step.back) {
        const col = `${quote(previous)}.${field}`;
        joins.push(
          isMultiple(step.field)
            ? `${quote(next)}."id" = ANY(${col})`
            : `${quote(next)}."id" = ${col}`,
        );
      } else {
        const col = `${quote(next)}.${field}`;
        joins.push(
          isMultiple(step.field)
            ? `${quote(previous)}."id" = ANY(${col})`
            : `${col} = ${quote(previous)}."id"`,
        );
      }
      const visible = this.#visibility(step.target, next);
      if (visible) joins.push(visible);
      previous = next;
    }
    return { from, joins, last: previous };
  }

  #column(path: Path, alias: string, type: SqlType): string {
    const { field, collection, modifier, jsonKeys } = path;
    if (path.count) {
      const { from, joins } = this.#chain(path.steps, alias);
      return `(SELECT count(*) FROM ${from.join(", ")} WHERE ${joins.join(" AND ")})`;
    }
    const col = path.source ?? `${quote(alias)}.${quote(field.name)}`;
    if (modifier === "length") return `cardinality(${col})`;
    let sql = col;
    if (field.type === "json") {
      sql = this.#json(col, jsonKeys, modifier === "lower" ? "text" : type);
    } else if (
      // A hidden email still matches only when its owner shows it, or to the owner.
      this.#context.mode === "filter" &&
      !this.#context.principal.superuser &&
      collection.type === "auth" &&
      field.system &&
      field.name === "email"
    ) {
      const { principal } = this.#context;
      const owner =
        principal.collection?.id === collection.id
          ? principal.record?.id
          : undefined;
      sql = `(CASE WHEN ${quote(alias)}."emailVisibility" OR ${quote(alias)}."id" = ${this.#bind(owner ?? "", "text")} THEN ${col} ELSE '' END)`;
    } else if (
      // A phone matches only for its owner, so filters cannot find who has one.
      this.#context.mode === "filter" &&
      !this.#context.principal.superuser &&
      collection.type === "auth" &&
      field.system &&
      field.name === "phone"
    ) {
      const { principal } = this.#context;
      const owner =
        principal.collection?.id === collection.id
          ? principal.record?.id
          : undefined;
      sql = `(CASE WHEN ${quote(alias)}."id" = ${this.#bind(owner ?? "", "text")} THEN ${col} ELSE '' END)`;
    }
    // A field with several values is lowered value by value, in `#values`.
    return modifier === "lower" && !isPlural(path) ? `lower(${sql})` : sql;
  }

  // A mistyped or missing value reads as NULL rather than failing a cast.
  #json(col: string, keys: string[], type: SqlType): string {
    if (keys.length === 0) {
      if (type !== "text")
        throw new FilterError(
          "A whole JSON field can only be compared as text.",
        );
      return `${col}::text`;
    }
    const args = keys.map((key) => this.#bind(key, "text")).join(", ");
    const value = `jsonb_extract_path(${col}, ${args})`;
    const text = `jsonb_extract_path_text(${col}, ${args})`;
    switch (type) {
      case "text":
        return text;
      case "number":
        return `(CASE WHEN jsonb_typeof(${value}) = 'number' THEN (${text})::double precision END)`;
      case "bool":
        return `(CASE WHEN jsonb_typeof(${value}) = 'boolean' THEN (${text})::boolean END)`;
      case "date":
        // ISO 8601 strings only; anything else, or an impossible date, is NULL.
        return `(CASE WHEN jsonb_typeof(${value}) = 'string' THEN {{${table("parse_timestamptz")}}}(${text}) END)`;
    }
  }

  // So client filters cannot probe records the caller cannot view.
  #visibility(target: Collection, alias: string): string | undefined {
    const { mode, principal } = this.#context;
    if (mode === "rule" || principal.superuser) return undefined;
    if (target.viewRule === null) return "FALSE";
    const node = parseFilter(target.viewRule);
    if (!node) return undefined;
    const rule = new Compiler(
      { ...this.#context, mode: "rule" },
      this.#aliases + 100,
    );
    const sql = rule.compile(node, target, alias);
    this.#aliases = rule.#aliases;
    // Brings the rule's parameters over under fresh names.
    return sql.replace(/\{:(f\d+)\}/g, (_, name: string) => {
      const fresh = `f${Object.keys(this.params).length}`;
      this.params[fresh] = rule.params[name];
      return `{:${fresh}}`;
    });
  }
}

const MIRRORED: Record<Operator, Operator> = {
  "=": "=",
  "!=": "!=",
  ">": "<",
  ">=": "<=",
  "<": ">",
  "<=": ">=",
  "~": "~",
  "!~": "!~",
};

function startOfDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

/** Date macros, in UTC. */
const MACROS: Record<string, (now: Date) => Date> = {
  "@now": (now) => now,
  "@todayStart": startOfDay,
  "@todayEnd": (now) => new Date(startOfDay(now).getTime() + 86_400_000 - 1),
  "@monthStart": (now) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
  "@monthEnd": (now) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - 1),
  "@yearStart": (now) => new Date(Date.UTC(now.getUTCFullYear(), 0, 1)),
  "@yearEnd": (now) => new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1) - 1),
};

function sqlType(field: Field): SqlType {
  switch (field.type) {
    case "number":
      return "number";
    case "bool":
      return "bool";
    case "date":
    case "autodate":
      return "date";
    default:
      return "text";
  }
}

function isPlural(path: Path): boolean {
  return !path.count && isMultiple(path.field) && path.modifier !== "length";
}

/** True when `path` has at most one value: no plural field or step on the way. */
function isSingleValued(path: Path): boolean {
  return (
    !isPlural(path) &&
    path.steps.every((step) => !step.back && !isMultiple(step.field))
  );
}

function needsSubquery(path: Path): boolean {
  return !path.count && (path.steps.length > 0 || isPlural(path));
}

/** JSON values take `jsonType`, the type of the other operand. */
function pathType(path: Path, jsonType: SqlType): SqlType {
  if (path.count || path.modifier === "length") return "number";
  if (path.field.type === "json")
    return path.modifier === "lower" ? "text" : jsonType;
  return sqlType(path.field);
}

function isNullable(path: Path): boolean {
  const { field, modifier } = path;
  if (path.count || modifier === "length") return false;
  // A view's columns come from a query, which can produce NULL anywhere.
  if (path.collection.type === "view") return true;
  return (
    field.type === "json" ||
    field.type === "date" ||
    (field.type === "relation" && !isMultiple(field))
  );
}

function jsType(value: unknown): SqlType | undefined {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "bool";
  if (value instanceof Date) return "date";
  if (typeof value === "string") return "text";
  return undefined;
}

/** Blanks become the type's blank value. */
function coerce(value: unknown, type: SqlType, nullable: boolean): unknown {
  if (
    value === BLANK ||
    value === null ||
    (value === "" && (nullable || type === "date"))
  ) {
    if (nullable || type === "date") return null;
    return { text: "", number: 0, bool: false }[type];
  }
  switch (type) {
    case "text":
      if (typeof value === "string") {
        if (hasNul(value))
          throw new FilterError("Values cannot contain NUL characters.");
        return value;
      }
      if (typeof value === "number" || typeof value === "boolean")
        return String(value);
      break;
    case "number":
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (
        typeof value === "string" &&
        value.trim() !== "" &&
        Number.isFinite(Number(value))
      )
        return Number(value);
      break;
    case "bool":
      if (typeof value === "boolean") return value;
      break;
    case "date": {
      const time =
        value instanceof Date
          ? value.getTime()
          : typeof value === "string"
            ? parseDate(value)
            : Number.NaN;
      if (isStorableTime(time)) return timestampParam(new Date(time));
      break;
    }
  }
  throw new FilterError(
    `${JSON.stringify(value as Literal)} is not a valid ${type} value.`,
  );
}
