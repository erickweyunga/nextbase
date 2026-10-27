import type { Collection, Field, ListResult } from "@nextbasejs/client";
import {
  and,
  type Builder,
  type DB,
  type Expression,
  exp,
  hash,
  type Params,
  type Row,
  type Tx,
} from "@nextbasejs/dbx";
import { checkBreached } from "../auth/breached.ts";
import { verifyPassword } from "../auth/password.ts";
import type { Principal } from "../auth/principal.ts";
import { rekeySessions } from "../auth/sessions.ts";
import { accountKey, clearAttempts, countAttempt } from "../auth/throttle.ts";
import { table } from "../db/system.ts";
import type { Effects } from "../effects.ts";
import { ApiError } from "../errors.ts";
import {
  type FileChanges,
  fileKey,
  fileNames,
  storeFiles,
} from "../files/files.ts";
import type { Storage } from "../files/storage.ts";
import { compileFilter, type RequestInfo } from "../filter/compiler.ts";
import { FilterError } from "../filter/parser.ts";
import type { Schema } from "../schema/cache.ts";
import { isMultiple } from "../schema/fields.ts";
import { isRecord } from "../schema/input.ts";
import { readAsViewRole } from "../schema/views.ts";
import { hasNul, timestampParam } from "../storable.ts";
import { serializeRecord } from "./serialize.ts";
import { prepareWrite } from "./values.ts";

export interface RecordsContext {
  /** A transaction when the request is part of a batch. */
  db: DB | Tx;
  /** The pool itself, for writes that must outlive a failed transaction. */
  pool: DB;
  schema: Schema;
  principal: Principal;
  request: RequestInfo;
  /** Reject new passwords found in data breaches (see auth/breached.ts). */
  rejectBreachedPasswords?: boolean;
  /** Protected auth fields NextBase itself sets in this write (see values.ts). */
  vouched?: ReadonlySet<string>;
  /** Required, with `storage`, for writes that change files. */
  effects?: Effects;
  storage?: Storage;
}

/** The SQL alias of the collection's rows in every records query. Rules compile against it. */
const ALIAS = "t0";
const MAX_PER_PAGE = 1000;
const DEFAULT_PER_PAGE = 30;
const MAX_EXPAND_DEPTH = 6;
const SUPERUSERS = "_superusers";
/** Records listed per back-relation in `expand`. */
const MAX_BACK_RELATIONS = 1000;

type Rule = string | null;
type Output = Record<string, unknown>;

export function listRecords(
  ctx: RecordsContext,
  collection: Collection,
  query: URLSearchParams,
): Promise<ListResult<Output>> {
  return reading(ctx, collection, (c) => list(c, collection, query));
}

async function list(
  ctx: RecordsContext,
  collection: Collection,
  query: URLSearchParams,
): Promise<ListResult<Output>> {
  const page = integerParam(query, "page", 1, 1, 1_000_000);
  const perPage = integerParam(
    query,
    "perPage",
    DEFAULT_PER_PAGE,
    1,
    MAX_PER_PAGE,
  );
  const where = and(
    ruleCondition(ctx, collection, collection.listRule),
    compile(ctx, collection, query.get("filter") ?? "", "filter"),
  );
  const from = `${table(collection.name)} ${ALIAS}`;
  const rows = await ctx.db
    .select(`${ALIAS}.*`)
    .from(from)
    .where(where)
    .orderBy(...sortColumns(ctx, collection, query.get("sort") ?? ""))
    .limit(perPage)
    .offset((page - 1) * perPage)
    .all();

  let totalItems = -1;
  let totalPages = -1;
  if (!isTrue(query.get("skipTotal"))) {
    const [count] = await ctx.db
      .select("COUNT(*)")
      .from(from)
      .where(where)
      .row<[string]>();
    totalItems = Number(count);
    totalPages = Math.ceil(totalItems / perPage);
  }
  const items = await output(ctx.db, ctx, collection, rows, query);
  return { page, perPage, totalItems, totalPages, items };
}

export function viewRecord(
  ctx: RecordsContext,
  collection: Collection,
  id: string,
  query: URLSearchParams,
): Promise<Output> {
  checkId(collection, id);
  return reading(ctx, collection, (c) => view(c, collection, id, query));
}

