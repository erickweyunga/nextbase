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
  Tx,
} from "@nextbasejs/dbx";
import { checkBreached } from "../auth/breached.ts";
import { hashPassword, verifyPassword } from "../auth/password.ts";
import type { Principal } from "../auth/principal.ts";
import { rekeySessions } from "../auth/sessions.ts";
import { accountKey, clearAttempts, countAttempt } from "../auth/throttle.ts";
import { table } from "../db/system.ts";
import type { Effects } from "../effects.ts";
import { ApiError } from "../errors.ts";
import {
  claimFiles,
  type FileChanges,
  fileKey,
  fileNames,
  type NewFiles,
  readNewFiles,
  storeNewFiles,
} from "../files/files.ts";
import type { Storage } from "../files/storage.ts";
import { compileFilter, type RequestInfo } from "../filter/compiler.ts";
import { FilterError } from "../filter/parser.ts";
import { LOWER_ALPHANUMERIC, randomString } from "../random.ts";
import type { Schema } from "../schema/cache.ts";
import { isMultiple } from "../schema/fields.ts";
import { isRecord } from "../schema/input.ts";
import { readAsViewRole } from "../schema/views.ts";
import { hasNul, timestampParam } from "../storable.ts";
import { serializeRecord } from "./serialize.ts";
import { isRecordId, newPassword, prepareWrite } from "./values.ts";

export interface RecordsContext {
  db: DB | Tx;
  /** For writes that must outlive a failed transaction. */
  pool: DB;
  schema: Schema;
  principal: Principal;
  request: RequestInfo;
  rejectBreachedPasswords?: boolean;
  /** Protected auth fields NextBase itself sets in this write. */
  vouched?: ReadonlySet<string>;
  /** Required, with `storage`, for writes that change files. */
  effects?: Effects;
  storage?: Storage;
}

/** Rules compile against this alias for the collection's rows. */
const ALIAS = "t0";
const MAX_PER_PAGE = 1000;
const DEFAULT_PER_PAGE = 30;
const MAX_EXPAND_DEPTH = 6;
const SUPERUSERS = "_superusers";
const MAX_BACK_RELATIONS = 1000;
const TOTAL = "_total";

type Rule = string | null;
type Output = Record<string, unknown>;

