import type {
  AuthCollection,
  AuthMethods,
  Collection,
} from "@nextbasejs/client";
import { type DB, hash, type Tx, type TxOptions } from "@nextbasejs/dbx";
import {
  confirmEmailChange,
  confirmEmailVerification,
  confirmPasswordReset,
  type FlowContext,
  requestEmailChange,
  requestEmailVerification,
  requestPasswordReset,
} from "../auth/flows.ts";
import {
  accountFor,
  listLinkedAccounts,
  unlinkAccount,
} from "../auth/linked-accounts.ts";
import { authWithPassword, checkAuthRule } from "../auth/login.ts";
import type { Mailer } from "../auth/mail.ts";
import {
  checkRedirect,
  type OAuth2,
  OAuth2Error,
  setStateCookie,
} from "../auth/oauth2.ts";
import {
  authWithPhoneCode,
  confirmPasswordResetByPhone,
  confirmPhoneVerification,
  type PhoneContext,
  requestPasswordResetByPhone,
  requestPhoneCode,
  requestPhoneVerification,
} from "../auth/phone.ts";
import {
  type Principal,
  recordIn,
  requireSuperuser,
} from "../auth/principal.ts";
import {
  bearerToken,
  checkSameOrigin,
  createSession,
  deleteOtherSessions,
  deleteSession,
  extendSession,
  listSessions,
  type OriginPolicy,
  type Session,
  sessionCookie,
  sessionModel,
  setSessionCookie,
} from "../auth/sessions.ts";
import type { Sms } from "../auth/sms.ts";
import { completeSetup, hasSuperuser } from "../auth/superusers.ts";
import { table } from "../db/system.ts";
import type { Effects } from "../effects.ts";
import { ApiError } from "../errors.ts";
import {
  createUpload,
  fileResponse,
  fileToken,
  findFile,
  principalOfFileToken,
} from "../files/serve.ts";
import type { Storage } from "../files/storage.ts";
import { readJsonObject, readRecordBody } from "../http.ts";
import { newId } from "../random.ts";
import type { Realtime } from "../realtime/stream.ts";
import type { Hooks } from "../records/hooks.ts";
import { serializeRecord } from "../records/serialize.ts";
import {
  type Apply,
  applyCreate,
  applyCreates,
  CreateFailed,
  createRuns,
  listRecords,
  outputRecord,
  type PlannedCreate,
  planDeleteRecord,
  planNewRecord,
  planUpdateRecord,
  type RecordsContext,
  viewRecord,
} from "../records/service.ts";
import { SCHEMA_VERSION_SQL, type Schema } from "../schema/cache.ts";
import {
  deleteCollection,
  newCollection,
  updateCollection,
} from "../schema/sync.ts";

interface Context {
  request: Request;
  params: string[];
  db: DB;
  schema: Schema;
  principal: Principal;
  /** Sent by server code through `client()`, not by a browser. */
  inProcess: boolean;
  /** 0 means no limit. */
  statementTimeout: number;
  /**
   * The route's transaction, if the route is marked `transaction`, or the
   * transaction of the on hook whose `e.nextbase` sent the request.
   */
  tx?: Tx;
  origins: OriginPolicy;
  mailer: Mailer;
  sms: Sms;
  oauth2: OAuth2;
  rejectBreachedPasswords: boolean;
  effects: Effects;
  storage: Storage;
  hooks: Hooks;
  /** Undefined when realtime is not enabled. */
  realtime: Realtime | undefined;
  /** For a request sent through `e.nextbase`: the on hooks that led to it. */
  hookChain: readonly string[];
}

export interface Route {
  method: string;
  /** Matched against the path below `basePath`; groups become `params`. */
  pattern: RegExp;
  /**
   * The route runs in a transaction opened before the handler, which also
   * reads the schema version. Use it only for routes that hold the
   * transaction briefly: a route that reads a request body would keep the
   * connection busy while the body arrives.
   */
  transaction?: true;
  /**
   * The route writes and locks only through `bounded`, so it can run in the
   * transaction of an on hook, for the hook's `e.nextbase`.
   */
  joinsTransaction?: true;
  /**
   * The response is a stream that stays open, so the request does not renew
   * the session: the renewed cookie could only be sent once it ends.
   */
  stream?: true;
  handler(context: Context): Promise<Response>;
}

const segment = "([^/]+)";
const SUPERUSERS = "_superusers";

const records = new RegExp(`^/collections/${segment}/records$`);
const record = new RegExp(`^/collections/${segment}/records/${segment}$`);
const linkedAccounts = new RegExp(
  `^/collections/${segment}/records/${segment}/linked-accounts$`,
);