async function view(
  ctx: RecordsContext,
  collection: Collection,
  id: string,
  query: URLSearchParams,
): Promise<Output> {
  const record = await viewable(
    ctx.db,
    ctx,
    collection,
    id,
    query,
    ruleCondition(ctx, collection, collection.viewRule),
  );
  if (!record) throw new ApiError(404, "Record not found.");
  return record;
}

/** Creates a record. Returns it, or undefined when the caller may not view it. */
export async function newRecord(
  ctx: RecordsContext,
  collection: Collection,
  input: Record<string, unknown>,
  query: URLSearchParams,
): Promise<Output | undefined> {
  checkWritable(collection);
  denyNullRule(ctx, collection.createRule);
  await checkNewPassword(ctx, collection, input);
  return writing(collection, () =>
    ctx.db.transaction(async (tx) => {
      const prepared = await prepareWrite(tx, input, {
        collection,
        schema: ctx.schema,
        privileged: ctx.principal.superuser,
        ...(ctx.vouched && { vouched: ctx.vouched }),
        storage: ctx.storage,
      });
      // Checked on the would-be row before inserting, so a caller without
      // permission never learns anything from a constraint error.
      if (!ctx.principal.superuser && collection.createRule !== "") {
        const rule = compile(
          { ...ctx, request: { ...ctx.request, body: prepared.body } },
          collection,
          collection.createRule ?? "",
          "rule",
        );
        if (
          rule &&
          !(await matchesNewRow(tx, collection, prepared.row, rule))
        ) {
          throw new ApiError(400, "Failed to create the record.");
        }
      }
      await keepFiles(tx, ctx, collection, prepared.row.id as string, prepared);
      await tx
        .insert(
          table(collection.name),
          columnValues(collection, prepared.values),
        )
        .execute();
      return afterWrite(tx, ctx, collection, prepared.row.id as string, query);
    }),
  );
}

/** Updates a record. Returns it, or undefined when the caller may not view it. */
export async function updateRecord(
  ctx: RecordsContext,
  collection: Collection,
  id: string,
  input: Record<string, unknown>,
  query: URLSearchParams,
): Promise<Output | undefined> {
  checkWritable(collection);
  checkId(collection, id);
  denyNullRule(ctx, collection.updateRule);
  await checkNewPassword(ctx, collection, input);
  const notFound = new ApiError(404, "Record not found.");
  return writing(collection, () =>
    ctx.db.transaction(async (tx) => {
      const [existing] = await tx
        .newQuery(
          `SELECT * FROM {{${table(collection.name)}}} WHERE id = {:id} FOR UPDATE`,
        )
        .bind({ id })
        .all();
      if (!existing) throw notFound;

      let prepared: Awaited<ReturnType<typeof prepareWrite>> | undefined;
      let invalid: unknown;
      try {
        prepared = await prepareWrite(tx, input, {
          collection,
          schema: ctx.schema,
          existing,
          privileged: await canManage(tx, ctx, collection, id),
          storage: ctx.storage,
        });
      } catch (error) {
        invalid = error;
      }
      // The rule decides first: a caller it rejects gets a 404, never the
      // validation errors that would confirm the record exists. Bare fields
      // are the stored row; @request.body is the submitted values.
      if (!ctx.principal.superuser && collection.updateRule !== "") {
        const body = prepared?.body ?? {};
        const rule = compile(
          { ...ctx, request: { ...ctx.request, body } },
          collection,
          collection.updateRule ?? "",
          "rule",
        );
        if (!(await matchesStoredRow(tx, collection, id, rule))) throw notFound;
      }
      if (invalid !== undefined || !prepared) throw invalid;
      if (prepared.oldPassword !== undefined) {
        await checkOldPassword(ctx, collection, existing, prepared.oldPassword);
      }
      await keepFiles(tx, ctx, collection, id, prepared);
      if (Object.keys(prepared.values).length > 0) {
        await tx
          .update(
            table(collection.name),
            columnValues(collection, prepared.values),
            hash({ id }),
          )
          .execute();
      }
      // The owner learns of a password change they may not have made.
      const password = collection.fields.find((f) => f.type === "password");
      if (password && prepared.values[password.name] !== undefined) {
        ctx.effects?.mail.push({
          kind: "passwordChanged",
          collection: collection.name,
          to: existing.email as string,
        });
      }
      // A new tokenKey (password or email change) ends the record's other
      // sessions; the caller's own stays signed in.
      const { tokenKey } = prepared.values;
      if (collection.type === "auth" && typeof tokenKey === "string") {
        const { principal } = ctx;
        const own =
          principal.collection?.id === collection.id &&
          principal.record?.id === id;
        await rekeySessions(
          tx,
          collection,
          { id, tokenKey },
          own ? principal.session?.id : undefined,
        );
      }
      return afterWrite(tx, ctx, collection, id, query);
    }),
  );
}