/** The part of a write that runs in its transaction. */
export type Apply<T> = (tx: Tx) => Promise<T>;

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
  const counted = !isTrue(query.get("skipTotal"));
  const count = ctx.db.select("COUNT(*)").from(from).where(where).build();
  const select = ctx.db
    .select(`${ALIAS}.*`)
    .from(from)
    .where(where)
    .orderBy(...sortColumns(ctx, collection, query.get("sort") ?? ""))
    .limit(perPage)
    .offset((page - 1) * perPage);
  // The total is read in the same query as the page, as an extra column.
  // Postgres counts once for the query, not once per row. Field names start
  // with a letter, so `_total` cannot clash with a field.
  if (counted) {
    select.andSelect(`(${count.sql}) AS ${TOTAL}`).andBind(count.params);
  }
  const rows = await select.all();

  let totalItems = -1;
  let totalPages = -1;
  if (counted) {
    const first = rows[0];
    if (first) {
      totalItems = Number(first[TOTAL]);
      for (const row of rows) delete row[TOTAL];
    } else if (page === 1) {
      totalItems = 0;
    } else {
      // A page past the end returns no rows, so the total is counted apart.
      totalItems = Number((await count.row<[string]>())[0]);
    }
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

/** Returns the record, or undefined when the caller may not view it. */
export async function newRecord(
  ctx: RecordsContext,
  collection: Collection,
  input: Record<string, unknown>,
  query: URLSearchParams,
): Promise<Output | undefined> {
  const apply = await planNewRecord(ctx, collection, input, query);
  return inTransaction(ctx.db, apply);
}

/**
 * Checks a create as far as it can before its transaction starts, and returns
 * the rest of the work to run in that transaction.
 */
export async function planNewRecord(
  ctx: RecordsContext,
  collection: Collection,
  input: Record<string, unknown>,
  query: URLSearchParams,
): Promise<Apply<Output | undefined>> {
  checkWritable(collection);
  denyNullRule(ctx, collection.createRule);
  // Chosen now, so new files can be stored under the record beforehand.
  const write =
    input.id === undefined || input.id === ""
      ? { ...input, id: randomString(15, LOWER_ALPHANUMERIC) }
      : input;
  await checkNewPassword(ctx, collection, write);
  const passwordHash = await hashNewPassword(collection, write);
  const newFiles = await prepareNewFiles(ctx, collection, write, write.id);
  return (tx) =>
    writing(collection, async () => {
      const prepared = await prepareWrite(tx, write, {
        collection,
        schema: ctx.schema,
        privileged: ctx.principal.superuser,
        ...(ctx.vouched && { vouched: ctx.vouched }),
        newFiles,
        passwordHash,
      });
      // Checked before inserting, so a denied caller learns nothing from a
      // constraint error.
      if (!ctx.principal.superuser && collection.createRule !== "") {
        const rule = compile(
          { ...ctx, request: { ...ctx.request, body: prepared.body } },
          collection,
          collection.createRule ?? "",
          "rule",
        );
        if (
          rule &&
          (await refusedNewRows(tx, collection, [{ row: prepared.row, rule }]))
            .length > 0
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
    });
}

/** Returns the record, or undefined when the caller may not view it. */
export async function updateRecord(
  ctx: RecordsContext,
  collection: Collection,
  id: string,
  input: Record<string, unknown>,
  query: URLSearchParams,
): Promise<Output | undefined> {
  const apply = await planUpdateRecord(ctx, collection, id, input, query);
  return inTransaction(ctx.db, apply);
}

/**
 * Checks an update as far as it can before its transaction starts, and
 * returns the rest of the work to run in that transaction.
 */
export async function planUpdateRecord(
  ctx: RecordsContext,
  collection: Collection,
  id: string,
  input: Record<string, unknown>,
  query: URLSearchParams,
): Promise<Apply<Output | undefined>> {
  checkWritable(collection);
  checkId(collection, id);
  denyNullRule(ctx, collection.updateRule);
  await checkNewPassword(ctx, collection, input);
  const notFound = new ApiError(404, "Record not found.");
  const slow = input.password !== undefined || touchesFiles(collection, input);
  const ruleChecked =
    slow && (await checkUpdateRuleFirst(ctx, collection, id, notFound));
  const old = ruleChecked
    ? await checkOldPasswordFirst(ctx, collection, id, input)
    : undefined;
  const passwordHash = await hashNewPassword(collection, input);
  const newFiles = await prepareNewFiles(ctx, collection, input, id);
  return (tx) =>
    writing(collection, async () => {
      // NO KEY: ids never change, so records that reference this one can
      // still be created or changed while it is locked.
      const [existing] = await tx
        .newQuery(
          `SELECT * FROM {{${table(collection.name)}}} WHERE id = {:id} FOR NO KEY UPDATE`,
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
          newFiles,
          passwordHash,
        });
      } catch (error) {
        invalid = error;
      }
      // Rule first: a rejected caller gets 404, never validation errors that
      // would confirm the record exists.
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
        const matches = old
          ? // Checked before the transaction: confirm it is still the same.
            old.matched === existing.password
          : await oldPasswordMatches(
              ctx,
              collection,
              id,
              existing.password as string,
              prepared.oldPassword,
            );
        if (!matches) throw wrongOldPassword();
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
      // A new tokenKey ends the record's other sessions; the caller's stays.
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
    });
}

/**
 * Checks a delete as far as it can before its transaction starts, and returns
 * the rest of the work to run in that transaction.
 */
export async function planDeleteRecord(
  ctx: RecordsContext,
  collection: Collection,
  id: string,
): Promise<Apply<void>> {
  checkWritable(collection);
  checkId(collection, id);
  const rule = ruleCondition(ctx, collection, collection.deleteRule);
  return async (tx) => {
    if (collection.id === SUPERUSERS) await keepOneSuperuser(tx, id);
    if (!(await matchesStoredRow(tx, collection, id, rule, true))) {
      throw new ApiError(404, "Record not found.");
    }
    await deleteWithReferences(
      tx,
      ctx.schema,
      collection,
      [id],
      new Set(),
      ctx.effects?.obsoleteFiles ?? [],
    );
  };
}

async function keepFiles(
  tx: Builder,
  ctx: RecordsContext,
  collection: Collection,
  id: string,
  { files }: { files: FileChanges },
): Promise<void> {
  if (files.added.length === 0 && files.removed.length === 0) return;
  if (!ctx.effects) {
    throw new Error("Writes that change files need storage and effects.");
  }
  await claimFiles(tx, ctx.effects, collection, id, files);
}

/**
 * Reads a write's new files and stores them under the record, before its
 * transaction starts, so neither holds a lock or a connection. Undefined
 * when the write cannot set files. Files the write turns out not to keep,
 * because it fails, are deleted again.
 */
async function prepareNewFiles(
  ctx: RecordsContext,
  collection: Collection,
  input: Record<string, unknown>,
  recordId: unknown,
): Promise<NewFiles | undefined> {
  if (!ctx.storage) return undefined;
  const newFiles = await readNewFiles(ctx.pool, ctx.storage, collection, input);
  if (newFiles.files.size === 0) return newFiles;
  if (!ctx.effects) {
    throw new Error("Writes that change files need storage and effects.");
  }
  // A write with bad files or a bad id fails, so its files are not stored.
  if (newFiles.problems.size === 0 && isRecordId(recordId)) {
    await storeNewFiles(
      ctx.storage,
      ctx.effects,
      collection,
      recordId,
      newFiles,
    );
  }
  return newFiles;
}

function touchesFiles(
  collection: Collection,
  input: Record<string, unknown>,
): boolean {
  return collection.fields.some(
    (f) =>
      f.type === "file" &&
      [f.name, `+${f.name}`, `${f.name}+`, `${f.name}-`].some(
        (key) => input[key] !== undefined,
      ),
  );
}

// Runs before the write's transaction, so no row stays locked during the lookup.
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

// A view's ids come from its query and can be any text.
function checkId(collection: Collection, id: string): void {
  const valid =
    collection.type === "view"
      ? id !== "" && id.length <= 255 && !hasNul(id)
      : /^[a-z0-9]{15}$/.test(id);
  if (!valid) throw new ApiError(404, "Record not found.");
}

// View queries run as the view role, whose privileges limit what they can read.
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

// Throttled like login, counted outside the update's transaction so a rejected
// attempt still counts.
async function oldPasswordMatches(
  ctx: RecordsContext,
  collection: Collection,
  id: string,
  stored: string,
  oldPassword: string,
): Promise<boolean> {
  const keys = [accountKey(collection.id, id)];
  await countAttempt(ctx.pool, keys);
  if (!(await verifyPassword(oldPassword, stored))) return false;
  await clearAttempts(ctx.pool, keys);
  return true;
}

/**
 * Checks the update rule with a plain read before the transaction starts, so
 * a caller it refuses causes no slow work, such as checking a password or
 * storing files. Throws `notFound` when it refuses. Returns false when the
 * rule reads `@request.body`, which needs the checked body only the
 * transaction has. The transaction checks the rule again either way.
 */
async function checkUpdateRuleFirst(
  ctx: RecordsContext,
  collection: Collection,
  id: string,
  notFound: ApiError,
): Promise<boolean> {
  if (ctx.principal.superuser) return true;
  const rule = collection.updateRule ?? "";
  if (rule.includes("@request.body")) return false;
  if (
    rule !== "" &&
    !(await matchesStoredRow(
      ctx.pool,
      collection,
      id,
      compile(ctx, collection, rule, "rule"),
    ))
  ) {
    throw notFound;
  }
  return true;
}

/**
 * Checks the old password before the update's transaction starts, so the slow
 * check holds no lock and no connection. Call it only once
 * `checkUpdateRuleFirst` has allowed the caller, so someone the rule refuses
 * can neither guess the password nor lock the account.
 *
 * Returns the stored hash the old password matched, which the transaction
 * then confirms is still stored, or `matched: undefined` when it did not
 * match. Returns undefined when there is no old password to check.
 */
async function checkOldPasswordFirst(
  ctx: RecordsContext,
  collection: Collection,
  id: string,
  input: Record<string, unknown>,
): Promise<{ matched: string | undefined } | undefined> {
  const { oldPassword } = input;
  if (
    typeof oldPassword !== "string" ||
    input.password === undefined ||
    ctx.principal.superuser ||
    collection.type !== "auth"
  ) {
    return undefined;
  }
  const [stored] = await ctx.pool
    .select("password")
    .from(table(collection.name))
    .where(hash({ id }))
    .column<string>();
  if (stored === undefined) return { matched: undefined };
  const matches = await oldPasswordMatches(
    ctx,
    collection,
    id,
    stored,
    oldPassword,
  );
  return { matched: matches ? stored : undefined };
}

function wrongOldPassword(): ApiError {
  return new ApiError(400, "Failed to update the record.", {
    oldPassword: {
      code: "validation_invalid_old_password",
      message: "Does not match the current password.",
    },
  });
}

/** Hashed before the write's transaction starts, so the slow hash holds no lock. */
async function hashNewPassword(
  collection: Collection,
  input: Record<string, unknown>,
): Promise<string | undefined> {
  const field = collection.fields.find((f) => f.type === "password");
  const password = field && newPassword(field, input);
  return password === undefined ? undefined : hashPassword(password);
}

function checkWritable(collection: Collection): void {
  if (collection.type === "view") {
    throw new ApiError(400, "View collections are read-only.");
  }
}

// Locks every superuser row so two concurrent deletes cannot both see one left.
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

/** None for superusers and empty rules; 403 for null rules. */
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

/** Whether manageRule lets the caller change protected auth fields of `id`. */
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

/**
 * Evaluates the create rule on pending rows in one query, as a table named
 * ALIAS with one row each. Each row comes with its own compiled rule, since a
 * rule can read that row's `@request.body`. Returns the positions of the rows
 * the rule refuses.
 */
async function refusedNewRows(
  q: Builder,
  collection: Collection,
  rows: readonly { row: Record<string, unknown>; rule: Expression }[],
): Promise<number[]> {
  const params: Params = {};
  const tuples = rows.map(({ row }, i) => {
    const values = collection.fields.map((field, j) => {
      params[`nb_v${i}_${j}`] = columnValue(field, row[field.name]);
      return `{:nb_v${i}_${j}}::${columnCast(field)}`;
    });
    return `(${i}, ${values.join(", ")})`;
  });
  // Field names start with a letter, so `_i` cannot clash with one.
  const columns = [
    `"_i"`,
    ...collection.fields.map((field) => q.quoteSimpleColumnName(field.name)),
  ];
  const [first] = rows;
  const condition =
    first && rows.every(({ rule }) => rule === first.rule)
      ? first.rule.build(q, params)
      : `CASE "_i" ${rows.map(({ rule }, i) => `WHEN ${i} THEN ${rule.build(q, params)}`).join(" ")} END`;
  return q
    .newQuery(
      `WITH "${ALIAS}"(${columns.join(", ")}) AS (VALUES ${tuples.join(", ")}) SELECT "_i" FROM "${ALIAS}" WHERE NOT COALESCE(${condition}, false) ORDER BY "_i"`,
    )
    .bind(params)
    .column<number>();
}

/**
 * At most MAX_BACK_RELATIONS per id, limited in a LATERAL subquery so a huge
 * fan-out stays cheap. A record can come back once per id it points at.
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

// Cascading relations delete, others drop the reference, and a required field
// that would be left blank blocks the delete. Works on every record of one
// level at once, so a delete takes a few queries per level, not per record.
async function deleteWithReferences(
  tx: Builder,
  schema: Schema,
  collection: Collection,
  ids: readonly string[],
  visited: Set<string>,
  obsoleteFiles: string[],
): Promise<void> {
  // A cycle of cascades reaches the same record again.
  const pending = ids.filter((id) => !visited.has(`${collection.id}/${id}`));
  if (pending.length === 0) return;
  for (const id of pending) visited.add(`${collection.id}/${id}`);
  const params = { ids: pending };
  for (const source of schema.collections) {
    for (const field of source.fields) {
      if (field.type !== "relation" || field.collectionId !== collection.id)
        continue;
      const multiple = isMultiple(field);
      const col = tx.quoteSimpleColumnName(field.name);
      const t = `{{${table(source.name)}}}`;
      const refers = multiple
        ? `${col} && {:ids}::text[]`
        : `${col} = ANY({:ids}::text[])`;
      // What is left of the field once the deleted ids are taken out.
      const kept = `ARRAY(SELECT v FROM unnest(${col}) AS v WHERE v <> ALL({:ids}::text[]))`;
      // Locked in id order, so concurrent deletes lock rows in the same order.
      const referencing = await tx
        .newQuery(
          `SELECT id, ${multiple ? `cardinality(${kept})` : "0"} AS kept FROM ${t} WHERE ${refers} ORDER BY id FOR UPDATE`,
        )
        .bind(params)
        .all<{ id: string; kept: number }>();
      if (referencing.length === 0) continue;
      if (field.cascadeDelete) {
        await deleteWithReferences(
          tx,
          schema,
          source,
          referencing.map((row) => row.id),
          visited,
          obsoleteFiles,
        );
        continue;
      }
      if (field.required && referencing.some((row) => row.kept === 0)) {
        throw new ApiError(
          400,
          `The record is required by ${source.name}.${field.name}. Delete or change those records first.`,
        );
      }
      await tx
        .newQuery(
          `UPDATE ${t} SET ${col} = ${multiple ? kept : "NULL"} WHERE ${refers}`,
        )
        .bind(params)
        .execute();
    }
  }
  const fileFields = collection.fields.filter((f) => f.type === "file");
  if (fileFields.length > 0) {
    const rows = await tx
      .select("id", ...fileFields.map((f) => f.name))
      .from(table(collection.name))
      .where(exp("id = ANY({:ids}::text[])", params))
      .all();
    for (const row of rows) {
      for (const field of fileFields) {
        for (const name of fileNames(field, row[field.name])) {
          obsoleteFiles.push(fileKey(collection.id, row.id as string, name));
        }
      }
    }
  }
  await tx
    .newQuery(
      `DELETE FROM {{${table(collection.name)}}} WHERE id = ANY({:ids}::text[])`,
    )
    .bind(params)
    .execute();
  // Their sessions end, and their linked provider accounts may sign up again.
  if (collection.type === "auth") {
    for (const name of ["_sessions", "_linked_accounts"]) {
      await tx
        .newQuery(
          `DELETE FROM {{${table(name)}}} WHERE collection_id = {:collectionId} AND record_id = ANY({:ids}::text[])`,
        )
        .bind({ collectionId: collection.id, ...params })
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

// One query per relation field per level; records the caller may not view are left out.
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

    // One array parameter: Postgres allows at most 65535 parameters per statement.
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
    // A record pointing at several parents comes back once per parent.
    const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
    if (back)
      unique.sort((a, b) => ((a.id as string) < (b.id as string) ? -1 : 1));
    const related = unique.map((row) => ({
      row,
      out: serializeRecord(target, row, ctx.principal),
    }));
    if (subtree.size > 0)
      await expandItems(q, ctx, target, related, subtree, depth + 1);

    // Built once before the loop, so matching items to related records takes
    // one pass, not one pass per item.
    const byId = new Map(related.map((r) => [r.row.id as string, r.out]));
    const byParent = back
      ? groupByParent(related, field.name)
      : new Map<string, Output[]>();

    for (const item of items) {
      let found: Output[];
      let value: Output | Output[];
      if (back) {
        found = byParent.get(item.row.id as string) ?? [];
        value = found.slice(0, MAX_BACK_RELATIONS);
      } else {
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

/**
 * Groups records found through a back-relation by the parent each points at.
 * A record that lists the same parent twice is grouped under it once.
 */
function groupByParent(
  related: readonly { row: Row; out: Output }[],
  fieldName: string,
): Map<string, Output[]> {
  const groups = new Map<string, Output[]>();
  for (const { row, out } of related) {
    for (const parent of new Set(references(row[fieldName]))) {
      const group = groups.get(parent);
      if (group) group.push(out);
      else groups.set(parent, [out]);
    }
  }
  return groups;
}

function references(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  return typeof value === "string" && value !== "" ? [value] : [];
}

/** `*` keeps every key at its level. */
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
  // Unique tiebreaker for stable pages, in the last column's direction so one
  // (column, id) index serves the whole sort.
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

// JSON is serialized here: node-postgres would turn arrays into Postgres arrays.
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

// A unique-index violation becomes a 400 on the indexed fields.
/**
 * Runs `write` in the caller's transaction if there is one, or in a new one.
 * It makes no savepoint: when a write fails the request fails too, so the
 * whole transaction is rolled back anyway.
 */
function inTransaction<T>(db: DB | Tx, write: Apply<T>): Promise<T> {
  return db instanceof Tx ? write(db) : db.transaction(write);
}

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
