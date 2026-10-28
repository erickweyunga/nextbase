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
import {
  checkRelations,
  draftWrite,
  finishWrite,
  isRecordId,
  newPassword,
  type PreparedWrite,
  prepareWrite,
} from "./values.ts";

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
  /**
   * The collections, by name, that a batch wrote before this write. Its
   * checks before the transaction would not see those writes, so the checks
   * that read them are left to the transaction.
   */
  written?: ReadonlySet<string>;
}

/** Rules compile against this alias for the collection's rows. */
const ALIAS = "t0";
const MAX_PER_PAGE = 1000;
const DEFAULT_PER_PAGE = 30;
const MAX_EXPAND_DEPTH = 6;
const SUPERUSERS = "_superusers";
const MAX_BACK_RELATIONS = 1000;
const TOTAL = "_total";
// Postgres takes at most 65535 parameters per statement.
const MAX_PARAMETERS = 65_000;

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
  const plan = await planNewRecord(ctx, collection, input, query);
  return inTransaction(ctx.db, applyCreate(plan));
}

/** A create, checked as far as it can be before its transaction starts. */
export interface PlannedCreate {
  ctx: RecordsContext;
  collection: Collection;
  /** The input, with the record id chosen while planning. */
  input: Record<string, unknown>;
  query: URLSearchParams;
  passwordHash: string | undefined;
  newFiles: NewFiles | undefined;
}

/**
 * Checks a create as far as it can before its transaction starts. The rest is
 * done by `applyCreate`, or by `applyCreates` together with other creates.
 */
export async function planNewRecord(
  ctx: RecordsContext,
  collection: Collection,
  input: Record<string, unknown>,
  query: URLSearchParams,
): Promise<PlannedCreate> {
  checkWritable(collection);
  denyNullRule(ctx, collection.createRule);
  // Chosen now, so new files can be stored under the record beforehand.
  const write =
    input.id === undefined || input.id === ""
      ? { ...input, id: randomString(15, LOWER_ALPHANUMERIC) }
      : input;
  const newFiles = await readFiles(ctx, collection, write);
  await checkCreateRuleFirst(ctx, collection, write, newFiles);
  await checkNewPassword(ctx, collection, write);
  const passwordHash = await hashNewPassword(collection, write);
  await storeFiles(ctx, collection, write.id, newFiles);
  return { ctx, collection, input: write, query, passwordHash, newFiles };
}

/**
 * Checks the create rule with a plain read before the slow work of a create,
 * such as storing its files or hashing its password, so a caller the rule
 * refuses causes none of it. Only a create that passes its own checks is
 * checked here; the rest fail on those first. The transaction checks the rule
 * again either way.
 */
async function checkCreateRuleFirst(
  ctx: RecordsContext,
  collection: Collection,
  input: Record<string, unknown>,
  newFiles: NewFiles | undefined,
): Promise<void> {
  const slow = input.password !== undefined || (newFiles?.files.size ?? 0) > 0;
  if (!slow || ctx.principal.superuser || collection.createRule === "") return;
  const draft = draftWrite(input, writeOptions(ctx, collection, newFiles));
  if (!draft.issues.empty) return;
  const rule = createRule(ctx, collection, draft.prepared.body);
  if (!rule || !seesEveryWrite(ctx, collection, rule)) return;
  const refused = await refusedNewRows(ctx.pool, collection, [
    { row: draft.prepared.row, rule },
  ]);
  if (refused.length > 0) throw refusedCreate();
}

/** The create rule for a create whose checked body is `body`. */
function createRule(
  ctx: RecordsContext,
  collection: Collection,
  body: Record<string, unknown>,
): Expression | undefined {
  return compile(
    { ...ctx, request: { ...ctx.request, body } },
    collection,
    collection.createRule ?? "",
    "rule",
  );
}

function refusedCreate(): ApiError {
  return new ApiError(400, "Failed to create the record.");
}