export async function deleteRecord(
  ctx: RecordsContext,
  collection: Collection,
  id: string,
): Promise<void> {
  checkWritable(collection);
  checkId(collection, id);
  const rule = ruleCondition(ctx, collection, collection.deleteRule);
  await ctx.db.transaction(async (tx) => {
    if (collection.id === SUPERUSERS) await keepOneSuperuser(tx, id);
    if (!(await matchesStoredRow(tx, collection, id, rule, true))) {
      throw new ApiError(404, "Record not found.");
    }
    await deleteWithReferences(
      tx,
      ctx.schema,
      collection,
      id,
      new Set(),
      ctx.effects?.obsoleteFiles ?? [],
    );
  });
}

async function keepFiles(
  tx: Builder,
  ctx: RecordsContext,
  collection: Collection,
  id: string,
  { files }: { files: FileChanges },
): Promise<void> {
  if (files.added.length === 0 && files.removed.length === 0) return;
  if (!ctx.storage || !ctx.effects) {
    throw new Error("Writes that change files need storage and effects.");
  }
  await storeFiles(tx, ctx.storage, ctx.effects, collection, id, files);
}

/**
 * Checks a new password against data breaches, when enabled. Before the
 * write's transaction, so no row stays locked while the service answers.
 */
async function checkNewPassword(
  ctx: RecordsContext,
  collection: Collection,
  input: Record<string, unknown>,
): Promise<void> {
  if (!ctx.rejectBreachedPasswords || collection.type !== "auth") return;
  const field = collection.fields.find((f) => f.type === "password");
  const password = field && input[field.name];
  if (typeof password === "string") await checkBreached(password);
}

/**
 * Record ids are 15 lowercase letters or digits; anything else cannot exist.
 * A view's ids come from its query and can be any text.
 */
function checkId(collection: Collection, id: string): void {
  const valid =
    collection.type === "view"
      ? id !== "" && id.length <= 255 && !hasNul(id)
      : /^[a-z0-9]{15}$/.test(id);
  if (!valid) throw new ApiError(404, "Record not found.");
}

/**
 * Runs a read. A view collection's rows come from its query, which must run
 * as the view role, whose privileges keep it from what views may not read.
 */
function reading<T>(
  ctx: RecordsContext,
  collection: Collection,
  read: (ctx: RecordsContext) => Promise<T>,
): Promise<T> {
  if (collection.type !== "view") return read(ctx);
  return readAsViewRole(ctx.db, ctx.schema.viewRole, (tx) =>
    read({ ...ctx, db: tx }),
  );
}

/**
 * Checks the current password a password change gives, through the same
 * per-account throttle as login, counted outside the update's transaction so
 * a rejected change still counts.
 */
async function checkOldPassword(
  ctx: RecordsContext,
  collection: Collection,
  existing: Row,
  oldPassword: string,
): Promise<void> {
  const keys = [accountKey(collection.id, existing.id as string)];
  await countAttempt(ctx.pool, keys);
  if (!(await verifyPassword(oldPassword, existing.password as string))) {
    throw new ApiError(400, "Failed to update the record.", {
      oldPassword: {
        code: "validation_invalid_old_password",
        message: "Does not match the current password.",
      },
    });
  }
  await clearAttempts(ctx.pool, keys);
}

/** Views are read-only: their records are rows of a query. */
function checkWritable(collection: Collection): void {
  if (collection.type === "view") {
    throw new ApiError(400, "View collections are read-only.");
  }
}

/**
 * Refuses to delete the last superuser, which would lock everyone out of the
 * instance. Locks every superuser row first, so two concurrent deletes cannot
 * both see one other superuser left.
 */