export const ROUTES: readonly Route[] = [
  {
    method: "GET",
    pattern: records,
    transaction: true,
    joinsTransaction: true,
    async handler(context) {
      const { url } = parse(context);
      const collection = context.schema.get(context.params[0] as string);
      return Response.json(
        await bounded(context, (db) =>
          listRecords(
            recordsContext(context, {}, { db }),
            collection,
            url.searchParams,
          ),
        ),
      );
    },
  },
  {
    method: "POST",
    pattern: records,
    joinsTransaction: true,
    async handler(context) {
      const body = await readRecordBody(context.request);
      return replyOf(
        await writeRecord(context, {
          method: "POST",
          collection: context.params[0] as string,
          body,
          query: parse(context).url.searchParams,
        }),
      );
    },
  },
  {
    method: "GET",
    pattern: record,
    transaction: true,
    joinsTransaction: true,
    async handler(context) {
      const { url } = parse(context);
      const [collection, id] = context.params as [string, string];
      const target = context.schema.get(collection);
      return Response.json(
        await bounded(context, (db) =>
          viewRecord(
            recordsContext(context, {}, { db }),
            target,
            id,
            url.searchParams,
          ),
        ),
      );
    },
  },
  {
    method: "PATCH",
    pattern: record,
    joinsTransaction: true,
    async handler(context) {
      const [collection, id] = context.params as [string, string];
      const body = await readRecordBody(context.request);
      return replyOf(
        await writeRecord(context, {
          method: "PATCH",
          collection,
          id,
          body,
          query: parse(context).url.searchParams,
        }),
      );
    },
  },
  {
    method: "DELETE",
    pattern: record,
    joinsTransaction: true,
    async handler(context) {
      const [collection, id] = context.params as [string, string];
      return replyOf(
        await writeRecord(context, {
          method: "DELETE",
          collection,
          id,
          body: {},
          query: parse(context).url.searchParams,
        }),
      );
    },
  },
  {
    method: "POST",
    pattern: /^\/batch$/,
    joinsTransaction: true,
    async handler(context) {
      const writes = parseBatch(await readJsonObject(context.request));
      // Writes are planned before the transaction starts, then all run in it:
      // all or nothing. Planning stops at the first write that fails. The
      // writes before it still run, so the batch reports the first failing
      // write in order, as when each is checked and run in turn.
      const planned: PlannedWrite[] = [];
      let failed: unknown;
      const written = new Set<string>();
      for (const [i, write] of writes.entries()) {
        try {
          planned.push(
            await inBatch(i, () =>
              planRecordWrite(context, write, new Set(written)),
            ),
          );
        } catch (error) {
          failed = error;
          break;
        }
        // A delete can cascade into any collection that points at it.
        const names =
          write.method === "DELETE"
            ? context.schema.collections.map((c) => c.name)
            : [context.schema.get(write.collection).name];
        for (const name of names) written.add(name);
      }
      if (planned.length === 0) throw failed;
      const results = await bounded(context, async (tx) => {
        const replies: Reply[] = [];
        while (replies.length < planned.length) {
          const i = replies.length;
          const write = planned[i] as PlannedWrite;
          if ("apply" in write) {
            replies.push(await inBatch(i, () => write.apply(tx)));
            continue;
          }
          // Consecutive creates are done together, a run at a time.
          const creates: PlannedCreate[] = [];
          for (const next of planned.slice(i)) {
            if (!("create" in next)) break;
            creates.push(next.create);
          }
          for (const run of createRuns(creates)) {
            const start = replies.length;
            try {
              const records = await applyCreates(tx, run);
              replies.push(...records.map(replyWith));
            } catch (error) {
              if (!(error instanceof CreateFailed)) throw error;
              throw batchError(start + error.index, error.error);
            }
          }
        }
        if (failed !== undefined) throw failed;
        return replies;
      });
      return Response.json(results);
    },
  },
  {
    method: "POST",
    pattern: /^\/realtime$/,
    stream: true,
    async handler(context) {
      if (!context.realtime)
        throw new ApiError(404, "Realtime is not enabled.");
      return context.realtime.open(context);
    },
  },
  {
    method: "GET",
    pattern: /^\/setup$/,
    async handler({ db }) {
      return Response.json({ required: !(await hasSuperuser(db)) });
    },
  },
  {
    method: "POST",
    pattern: /^\/setup$/,
    async handler({ request, db, schema, principal }) {
      const record = await completeSetup(
        db,
        schema,
        await readJsonObject(request),
      );
      return Response.json(
        serializeRecord(schema.get("_superusers"), record, {
          ...principal,
          superuser: true,
        }),
      );
    },
  },
  {
    method: "GET",
    pattern: /^\/collections$/,
    async handler({ schema, principal }) {
      requireSuperuser(principal);
      const items = schema.collections;
      return Response.json({
        page: 1,
        perPage: items.length,
        totalItems: items.length,
        totalPages: 1,
        items,
      });
    },
  },
  {
    method: "POST",
    pattern: /^\/collections$/,
    async handler({ request, db, principal }) {
      requireSuperuser(principal);
      const input = await readJsonObject(request);
      return Response.json(await schemaChange(() => newCollection(db, input)));
    },
  },
  {
    method: "GET",
    pattern: new RegExp(`^/collections/${segment}$`),
    async handler({ params, schema, principal }) {
      requireSuperuser(principal);
      return Response.json(schema.get(params[0] as string));
    },
  },
  {
    method: "PATCH",
    pattern: new RegExp(`^/collections/${segment}$`),
    async handler({ request, params, db, principal, effects }) {
      requireSuperuser(principal);
      const input = await readJsonObject(request);
      return Response.json(
        await schemaChange(() =>
          updateCollection(
            db,
            params[0] as string,
            input,
            effects.obsoleteFiles,
          ),
        ),
      );
    },
  },
  {
    method: "DELETE",
    pattern: new RegExp(`^/collections/${segment}$`),
    async handler({ params, db, schema, principal, storage }) {
      requireSuperuser(principal);
      const { id } = schema.get(params[0] as string);
      await schemaChange(() => deleteCollection(db, params[0] as string));
      // A failure only leaves unused files behind.
      await storage.deletePrefix(`${id}/`).catch((error: unknown) => {
        console.error(
          "[nextbase] deleting a collection's files failed:",
          error,
        );
      });
      return new Response(null, { status: 204 });
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/collections/${segment}/upload-url$`),
    async handler({ request, params, db, schema, principal, storage }) {
      const collection = schema.get(params[0] as string);
      const input = await readJsonObject(request);
      return Response.json(
        await createUpload(db, storage, collection, principal, input),
      );
    },
  },
  {
    method: "POST",
    pattern: /^\/files\/token$/,
    async handler({ principal }) {
      if (!principal.record || !principal.collection) {
        throw new ApiError(401, "Sign in to get a file token.");
      }
      return Response.json({
        token: await fileToken(principal.collection, principal.record),
      });
    },
  },
  {
    method: "GET",
    pattern: new RegExp(`^/files/${segment}/${segment}/${segment}$`),
    async handler(context) {
      const { request, params, db, schema, storage } = context;
      const { collection, field, key } = await findFile(db, schema, params);
      const query = new URL(request.url).searchParams;
      if (field.protected) {
        // The view rule decides, for the session's caller or the file token's.
        const token = query.get("token");
        const principal = token
          ? ((await principalOfFileToken(db, schema, token)) ?? {
              superuser: false,
            })
          : context.principal;
        await viewRecord(
          recordsContext({ ...context, principal }, {}),
          collection,
          params[1] as string,
          new URLSearchParams(),
        );
      }
      const download = query.has("download") && query.get("download") !== "0";
      return fileResponse(storage, key, request, {
        download,
        protectedFile: field.protected,
      });
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/collections/${segment}/auth-with-password$`),
    async handler(context) {
      const { request, params, db, schema, inProcess, origins } = context;
      const collection = authCollection(schema, params[0] as string);
      const { identity, password, cookie } = await readJsonObject(request);
      if (typeof identity !== "string" || typeof password !== "string") {
        throw new ApiError(400, "Failed to authenticate.", {
          ...(typeof identity !== "string" && {
            identity: { code: "validation_required", message: "Required." },
          }),
          ...(typeof password !== "string" && {
            password: { code: "validation_required", message: "Required." },
          }),
        });
      }
      // Another site must not sign the browser in to an account of its choosing.
      if (cookie === true && !inProcess) checkSameOrigin(request, origins);
      const record = await authWithPassword(
        db,
        schema,
        collection,
        identity,
        password,
      );
      return startSession(context, collection, record, cookie === true);
    },
  },
  {
    method: "GET",
    pattern: new RegExp(`^/collections/${segment}/auth-methods$`),
    async handler({ params, schema, oauth2 }) {
      const collection = authCollection(schema, params[0] as string);
      const providers = collection.id === SUPERUSERS ? [] : oauth2.list();
      return Response.json({
        password: {
          enabled: collection.authRule !== null,
          identityFields: collection.identityFields,
        },
        oauth2: {
          enabled: collection.authRule !== null && providers.length > 0,
          providers,
        },
        phone: {
          enabled:
            collection.authRule !== null &&
            collection.phoneSignIn &&
            collection.id !== SUPERUSERS,
        },
      } satisfies AuthMethods);
    },
  },
  ...phoneFlow("request-phone-code", (ctx, collection, input) =>
    requestPhoneCode(ctx, collection, input.phone),
  ),
  ...phoneFlow("request-password-reset-by-phone", (ctx, collection, input) =>
    requestPasswordResetByPhone(ctx, collection, input.phone),
  ),
  ...phoneFlow("confirm-password-reset-by-phone", (ctx, collection, input) =>
    confirmPasswordResetByPhone(ctx, collection, input),
  ),
  ...phoneFlow(
    "request-phone-verification",
    (ctx, collection, input, principal) =>
      requestPhoneVerification(ctx, collection, principal, input.phone),
  ),
  ...phoneFlow(
    "confirm-phone-verification",
    (ctx, collection, input, principal) =>
      confirmPhoneVerification(ctx, collection, principal, input),
  ),
  {
    method: "POST",
    pattern: new RegExp(`^/collections/${segment}/auth-with-phone-code$`),
    async handler(context) {
      const { request, params, db, schema, inProcess, origins } = context;
      const collection = authCollection(schema, params[0] as string);
      const { phone, code, cookie } = await readJsonObject(request);
      // Another site must not sign the browser in to an account of its choosing.
      if (cookie === true && !inProcess) checkSameOrigin(request, origins);
      const record = await authWithPhoneCode(
        phoneContext(context),
        collection,
        phone,
        code,
      );
      await checkAuthRule(db, schema, collection, record.id as string);
      return startSession(context, collection, record, cookie === true);
    },
  },
  {
    method: "GET",
    pattern: new RegExp(
      `^/collections/${segment}/auth-with-oauth2/${segment}$`,
    ),
    async handler({ request, params, db, schema, principal, origins, oauth2 }) {
      const collection = authCollection(schema, params[0] as string);
      if (collection.id === SUPERUSERS) {
        throw new ApiError(400, "Superusers sign in with their password.");
      }
      const provider = oauth2.provider(params[1] as string);
      const query = new URL(request.url).searchParams;
      const redirect = checkRedirect(query.get("redirect"));
      const errorRedirect =
        checkRedirect(query.get("errorRedirect"), "errorRedirect") || redirect;
      let linkRecordId: string | null = null;
      if (query.get("link") === "true") {
        // Linking adds a way into the account, so only this site may start it.
        checkSameOrigin(request, origins);
        if (!principal.record || principal.collection?.id !== collection.id) {
          throw new ApiError(
            401,
            "Sign in to this collection to link a provider.",
          );
        }
        linkRecordId = principal.record.id as string;
      }
      const { location, state } = await oauth2.start(db, {
        collection,
        provider,
        redirect,
        errorRedirect,
        linkRecordId,
      });
      return new Response(null, {
        status: 302,
        headers: [
          ["location", location],
          ["set-cookie", setStateCookie(request, state)],
        ],
      });
    },
  },
  {
    method: "GET",
    pattern: new RegExp(`^/callback/${segment}$`),
    async handler(context) {
      const { request, params, db, schema, principal, mailer, oauth2 } =
        context;
      let redirect = "";
      let errorRedirect = "";
      const back = (error?: string): Response => {
        const to = error === undefined ? redirect : errorRedirect;
        const response = new Response(null, {
          status: 302,
          headers: [["location", oauth2.returnUrl(to, error)]],
        });
        response.headers.append("set-cookie", setStateCookie(request));
        return response;
      };
      try {
        const state = await oauth2.consumeState(db, request);
        ({ redirect, errorRedirect } = state);
        // Otherwise a malicious provider could pass off its response as
        // another provider's.
        if (params[0] !== state.provider) {
          throw new OAuth2Error(
            "oauth2_failed",
            "The sign-in returned from another provider.",
          );
        }
        const provider = oauth2.provider(state.provider);
        const collection = authCollection(schema, state.collectionId);
        // A link is for the record that started it, still signed in here.
        if (
          state.linkRecordId !== null &&
          principal.record?.id !== state.linkRecordId
        ) {
          throw new OAuth2Error(
            "oauth2_failed",
            "Sign in again to link this provider.",
          );
        }
        const identity = await oauth2.identify(provider, state, request);
        const { record, linkedTo } = await accountFor(
          { db, schema, effects: context.effects, hooks: context.hooks },
          collection,
          provider.name,
          identity,
          state.linkRecordId,
        );
        if (linkedTo !== undefined) {
          mailer.send("oauth2Linked", collection.name, linkedTo, {
            provider: provider.displayName,
          });
        }
        if (state.linkRecordId !== null) return back();
        try {
          await checkAuthRule(db, schema, collection, record.id as string);
        } catch (error) {
          if (error instanceof ApiError && error.status === 403) {
            throw new OAuth2Error("sign_in_forbidden", error.message);
          }
          throw error;
        }
        // As on any cookie sign-in, the session in the cookie is replaced.
        if (principal.viaCookie && principal.session) {
          await deleteSession(db, principal.session);
        }
        const { token, session } = await createSession(
          db,
          collection,
          record,
          request.headers.get("user-agent") ?? "",
        );
        const response = back();
        response.headers.append(
          "set-cookie",
          setSessionCookie(request, { token, expires: session.expires }),
        );
        return response;
      } catch (error) {
        if (error instanceof OAuth2Error) return back(error.code);
        console.error("[nextbase] an OAuth2 sign-in failed:", error);
        return back("oauth2_failed");
      }
    },
  },
  {
    method: "GET",
    pattern: linkedAccounts,
    async handler({ params, db, schema, principal }) {
      const { collection, id } = ownRecord(schema, principal, params);
      return Response.json({
        items: await listLinkedAccounts(db, collection.id, id),
      });
    },
  },
  {
    method: "DELETE",
    pattern: new RegExp(
      `^/collections/${segment}/records/${segment}/linked-accounts/${segment}$`,
    ),
    async handler({ params, db, schema, principal, mailer, oauth2 }) {
      const { collection, id } = ownRecord(schema, principal, params);
      const unlinked = await unlinkAccount(
        db,
        collection.id,
        id,
        params[2] as string,
      );
      if (!unlinked) throw new ApiError(404, "The provider is not linked.");
      const [owner] = await db
        .select("email")
        .from(table(collection.name))
        .where(hash({ id }))
        .all();
      if (owner) {
        mailer.send("oauth2Unlinked", collection.name, owner.email as string, {
          provider: oauth2.displayName(params[2] as string),
        });
      }
      return new Response(null, { status: 204 });
    },
  },
  ...flow("request-email-verification", (ctx, collection, input) =>
    requestEmailVerification(ctx, collection, input.email),
  ),
  ...flow("confirm-email-verification", (ctx, collection, input) =>
    confirmEmailVerification(ctx, collection, input.token),
  ),
  ...flow("request-password-reset", (ctx, collection, input) =>
    requestPasswordReset(ctx, collection, input.email),
  ),
  ...flow("confirm-password-reset", (ctx, collection, input) =>
    confirmPasswordReset(ctx, collection, input),
  ),
  ...flow("request-email-change", (ctx, collection, input, principal) =>
    requestEmailChange(ctx, collection, principal, input.newEmail),
  ),
  ...flow("confirm-email-change", (ctx, collection, input) =>
    confirmEmailChange(ctx, collection, input),
  ),
  {
    method: "POST",
    pattern: new RegExp(`^/collections/${segment}/sign-up$`),
    async handler(context) {
      const { request, params, db, schema, inProcess, origins } = context;
      const collection = authCollection(schema, params[0] as string);
      const { cookie, ...input } = await readRecordBody(request);
      if (cookie === true && !inProcess) checkSameOrigin(request, origins);
      // Chosen here so the record can be signed in even if the caller cannot view it.
      const id =
        typeof input.id === "string" && input.id !== "" ? input.id : newId();
      await writeRecord(context, {
        method: "POST",
        collection: collection.id,
        body: { ...input, id },
        query: new URLSearchParams(),
      });
      try {
        await checkAuthRule(db, schema, collection, id);
      } catch (error) {
        // Created but not allowed to sign in yet (e.g. unverified email).
        if (error instanceof ApiError && error.status === 403) {
          return new Response(null, { status: 202 });
        }
        throw error;
      }
      const [record] = await db
        .select()
        .from(table(collection.name))
        .where(hash({ id }))
        .all();
      return startSession(
        context,
        collection,
        record as Record<string, unknown>,
        cookie === true,
      );
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/collections/${segment}/auth-refresh$`),
    async handler(context) {
      const { request, params, schema, principal, db } = context;
      const collection = authCollection(schema, params[0] as string);
      const record = recordIn(principal, collection, "refresh");
      const { session } = principal;
      if (!session) {
        throw new ApiError(401, "Sign in to this collection to refresh.");
      }
      await checkAuthRule(db, schema, collection, record.id as string);
      const body = await authRecord(context, collection, record);
      const expires = await extendSession(db, collection, session.id);
      if (!principal.viaCookie) {
        return authResponse(body, bearerToken(request));
      }
      const response = authResponse(body, undefined);
      const token = sessionCookie(request);
      if (token) {
        response.headers.append(
          "set-cookie",
          setSessionCookie(request, { token, expires }),
        );
      }
      return response;
    },
  },
  {
    method: "GET",
    pattern: /^\/session$/,
    async handler({ principal }) {
      const { collection, record, session } = principal;
      if (!collection || !record || !session) return Response.json(null);
      return Response.json({
        ...sessionModel(session, true),
        record: serializeRecord(collection, record, principal),
      });
    },
  },
  {
    method: "DELETE",
    pattern: /^\/session$/,
    async handler({ request, db, principal }) {
      if (principal.session) await deleteSession(db, principal.session);
      const response = new Response(null, { status: 204 });
      // Removed even when the session was already gone.
      if (request.headers.has("cookie")) {
        response.headers.append("set-cookie", setSessionCookie(request));
      }
      return response;
    },
  },
  {
    method: "GET",
    pattern: /^\/sessions$/,
    async handler({ db, principal }) {
      const current = requireSession(principal);
      const items = await listSessions(
        db,
        current.collectionId,
        current.recordId,
      );
      return Response.json({
        items: items.map((s) => sessionModel(s, s.id === current.id)),
      });
    },
  },
  {
    method: "DELETE",
    pattern: /^\/sessions$/,
    async handler({ db, principal }) {
      await deleteOtherSessions(db, requireSession(principal));
      return new Response(null, { status: 204 });
    },
  },
  {
    method: "DELETE",
    pattern: new RegExp(`^/sessions/${segment}$`),
    async handler({ request, params, db, principal }) {
      const current = requireSession(principal);
      const id = params[0] as string;
      const deleted = await deleteSession(db, {
        id,
        collectionId: current.collectionId,
        recordId: current.recordId,
      });
      if (!deleted) throw new ApiError(404, "Session not found.");
      const response = new Response(null, { status: 204 });
      if (id === current.id && principal.viaCookie) {
        response.headers.append("set-cookie", setSessionCookie(request));
      }
      return response;
    },
  },
];

/**
 * Opens a route's transaction. Starting it, setting the timeout and reading
 * the schema version take one round trip together.
 */
export function beginRoute(db: DB, statementTimeout: number): Promise<Tx> {
  return db.begin(txOptions(statementTimeout, SCHEMA_VERSION_SQL));
}

/**
 * Runs records API work in a transaction limited by `statementTimeout`. It
 * uses the route's transaction if there is one, or opens a new one. The
 * timeout lasts only until the transaction ends, so it works through
 * transaction poolers.
 */
async function bounded<T>(
  context: Context,
  run: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (context.tx) return run(context.tx);
  const result = await context.db.transaction(
    run,
    txOptions(context.statementTimeout),
  );
  // What follows its writes is done even if the request fails after this,
  // as a sign-up may when it starts the session.
  context.effects.commit();
  return result;
}

function txOptions(statementTimeout: number, startQuery?: string): TxOptions {
  return {
    // With 0, the database's own timeout applies.
    ...(statementTimeout > 0 && { statementTimeout }),
    ...(startQuery !== undefined && { startQuery }),
  };
}

function parse({ request }: Context): { url: URL } {
  return { url: new URL(request.url) };
}

/**
 * The `@request.*` values rules may read. Reads made while a write is planned
 * use the transaction of the hook that sent the request, if any, so they see
 * what it wrote.
 */
function recordsContext(
  context: Context,
  body: Record<string, unknown>,
  {
    db = context.tx ?? context.db,
    method = context.request.method,
    query,
  }: {
    db?: DB | Tx;
    method?: string;
    query?: URLSearchParams;
  } = {},
): RecordsContext {
  const { request, schema, principal } = context;
  return {
    db,
    pool: context.db,
    schema,
    principal,
    rejectBreachedPasswords: context.rejectBreachedPasswords,
    effects: context.effects,
    storage: context.storage,
    hooks: context.hooks,
    hookChain: context.hookChain,
    request: {
      method,
      query: Object.fromEntries(query ?? new URL(request.url).searchParams),
      headers: Object.fromEntries(request.headers),
      body,
    },
  };
}

interface Reply {
  status: number;
  body?: unknown;
}

function replyOf({ status, body }: Reply): Response {
  return body === undefined
    ? new Response(null, { status })
    : Response.json(body, { status });
}

interface RecordWrite {
  method: "POST" | "PATCH" | "DELETE";
  collection: string;
  id?: string;
  body: Record<string, unknown>;
  query: URLSearchParams;
}

/** Plans the write, then runs it in its own transaction. */
async function writeRecord(
  context: Context,
  write: RecordWrite,
): Promise<Reply> {
  const planned = await planRecordWrite(context, write);
  if ("apply" in planned) return bounded(context, planned.apply);
  const apply = applyCreate(planned.create);
  return bounded(context, async (tx) => replyWith(await apply(tx)));
}

/**
 * A write checked as far as it can be before its transaction starts. A batch
 * does consecutive creates together, so they stay planned creates; other
 * writes come with the rest of their work.
 */
type PlannedWrite = { create: PlannedCreate } | { apply: Apply<Reply> };

/** Plans a write; see `PlannedWrite`. */
async function planRecordWrite(
  context: Context,
  write: RecordWrite,
  written?: ReadonlySet<string>,
): Promise<PlannedWrite> {
  const collection = context.schema.get(write.collection);
  const ctx = {
    ...recordsContext(context, write.body, {
      method: write.method,
      query: write.query,
    }),
    ...(written && { written }),
  };
  if (write.method === "POST") {
    return {
      create: await planNewRecord(ctx, collection, write.body, write.query),
    };
  }
  if (write.method === "DELETE") {
    const apply = await planDeleteRecord(ctx, collection, write.id as string);
    return {
      apply: async (tx) => {
        await apply(tx);
        return { status: 204 };
      },
    };
  }
  const apply = await planUpdateRecord(
    ctx,
    collection,
    write.id as string,
    write.body,
    write.query,
  );
  return { apply: async (tx) => replyWith(await apply(tx)) };
}

/** 204 when the caller may not view the record. */
function replyWith(record: Record<string, unknown> | undefined): Reply {
  return record ? { status: 200, body: record } : { status: 204 };
}

/** Reports which write of a batch failed, and that nothing was saved. */
async function inBatch<T>(i: number, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw batchError(i, error);
  }
}

function batchError(i: number, error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  return new ApiError(
    400,
    `Request ${i + 1} of the batch failed with ${error.status}: ${error.message} Nothing was saved.`,
    { requests: { [i]: error.data } },
  );
}

const MAX_BATCH = 50;

// `{ requests: [{ method, url, body }] }`, each url a records path below the base path.
function parseBatch(input: Record<string, unknown>): RecordWrite[] {
  const { requests } = input;
  if (
    !Array.isArray(requests) ||
    requests.length === 0 ||
    requests.length > MAX_BATCH
  ) {
    throw new ApiError(400, "The batch is invalid.", {
      requests: {
        code: "validation_invalid",
        message: `Must be a list of 1 to ${MAX_BATCH} requests.`,
      },
    });
  }
  return requests.map((request: unknown, i): RecordWrite => {
    const invalid = (message: string): ApiError =>
      new ApiError(400, "The batch is invalid.", {
        requests: { [i]: { code: "validation_invalid", message } },
      });
    if (
      request === null ||
      typeof request !== "object" ||
      Array.isArray(request)
    )
      throw invalid("Must be an object.");
    const { method, url, body = {} } = request as Record<string, unknown>;
    if (method !== "POST" && method !== "PATCH" && method !== "DELETE")
      throw invalid("method must be POST, PATCH or DELETE.");
    if (typeof url !== "string" || !url.startsWith("/"))
      throw invalid(
        "url must be a records path such as /collections/posts/records.",
      );
    if (body === null || typeof body !== "object" || Array.isArray(body))
      throw invalid("body must be an object.");
    const parsed = new URL(url, "http://batch.invalid");
    const match = (method === "POST" ? records : record).exec(parsed.pathname);
    if (!match) {
      throw invalid(
        method === "POST"
          ? "POST creates records: /collections/{collection}/records."
          : `${method} needs a record: /collections/{collection}/records/{id}.`,
      );
    }
    const [collection, id] = match
      .slice(1)
      .map((p) => decodeURIComponent(p)) as [string, string | undefined];
    return {
      method,
      collection,
      ...(id !== undefined && { id }),
      body: body as Record<string, unknown>,
      query: parsed.searchParams,
    };
  });
}

// Always 204, so it does not reveal which accounts exist.
function flow(
  name: string,
  run: (
    ctx: FlowContext,
    collection: AuthCollection,
    input: Record<string, unknown>,
    principal: Principal,
  ) => Promise<void>,
): Route[] {
  return [
    {
      method: "POST",
      pattern: new RegExp(`^/collections/${segment}/${name}$`),
      async handler(context) {
        const { request, params, db, schema, principal, mailer } = context;
        const collection = authCollection(schema, params[0] as string);
        const input = await readJsonObject(request);
        const { rejectBreachedPasswords, effects, hooks } = context;
        await run(
          { db, schema, mailer, rejectBreachedPasswords, effects, hooks },
          collection,
          input,
          principal,
        );
        return new Response(null, { status: 204 });
      },
    },
  ];
}

// Always 204, so it does not reveal which phones have accounts.
function phoneFlow(
  name: string,
  run: (
    ctx: PhoneContext,
    collection: AuthCollection,
    input: Record<string, unknown>,
    principal: Principal,
  ) => Promise<void>,
): Route[] {
  return [
    {
      method: "POST",
      pattern: new RegExp(`^/collections/${segment}/${name}$`),
      async handler(context) {
        const { request, params, schema, principal } = context;
        const collection = authCollection(schema, params[0] as string);
        const input = await readJsonObject(request);
        await run(phoneContext(context), collection, input, principal);
        return new Response(null, { status: 204 });
      },
    },
  ];
}

function phoneContext({
  db,
  schema,
  sms,
  mailer,
  rejectBreachedPasswords,
  effects,
  hooks,
}: Context): PhoneContext {
  return { db, schema, sms, mailer, rejectBreachedPasswords, effects, hooks };
}

/**
 * Answers with the token in the body, or with `cookie` in an HttpOnly cookie.
 * A cookie sign-in ends the replaced cookie's session, so a planted session never signs in.
 */
async function startSession(
  context: Context,
  collection: AuthCollection,
  record: Record<string, unknown>,
  cookie: boolean,
): Promise<Response> {
  const { request, db, principal } = context;
  // Before the session starts, so a refused `expand` or `fields` starts none.
  const body = await authRecord(context, collection, record);
  if (cookie && principal.viaCookie && principal.session) {
    await deleteSession(db, principal.session);
  }
  const { token, session } = await createSession(
    db,
    collection,
    record,
    request.headers.get("user-agent") ?? "",
  );
  const response = authResponse(body, cookie ? undefined : token);
  if (cookie) {
    response.headers.append(
      "set-cookie",
      setSessionCookie(request, { token, expires: session.expires }),
    );
  }
  return response;
}

/**
 * The record of an auth response, with the query's `expand` and `fields`.
 * Rules see the account it signs in, as on its next request.
 */
function authRecord(
  context: Context,
  collection: AuthCollection,
  record: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const principal: Principal = {
    collection,
    record,
    superuser: collection.id === SUPERUSERS,
  };
  return outputRecord(
    recordsContext({ ...context, principal }, {}),
    collection,
    record,
    new URL(context.request.url).searchParams,
  );
}

function authResponse(
  record: Record<string, unknown>,
  token: string | undefined,
): Response {
  return Response.json({ ...(token !== undefined && { token }), record });
}

function requireSession(principal: Principal): Session {
  if (!principal.session)
    throw new ApiError(401, "Sign in to manage sessions.");
  return principal.session;
}

// Only the record itself and superusers; anyone else gets 404 so nothing leaks.
function ownRecord(
  schema: Schema,
  principal: Principal,
  params: string[],
): { collection: AuthCollection; id: string } {
  const collection = authCollection(schema, params[0] as string);
  const id = params[1] as string;
  if (!principal.superuser && !principal.record) {
    throw new ApiError(401, "Sign in to manage linked accounts.");
  }
  const own =
    principal.collection?.id === collection.id && principal.record?.id === id;
  if (!principal.superuser && !own) {
    throw new ApiError(404, "Record not found.");
  }
  return { collection, id };
}

function authCollection(schema: Schema, idOrName: string): AuthCollection {
  const collection: Collection = schema.get(idOrName);
  if (collection.type !== "auth")
    throw new ApiError(404, "Collection not found.");
  return collection;
}

// Data that blocks the DDL (e.g. duplicates under a new unique index) is a 400, not a 500.
async function schemaChange<T>(change: () => Promise<T>): Promise<T> {
  try {
    return await change();
  } catch (error) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    // Class 23: integrity constraint violations.
    if (typeof code === "string" && code.startsWith("23")) {
      throw new ApiError(
        400,
        `The change conflicts with existing records: ${String(message)}`,
      );
    }
    // A view reads what the change would drop or retype.
    if (
      code === "2BP01" ||
      (code === "0A000" && /\bview\b/.test(String(message)))
    ) {
      throw new ApiError(
        400,
        `A view depends on what this change removes: ${String(message)}. Update or delete that view first.`,
      );
    }
    throw error;
  }
}