/** The options to draft a create in `collection` with. */
function writeOptions(
  ctx: RecordsContext,
  collection: Collection,
  newFiles: NewFiles | undefined,
) {
  return {
    collection,
    schema: ctx.schema,
    privileged: ctx.principal.superuser,
    ...(ctx.vouched && { vouched: ctx.vouched }),
    newFiles,
  };
}

/** The rest of one create, to run in its transaction. */
export function applyCreate(plan: PlannedCreate): Apply<Output | undefined> {
  return async (tx) => {
    try {
      const [record] = await applyCreates(tx, [plan]);
      return record;
    } catch (error) {
      throw error instanceof CreateFailed ? error.error : error;
    }
  };
}

/** Thrown by `applyCreates`: the first create that failed, by position. */
export class CreateFailed extends Error {
  readonly index: number;
  readonly error: unknown;

  constructor(index: number, error: unknown) {
    super(`Create ${index + 1} failed.`);
    this.index = index;
    this.error = error;
  }
}

/**
 * Splits consecutive creates into runs that `applyCreates` can do together.
 * A run is one collection and one URL query, so the records come back the
 * same way. A create starts a new run when it points at a record created
 * earlier in the run, which does not exist until the run is inserted. A
 * create whose rules read its own collection runs alone, as when each is done
 * in turn, since those rules could see records the run inserts.
 */