async function keepOneSuperuser(tx: Builder, id: string): Promise<void> {
  const ids = await tx
    .newQuery(`SELECT id FROM {{${table(SUPERUSERS)}}} ORDER BY id FOR UPDATE`)
    .column<string>();
  if (ids.length === 1 && ids[0] === id) {
    throw new ApiError(400, "The last superuser cannot be deleted.");
  }
}

// --- rules -----------------------------------------------------------------

function denyNullRule(ctx: RecordsContext, rule: Rule): void {
  if (rule === null && !ctx.principal.superuser) {
    throw new ApiError(403, "Only superusers can perform this action.");
  }
}

/** A rule as a condition on ALIAS rows: none for superusers and empty rules, 403 for null rules. */
function ruleCondition(
  ctx: RecordsContext,
  collection: Collection,
  rule: Rule,
): Expression | undefined {
  denyNullRule(ctx, rule);
  if (ctx.principal.superuser) return undefined;
  return compile(ctx, collection, rule ?? "", "rule");
}

function compile(
  ctx: RecordsContext,
  collection: Collection,
  source: string,
  mode: "filter" | "rule",
): Expression | undefined {
  try {
    return compileFilter(source, collection, ALIAS, { ...ctx, mode });
  } catch (error) {
    if (!(error instanceof FilterError)) throw error;
    throw new ApiError(
      400,
      mode === "filter"
        ? `Invalid filter: ${error.message}`
        : `The request does not fit the collection's rule: ${error.message}`,
    );
  }
}

/** Whether the manageRule lets the caller change protected auth fields of record `id`. */
async function canManage(
  q: Builder,
  ctx: RecordsContext,
  collection: Collection,
  id: string,
): Promise<boolean> {
  if (ctx.principal.superuser) return true;
  if (collection.type !== "auth" || collection.manageRule === null)
    return false;
  return matchesStoredRow(
    q,
    collection,
    id,
    compile(ctx, collection, collection.manageRule, "rule"),
  );
}

async function matchesStoredRow(
  q: Builder,
  collection: Collection,
  id: string,
  rule: Expression | undefined,
  lock = false,
): Promise<boolean> {
  const query = q
    .select(`${ALIAS}.id`)
    .from(`${table(collection.name)} ${ALIAS}`)
    .where(and(hash({ [`${ALIAS}.id`]: id }), rule))
    .build();
  const rows = await q
    .newQuery(lock ? `${query.sql} FOR UPDATE OF "${ALIAS}"` : query.sql)
    .bind(query.params)
    .column();
  return rows.length > 0;
}

/** Evaluates a create rule on the row about to be inserted, as a one-row CTE named ALIAS. */
async function matchesNewRow(
  q: Builder,
  collection: Collection,
  row: Record<string, unknown>,
  rule: Expression,
): Promise<boolean> {
  const params: Params = {};
  const condition = rule.build(q, params);
  const columns = collection.fields.map((field, i) => {
    params[`nb_v${i}`] = columnValue(field, row[field.name]);
    return `{:nb_v${i}}::${columnCast(field)} AS ${q.quoteSimpleColumnName(field.name)}`;
  });
  const rows = await q
    .newQuery(
      `WITH "${ALIAS}" AS (SELECT ${columns.join(", ")}) SELECT 1 FROM "${ALIAS}" WHERE ${condition}`,
    )
    .bind(params)
    .column();
  return rows.length > 0;
}

/**
 * The records of `target` whose relation `field` points at each of `ids`, at
 * most MAX_BACK_RELATIONS per id, in id order. The limit applies per id in
 * the query itself, through a LATERAL subquery, so a record with millions of
 * related records costs no more than one with a thousand. A related record
 * can come back once per id it points at.
 */
async function backRelated(
  q: Builder,
  ctx: RecordsContext,
  target: Collection,
  field: Field,
  ids: string[],
): Promise<Row[]> {
  const params: Params = { nb_ids: ids };
  const rule = ruleCondition(ctx, target, target.viewRule)?.build(q, params);
  const column = `"${ALIAS}".${q.quoteSimpleColumnName(field.name)}`;
  const points = isMultiple(field)
    ? `"nb_parent"."id" = ANY(${column})`
    : `${column} = "nb_parent"."id"`;
  return q
    .newQuery(
      `SELECT "nb_related".* FROM unnest({:nb_ids}::text[]) AS "nb_parent"("id")
       CROSS JOIN LATERAL (
         SELECT "${ALIAS}".* FROM {{${table(target.name)}}} "${ALIAS}"
         WHERE ${points}${rule ? ` AND (${rule})` : ""}
         ORDER BY "${ALIAS}"."id" LIMIT ${MAX_BACK_RELATIONS}
       ) AS "nb_related"`,
    )
    .bind(params)
    .all();
}

async function afterWrite(
  q: Builder,
  ctx: RecordsContext,
  collection: Collection,
  id: string,
  query: URLSearchParams,
): Promise<Output | undefined> {
  if (!ctx.principal.superuser && collection.viewRule === null)
    return undefined;
  return viewable(
    q,
    ctx,
    collection,
    id,
    query,
    ruleCondition(ctx, collection, collection.viewRule),
  );
}

async function viewable(
  q: Builder,
  ctx: RecordsContext,
  collection: Collection,
  id: string,
  query: URLSearchParams,
  rule: Expression | undefined,
): Promise<Output | undefined> {
  const [row] = await q
    .select(`${ALIAS}.*`)
    .from(`${table(collection.name)} ${ALIAS}`)
    .where(and(hash({ [`${ALIAS}.id`]: id }), rule))
    .all();
  if (!row) return undefined;
  const [record] = await output(q, ctx, collection, [row], query);
  return record;
}

// --- deletes ---------------------------------------------------------------

/**
 * Deletes a record after resolving the relations that point at it: cascading
 * fields delete their records, others drop the reference, and a required
 * field that would be left blank blocks the delete.
 */
async function deleteWithReferences(
  tx: Builder,
  schema: Schema,
  collection: Collection,
  id: string,
  visited: Set<string>,
  obsoleteFiles: string[],
): Promise<void> {
  const key = `${collection.id}/${id}`;
  if (visited.has(key)) return;
  visited.add(key);
  for (const source of schema.collections) {
    for (const field of source.fields) {
      if (field.type !== "relation" || field.collectionId !== collection.id)
        continue;
      const multiple = isMultiple(field);
      const col = tx.quoteSimpleColumnName(field.name);
      const t = `{{${table(source.name)}}}`;
      const referencing = await tx
        .newQuery(
          `SELECT id, ${multiple ? `cardinality(${col})` : "1"} AS count FROM ${t} WHERE ${multiple ? `${col} @> ARRAY[{:id}]` : `${col} = {:id}`} FOR UPDATE`,
        )
        .bind({ id })
        .all<{ id: string; count: number }>();
      if (referencing.length === 0) continue;
      if (field.cascadeDelete) {
        for (const row of referencing)
          await deleteWithReferences(
            tx,
            schema,
            source,
            row.id,
            visited,
            obsoleteFiles,
          );
        continue;
      }
      if (field.required && referencing.some((r) => r.count <= 1)) {
        throw new ApiError(
          400,
          `The record is required by ${source.name}.${field.name}. Delete or change those records first.`,
        );
      }
      await tx
        .newQuery(
          `UPDATE ${t} SET ${col} = ${multiple ? `array_remove(${col}, {:id})` : "NULL"} WHERE ${multiple ? `${col} @> ARRAY[{:id}]` : `${col} = {:id}`}`,
        )
        .bind({ id })
        .execute();
    }
  }
  const fileFields = collection.fields.filter((f) => f.type === "file");
  if (fileFields.length > 0) {
    const [row] = await tx
      .select(...fileFields.map((f) => f.name))
      .from(table(collection.name))
      .where(hash({ id }))
      .all();
    for (const field of fileFields) {
      for (const name of fileNames(field, row?.[field.name])) {
        obsoleteFiles.push(fileKey(collection.id, id, name));
      }
    }
  }
  await tx.delete(table(collection.name), hash({ id })).execute();
  // Its sessions end, and its linked provider accounts may sign up again.
  if (collection.type === "auth") {
    for (const name of ["_sessions", "_linked_accounts"]) {
      await tx
        .newQuery(
          `DELETE FROM {{${table(name)}}} WHERE collection_id = {:collectionId} AND record_id = {:id}`,
        )
        .bind({ collectionId: collection.id, id })
        .execute();
    }
  }
}