export function createRuns(plans: readonly PlannedCreate[]): PlannedCreate[][] {
  const runs: PlannedCreate[][] = [];
  let run: PlannedCreate[] = [];
  let ids = new Set<string>();
  for (const plan of plans) {
    const [first] = run;
    if (
      !first ||
      !runsWithOthers(plan) ||
      !runsWithOthers(first) ||
      plan.collection.id !== first.collection.id ||
      plan.query.toString() !== first.query.toString() ||
      referencesAny(plan.input, ids)
    ) {
      if (first) runs.push(run);
      run = [];
      ids = new Set();
    }
    run.push(plan);
    ids.add(plan.input.id as string);
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

/**
 * False when the create or view rule reads the collection being created,
 * through `@collection`, a back-relation or a relation path. A run writes
 * only its own collection, and the batch's earlier writes are done before it
 * starts, so only such a rule could see records the run inserts.
 */
function runsWithOthers({ ctx, collection }: PlannedCreate): boolean {
  if (ctx.principal.superuser) return true;
  const own = `{{${table(collection.name)}}}`;
  return [collection.createRule, collection.viewRule].every((rule) => {
    if (!rule) return true;
    try {
      const sql = compile(ctx, collection, rule, "rule")?.build(ctx.pool, {});
      return !sql?.includes(own);
    } catch {
      // The write fails on its rule either way; alone, it fails as it would
      // in turn.
      return false;
    }
  });
}

function referencesAny(
  input: Record<string, unknown>,
  ids: ReadonlySet<string>,
): boolean {
  return Object.entries(input).some(
    ([key, value]) =>
      key !== "id" &&
      (Array.isArray(value) ? value : [value]).some(
        (v) => typeof v === "string" && ids.has(v),
      ),
  );
}

/**
 * Finishes creates of one collection in one transaction, with a few queries
 * for all of them: one per relation target, one for the create rule, the
 * insert, and one to read them back. Each create is checked as it would be
 * alone: its own problems first, then the create rule. Throws `CreateFailed`
 * for the first that fails. Returns each record, or undefined when the caller
 * may not view it.
 */
export async function applyCreates(
  tx: Tx,
  plans: readonly PlannedCreate[],
): Promise<(Output | undefined)[]> {
  const [first] = plans;
  if (!first) return [];
  const { ctx, collection, query } = first;
  const drafts = plans.map((plan) =>
    draftWrite(plan.input, {
      ...writeOptions(ctx, collection, plan.newFiles),
      passwordHash: plan.passwordHash,
    }),
  );
  // The create rule is checked before the relations, and before anything is
  // inserted, so a caller it refuses learns nothing about other records,
  // either from a missing related record or from a constraint error.
  const refused = new Set<number>();
  if (!ctx.principal.superuser && collection.createRule !== "") {
    // Compiled once when no row's own body can change it.
    const reads = (collection.createRule ?? "").includes("@request.body");
    const shared = reads ? undefined : createRule(ctx, collection, {});
    const checked = drafts.flatMap(({ prepared }, i) => {
      const rule = reads ? createRule(ctx, collection, prepared.body) : shared;
      return rule ? [{ i, row: prepared.row, rule }] : [];
    });
    if (checked.length > 0) {
      for (const k of await refusedNewRows(tx, collection, checked)) {
        refused.add((checked[k] as { i: number }).i);
      }
    }
  }
  await checkRelations(
    tx,
    ctx.schema,
    collection,
    drafts.filter((_, i) => !refused.has(i)),
  );
  // Each create is checked as it would be alone: its own problems first,
  // then the create rule.
  const failures = new Map<number, unknown>();
  const prepared: PreparedWrite[] = [];
  for (const [i, draft] of drafts.entries()) {
    if (!draft.issues.empty || !refused.has(i)) {
      try {
        prepared[i] = await finishWrite(draft);
      } catch (error) {
        failures.set(i, error);
      }
    } else {
      failures.set(i, refusedCreate());
    }
  }
  // The creates before the first failure are still inserted, so one of them
  // that duplicates a unique value is reported first, as it would be in turn.
  const failed = failures.size > 0 ? Math.min(...failures.keys()) : undefined;
  const allowed = prepared.slice(0, failed);
  for (const [i, write] of allowed.entries()) {
    try {
      await keepFiles(tx, ctx, collection, write.row.id as string, write);
    } catch (error) {
      throw new CreateFailed(i, error);
    }
  }
  if (allowed.length > 0) await insertRows(tx, collection, allowed);
  if (failed !== undefined)
    throw new CreateFailed(failed, failures.get(failed));
  return afterWrites(
    tx,
    ctx,
    collection,
    prepared.map((write) => write.row.id as string),
    query,
  );
}

/**
 * One INSERT for all rows, in chunks under Postgres's 65535 parameters per
 * statement. When an index refuses a row, because it duplicates a unique
 * value or is too long to index, Postgres does not say which row, so the
 * rows are then inserted one at a time to find the first that fails.
 */
async function insertRows(
  tx: Tx,
  collection: Collection,
  prepared: readonly PreparedWrite[],
): Promise<void> {
  const rows = prepared.map((write) => columnValues(collection, write.values));
  const insertOne = async (row: Record<string, unknown>, i: number) => {
    try {
      await writing(collection, () =>
        tx.insert(table(collection.name), row).execute(),
      );
    } catch (error) {
      throw new CreateFailed(i, error);
    }
  };
  const [only] = rows;
  if (rows.length === 1 && only) return insertOne(only, 0);
  const perChunk = Math.max(
    1,
    Math.floor(MAX_PARAMETERS / collection.fields.length),
  );
  try {
    // In a savepoint, so a duplicate can be undone and traced to its row.
    await tx.transaction(async (savepoint) => {
      for (let i = 0; i < rows.length; i += perChunk) {
        await savepoint
          .insertMany(table(collection.name), rows.slice(i, i + perChunk))
          .execute();
      }
    });
  } catch (error) {
    const { code } = error as { code?: unknown };
    if (code !== "23505" && code !== "54000") throw error;
    for (const [i, row] of rows.entries()) await insertOne(row, i);
  }
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
  const notFound = new ApiError(404, "Record not found.");
  const newFiles = await readFiles(ctx, collection, input);
  const slow = input.password !== undefined || (newFiles?.files.size ?? 0) > 0;
  const ruleChecked =
    slow &&
    (await checkUpdateRuleFirst(
      ctx,
      collection,
      id,
      input,
      newFiles,
      notFound,
    ));
  const old = ruleChecked
    ? await checkOldPasswordFirst(ctx, collection, id, input)
    : undefined;
  await checkNewPassword(ctx, collection, input);
  const passwordHash = await hashNewPassword(collection, input);
  await storeFiles(ctx, collection, id, newFiles);
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
 * Reads a write's new files before its transaction starts. Undefined when
 * the write cannot set files.
 */
async function readFiles(
  ctx: RecordsContext,
  collection: Collection,
  input: Record<string, unknown>,
): Promise<NewFiles | undefined> {
  if (!ctx.storage) return undefined;
  return readNewFiles(ctx.pool, ctx.storage, collection, input);
}

/**
 * Stores a write's new files under the record, before its transaction
 * starts, so storing holds neither a lock nor a connection. Files the write
 * turns out not to keep, because it fails, are deleted again.
 */
async function storeFiles(
  ctx: RecordsContext,
  collection: Collection,
  recordId: unknown,
  newFiles: NewFiles | undefined,
): Promise<void> {
  if (!ctx.storage || !newFiles || newFiles.files.size === 0) return;
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
 * Checks the update rule with plain reads before the transaction starts, so
 * a caller it refuses causes no slow work, such as checking a password or
 * storing files. Throws `notFound` when it refuses. A rule that reads
 * `@request.body` is checked with the body the transaction would check,
 * drafted from the stored record. Returns false when the check is left to
 * the transaction, which checks the rule again either way.
 */
async function checkUpdateRuleFirst(
  ctx: RecordsContext,
  collection: Collection,
  id: string,
  input: Record<string, unknown>,
  newFiles: NewFiles | undefined,
  notFound: ApiError,
): Promise<boolean> {
  if (ctx.principal.superuser) return true;
  const rule = collection.updateRule ?? "";
  if (rule === "") return true;
  let body: Record<string, unknown> = {};
  if (rule.includes("@request.body")) {
    // The body depends on the stored record and on related records, either
    // of which earlier writes of the batch may have changed.
    if ((ctx.written?.size ?? 0) > 0) return false;
    const [existing] = await ctx.pool
      .select("*")
      .from(table(collection.name))
      .where(hash({ id }))
      .all();
    if (!existing) throw notFound;
    const draft = draftWrite(input, {
      collection,
      schema: ctx.schema,
      existing,
      privileged: await canManage(ctx.pool, ctx, collection, id),
      newFiles,
    });
    await checkRelations(ctx.pool, ctx.schema, collection, [draft]);
    // As in the transaction, an invalid write is checked with an empty body.
    if (draft.issues.empty) body = draft.prepared.body;
  }
  const condition = compile(
    { ...ctx, request: { ...ctx.request, body } },
    collection,
    rule,
    "rule",
  );
  if (!seesEveryWrite(ctx, collection, condition)) return false;
  if (!(await matchesStoredRow(ctx.pool, collection, id, condition))) {
    throw notFound;
  }
  return true;
}

/**
 * Whether a read of `collection` with `condition`, made before the
 * transaction, sees what it would see in it: none of the collections it
 * reads was written earlier in the batch.
 */
function seesEveryWrite(
  ctx: RecordsContext,
  collection: Collection,
  condition: Expression | undefined,
): boolean {
  const { written } = ctx;
  if (!written || written.size === 0) return true;
  if (written.has(collection.name)) return false;
  // Every collection a compiled rule reads appears in it as its table.
  const sql = condition?.build(ctx.pool, {}) ?? "";
  return [...written].every((name) => !sql.includes(`{{${table(name)}}}`));
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
  const field = collection.fields.find((f) => f.type === "password");
  if (
    typeof oldPassword !== "string" ||
    !field ||
    // An invalid new password fails the update before the old one is checked.
    newPassword(field, input) === undefined ||
    ctx.principal.superuser ||
    collection.type !== "auth" ||
    // The stored password may have changed earlier in the batch.
    ctx.written?.has(collection.name)
  ) {
    return undefined;
  }
  // Managers need no old password, so theirs is not checked. Whether the
  // caller is one is left to the transaction when it may read earlier writes.
  const manage =
    collection.manageRule === null
      ? undefined
      : compile(ctx, collection, collection.manageRule, "rule");
  if (
    collection.manageRule !== null &&
    (!seesEveryWrite(ctx, collection, manage) ||
      (await matchesStoredRow(ctx.pool, collection, id, manage)))
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
      // Rules cannot read secrets, so they are never sent.
      const secret = field.type === "password" || field.name === "tokenKey";
      params[`nb_v${i}_${j}`] = secret
        ? null
        : columnValue(field, row[field.name]);
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

/** Like `afterWrite` for several records, with one read. */
async function afterWrites(
  q: Builder,
  ctx: RecordsContext,
  collection: Collection,
  ids: readonly string[],
  query: URLSearchParams,
): Promise<(Output | undefined)[]> {
  if (!ctx.principal.superuser && collection.viewRule === null)
    return ids.map(() => undefined);
  const rows = await q
    .select(`${ALIAS}.*`)
    .from(`${table(collection.name)} ${ALIAS}`)
    .where(
      and(
        exp(`"${ALIAS}"."id" = ANY({:nb_ids}::text[])`, { nb_ids: [...ids] }),
        ruleCondition(ctx, collection, collection.viewRule),
      ),
    )
    .all();
  // In the order of `rows`, and maybe without ids when `fields` leaves them out.
  const records = await output(q, ctx, collection, rows, query);
  const byId = new Map(
    rows.map((row, i) => [row.id as string, records[i] as Output]),
  );
  return ids.map((id) => byId.get(id));
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

/**
 * Runs `write` in the caller's transaction if there is one, or in a new one.
 * It makes no savepoint: when a write fails the request fails too, so the
 * whole transaction is rolled back anyway.
 */
function inTransaction<T>(db: DB | Tx, write: Apply<T>): Promise<T> {
  return db instanceof Tx ? write(db) : db.transaction(write);
}

/**
 * Runs a write, turning what the indexes refuse into a 400 on the indexed
 * fields: a duplicate in a unique index, or a value too long to index.
 */
async function writing<T>(
  collection: Collection,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const { code, constraint, message } = error as {
      code?: unknown;
      constraint?: unknown;
      message?: unknown;
    };
    if (code === "23505") {
      throw indexError(
        collection,
        constraint,
        "A record with these values already exists.",
        { code: "validation_not_unique", message: "Must be unique." },
      );
    }
    // An index entry must fit in a page. Postgres says so in one of two
    // messages, and names the index only in the second:
    // `index row requires 9016 bytes, maximum size is 8191`, or
    // `index row size 2720 exceeds btree version 4 maximum 2704 for index "x"`.
    if (
      code === "54000" &&
      typeof message === "string" &&
      message.startsWith("index row ")
    ) {
      throw indexError(
        collection,
        /for index "(.+)"$/.exec(message)?.[1],
        "A value is too long to index.",
        {
          code: "validation_length_out_of_range",
          message: "Too long for the field's index.",
        },
      );
    }
    throw error;
  }
}

function indexError(
  collection: Collection,
  indexName: unknown,
  message: string,
  problem: { code: string; message: string },
): ApiError {
  let names: string[];
  if (indexName === `_${collection.id}_pkey`) names = ["id"];
  else if (indexName === `_${collection.id}_email`) names = ["email"];
  else if (indexName === `_${collection.id}_phone`) names = ["phone"];
  else {
    const index = collection.indexes.find((i) => i.name === indexName);
    // System indexes are named `_{collection id}_{field id}`, and a suffix.
    const ids = index
      ? index.fields
      : collection.fields
          .filter(
            (f) =>
              typeof indexName === "string" &&
              indexName.startsWith(`_${collection.id}_${f.id}`),
          )
          .map((f) => f.id);
    names = ids.flatMap(
      (id) => collection.fields.find((f) => f.id === id)?.name ?? [],
    );
  }
  return new ApiError(
    400,
    message,
    Object.fromEntries(names.map((n) => [n, problem])),
  );
}