// --- output ----------------------------------------------------------------

async function output(
  q: Builder,
  ctx: RecordsContext,
  collection: Collection,
  rows: Row[],
  query: URLSearchParams,
): Promise<Output[]> {
  const items = rows.map((row) => ({
    row,
    out: serializeRecord(collection, row, ctx.principal),
  }));
  const expand = query.get("expand");
  if (expand)
    await expandItems(
      q,
      ctx,
      collection,
      items,
      pathTree(expand, MAX_EXPAND_DEPTH, "expand"),
      1,
    );
  const fields = query.get("fields");
  if (!fields) return items.map((i) => i.out);
  const tree = pathTree(fields, Number.POSITIVE_INFINITY, "fields");
  return items.map((i) => pick(i.out, tree) as Output);
}

type PathTree = Map<string, PathTree>;

function pathTree(list: string, maxDepth: number, param: string): PathTree {
  const root: PathTree = new Map();
  for (const path of list.split(",")) {
    const names = path.trim().split(".").filter(Boolean);
    if (names.length > maxDepth)
      throw new ApiError(
        400,
        `${param} paths can be at most ${maxDepth} levels deep.`,
      );
    let node = root;
    for (const name of names) {
      let child = node.get(name);
      if (!child) {
        child = new Map();
        node.set(name, child);
      }
      node = child;
    }
  }
  return root;
}

/**
 * Loads related records into `expand`, level by level, one query per relation
 * field. Related records the caller may not view are left out.
 */
async function expandItems(
  q: Builder,
  ctx: RecordsContext,
  collection: Collection,
  items: { row: Row; out: Output }[],
  tree: PathTree,
  depth: number,
): Promise<void> {
  for (const [name, subtree] of tree) {
    // A relation field of this collection, or a back-relation such as
    // `comments_via_post`: the comments whose `post` points at these records.
    const forward = collection.fields.find(
      (f) => f.name === name && f.type === "relation",
    );
    const back = forward
      ? undefined
      : ctx.schema.backRelation(collection, name);
    const field = forward ?? back?.field;
    if (
      field?.type !== "relation" ||
      (field.hidden && !ctx.principal.superuser)
    )
      continue;
    const target = back ? back.source : ctx.schema.find(field.collectionId);
    if (!target || (target.viewRule === null && !ctx.principal.superuser))
      continue;
    const ids = [
      ...new Set(
        items.flatMap((i) =>
          back ? [i.row.id as string] : references(i.row[name]),
        ),
      ),
    ];
    if (ids.length === 0) continue;

    // One array parameter, whatever the number of ids: Postgres allows at
    // most 65535 parameters per statement.
    const rows = back
      ? await backRelated(q, ctx, target, field, ids)
      : await q
          .select(`${ALIAS}.*`)
          .from(`${table(target.name)} ${ALIAS}`)
          .where(
            and(
              exp(`"${ALIAS}"."id" = ANY({:ids}::text[])`, { ids }),
              ruleCondition(ctx, target, target.viewRule),
            ),
          )
          .orderBy(`${ALIAS}.id`)
          .all();
    // Once each, in id order: a record pointing at several parents comes
    // back once per parent.
    const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
    if (back)
      unique.sort((a, b) => ((a.id as string) < (b.id as string) ? -1 : 1));
    const related = unique.map((row) => ({
      row,
      out: serializeRecord(target, row, ctx.principal),
    }));
    if (subtree.size > 0)
      await expandItems(q, ctx, target, related, subtree, depth + 1);

    for (const item of items) {
      let found: Output[];
      let value: Output | Output[];
      if (back) {
        const id = item.row.id as string;
        found = related
          .filter((r) => references(r.row[field.name]).includes(id))
          .map((r) => r.out);
        value = found.slice(0, MAX_BACK_RELATIONS);
      } else {
        const byId = new Map(related.map((r) => [r.row.id as string, r.out]));
        found = references(item.row[name]).flatMap((id): Output[] => {
          const out = byId.get(id);
          return out ? [out] : [];
        });
        value = isMultiple(field) ? found : (found[0] as Output);
      }
      if (found.length === 0) continue;
      const expanded = (item.out.expand as Output | undefined) ?? {};
      expanded[name] = value;
      item.out.expand = expanded;
    }
  }
}

function references(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  return typeof value === "string" && value !== "" ? [value] : [];
}

/** Keeps the listed keys; `*` keeps every key at its level. */
function pick(value: unknown, tree: PathTree): unknown {
  if (Array.isArray(value)) return value.map((v) => pick(v, tree));
  if (!isRecord(value) || tree.size === 0) return value;
  const out: Output = tree.has("*") ? { ...value } : {};
  for (const [key, subtree] of tree) {
    if (key !== "*" && Object.hasOwn(value, key))
      out[key] = pick(value[key], subtree);
  }
  return out;
}

// --- helpers ---------------------------------------------------------------

function sortColumns(
  ctx: RecordsContext,
  collection: Collection,
  sort: string,
): string[] {
  const columns: string[] = [];
  for (const part of sort
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const descending = part.startsWith("-");
    const name = part.replace(/^[-+]/, "");
    const field = collection.fields.find((f) => f.name === name);
    if (
      !field ||
      isMultiple(field) ||
      field.type === "json" ||
      field.type === "password" ||
      field.name === "tokenKey" ||
      (field.hidden && !ctx.principal.superuser) ||
      // Sorting by an email or phone the caller may not see would reveal its order.
      (collection.type === "auth" &&
        field.system &&
        (field.name === "email" || field.name === "phone") &&
        !ctx.principal.superuser)
    ) {
      throw new ApiError(400, `Cannot sort by "${name}".`);
    }
    columns.push(`${ALIAS}.${name} ${descending ? "DESC" : "ASC"}`);
  }
  if (
    columns.length === 0 &&
    collection.fields.some((f) => f.name === "created" && f.type === "autodate")
  ) {
    columns.push(`${ALIAS}.created DESC`);
  }
  // A unique tiebreaker keeps pages stable. It follows the last column's
  // direction, so one (column, id) index serves the whole sort.
  columns.push(
    `${ALIAS}.id ${columns.at(-1)?.endsWith(" DESC") ? "DESC" : "ASC"}`,
  );
  return columns;
}

function integerParam(
  query: URLSearchParams,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = query.get(name);
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ApiError(
      400,
      `${name} must be an integer from ${min} to ${max}.`,
    );
  }
  return value;
}

function isTrue(value: string | null): boolean {
  return value === "1" || value === "true";
}

function columnCast(field: Field): string {
  if (isMultiple(field)) return "text[]";
  switch (field.type) {
    case "number":
      return "double precision";
    case "bool":
      return "boolean";
    case "date":
    case "autodate":
      return "timestamptz";
    case "json":
      return "jsonb";
    default:
      return "text";
  }
}

/** The value node-postgres should send. JSON is serialized here: it would turn arrays into Postgres arrays. */
function columnValue(field: Field, value: unknown): unknown {
  if (value instanceof Date) return timestampParam(value);
  if (field.type === "json")
    return value === null || value === undefined ? null : JSON.stringify(value);
  return value;
}

function columnValues(
  collection: Collection,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of collection.fields) {
    if (Object.hasOwn(values, field.name))
      out[field.name] = columnValue(field, values[field.name]);
  }
  return out;
}

/** Runs a write, reporting a unique-index violation as a 400 on the indexed fields. */
async function writing<T>(
  collection: Collection,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const { code, constraint } = error as {
      code?: unknown;
      constraint?: unknown;
    };
    if (code !== "23505") throw error;
    let names: string[] = [];
    if (constraint === `_${collection.id}_pkey`) names = ["id"];
    else if (constraint === `_${collection.id}_email`) names = ["email"];
    else if (constraint === `_${collection.id}_phone`) names = ["phone"];
    else {
      const index = collection.indexes.find((i) => i.name === constraint);
      names = (index?.fields ?? []).flatMap(
        (id) => collection.fields.find((f) => f.id === id)?.name ?? [],
      );
    }
    throw new ApiError(
      400,
      "A record with these values already exists.",
      Object.fromEntries(
        names.map((n) => [
          n,
          { code: "validation_not_unique", message: "Must be unique." },
        ]),
      ),
    );
  }
}
