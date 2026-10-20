import type {
  AuthCollection,
  AuthMethods,
  Collection,
} from "@nextbasejs/client";
import { type DB, hash, type Tx } from "@nextbasejs/dbx";
import {
  accountFor,
  listExternalAuths,
  unlinkExternalAuth,
} from "../auth/external-auths.ts";
import {
  confirmEmailChange,
  confirmPasswordReset,
  confirmVerification,
  type FlowContext,
  requestEmailChange,
  requestPasswordReset,
  requestVerification,
} from "../auth/flows.ts";
import { authWithPassword, checkAuthRule } from "../auth/login.ts";
import type { Mailer } from "../auth/mail.ts";
import {
  checkRedirect,
  type OAuth2,
  OAuth2Error,
  setStateCookie,
} from "../auth/oauth2.ts";
import { type Principal, requireSuperuser } from "../auth/principal.ts";
import {
  bearerToken,
  checkSameOrigin,
  createSession,
  deleteSession,
  extendSession,
  listSessions,
  type OriginPolicy,
  type Session,
  sessionCookie,
  sessionModel,
  setSessionCookie,
} from "../auth/sessions.ts";
import { completeSetup, hasSuperuser } from "../auth/superusers.ts";
import { table } from "../db/system.ts";
import { ApiError } from "../errors.ts";
import { readJsonObject } from "../http.ts";
import { LOWER_ALPHANUMERIC, randomString } from "../random.ts";
import { serializeRecord } from "../records/serialize.ts";
import {
  deleteRecord,
  listRecords,
  newRecord,
  type RecordsContext,
  updateRecord,
  viewRecord,
} from "../records/service.ts";
import type { Schema } from "../schema/cache.ts";
import {
  deleteCollection,
  newCollection,
  updateCollection,
} from "../schema/sync.ts";

interface Context {
  request: Request;
  /** Decoded path parameters, in order. */
  params: string[];
  db: DB;
  schema: Schema;
  principal: Principal;
  /** Sent by server code through `client()`, not by a browser. */
  inProcess: boolean;
  /** Milliseconds a records API statement may run, or 0 for no limit. */
  statementTimeout: number;
  /** Which other sites may write through the session cookie. */
  origins: OriginPolicy;
  mailer: Mailer;
  oauth2: OAuth2;
  /** Reject new passwords found in data breaches. */
  breachedPasswords: boolean;
}

interface Route {
  method: string;
  /** Matched against the path below `basePath`; groups become `params`. */
  pattern: RegExp;
  handler(context: Context): Promise<Response>;
}

const segment = "([^/]+)";
const SUPERUSERS = "_superusers";

const records = new RegExp(`^/collections/${segment}/records$`);
const record = new RegExp(`^/collections/${segment}/records/${segment}$`);
const externalAuths = new RegExp(
  `^/collections/${segment}/records/${segment}/external-auths$`,
);

export const ROUTES: readonly Route[] = [
  {
    method: "GET",
    pattern: records,
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
    async handler(context) {
      const body = await readJsonObject(context.request);
      return replyOf(
        await bounded(context, (db) =>
          writeRecord(context, db, {
            method: "POST",
            collection: context.params[0] as string,
            body,
            query: parse(context).url.searchParams,
          }),
        ),
      );
    },
  },
  {
    method: "GET",
    pattern: record,
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
    async handler(context) {
      const [collection, id] = context.params as [string, string];
      const body = await readJsonObject(context.request);
      return replyOf(
        await bounded(context, (db) =>
          writeRecord(context, db, {
            method: "PATCH",
            collection,
            id,
            body,
            query: parse(context).url.searchParams,
          }),
        ),
      );
    },
  },
  {
    method: "DELETE",
    pattern: record,
    async handler(context) {
      const [collection, id] = context.params as [string, string];
      return replyOf(
        await bounded(context, (db) =>
          writeRecord(context, db, {
            method: "DELETE",
            collection,
            id,
            body: {},
            query: parse(context).url.searchParams,
          }),
        ),
      );
    },
  },
  {
    method: "POST",
    pattern: /^\/batch$/,
    async handler(context) {
      const writes = parseBatch(await readJsonObject(context.request));
      // One transaction: every write is saved, or none is.
      const results = await bounded(context, async (tx) => {
        const replies: Reply[] = [];
        for (const [i, write] of writes.entries()) {
          try {
            replies.push(await writeRecord(context, tx, write));
          } catch (error) {
            if (!(error instanceof ApiError)) throw error;
            throw new ApiError(
              400,
              `Request ${i + 1} of the batch failed with ${error.status}: ${error.message} Nothing was saved.`,
              { requests: { [i]: error.data } },
            );
          }
        }
        return replies;
      });
      return Response.json(results);
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
    async handler({ request, params, db, principal }) {
      requireSuperuser(principal);
      const input = await readJsonObject(request);
      return Response.json(
        await schemaChange(() =>
          updateCollection(db, params[0] as string, input),
        ),
      );
    },
  },
  {
    method: "DELETE",
    pattern: new RegExp(`^/collections/${segment}$`),
    async handler({ params, db, principal }) {
      requireSuperuser(principal);
      await schemaChange(() => deleteCollection(db, params[0] as string));
      return new Response(null, { status: 204 });
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/collections/${segment}/auth-with-password$`),
    async handler({
      request,
      params,
      db,
      schema,
      principal,
      inProcess,
      origins,
    }) {
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
      return startSession(
        { request, db, principal },
        collection,
        record,
        cookie === true,
      );
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
      } satisfies AuthMethods);
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
        // Linking adds a way into the signed-in account, so only this site
        // may start it.
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
    pattern: /^\/oauth2-callback$/,
    async handler(context) {
      const { request, db, schema, principal, mailer, oauth2 } = context;
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
          { db, schema },
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
    pattern: externalAuths,
    async handler({ params, db, schema, principal }) {
      const { collection, id } = ownRecord(schema, principal, params);
      return Response.json({
        items: await listExternalAuths(db, collection.id, id),
      });
    },
  },
  {
    method: "DELETE",
    pattern: new RegExp(
      `^/collections/${segment}/records/${segment}/external-auths/${segment}$`,
    ),
    async handler({ params, db, schema, principal }) {
      const { collection, id } = ownRecord(schema, principal, params);
      const unlinked = await unlinkExternalAuth(
        db,
        collection.id,
        id,
        params[2] as string,
      );
      if (!unlinked) throw new ApiError(404, "The provider is not linked.");
      return new Response(null, { status: 204 });
    },
  },
  ...flow("request-verification", (ctx, collection, input) =>
    requestVerification(ctx, collection, input.email),
  ),
  ...flow("confirm-verification", (ctx, collection, input) =>
    confirmVerification(ctx, collection, input.token),
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
      const { cookie, ...input } = await readJsonObject(request);
      if (cookie === true && !inProcess) checkSameOrigin(request, origins);
      // Chosen here, so the new record can be signed in even when the
      // caller may not view it.
      const id =
        typeof input.id === "string" && input.id !== ""
          ? input.id
          : randomString(15, LOWER_ALPHANUMERIC);
      await bounded(context, (tx) =>
        writeRecord(context, tx, {
          method: "POST",
          collection: collection.id,
          body: { ...input, id },
          query: new URLSearchParams(),
        }),
      );
      try {
        await checkAuthRule(db, schema, collection, id);
      } catch (error) {
        // Created, but the collection does not let it sign in yet, such as
        // before verifying its email: 202, accepted but not complete.
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
    async handler({ request, params, schema, principal, db }) {
      const collection = authCollection(schema, params[0] as string);
      const { record, session } = principal;
      if (!record || !session || principal.collection?.id !== collection.id) {
        throw new ApiError(401, "Sign in to this collection to refresh.");
      }
      await checkAuthRule(db, schema, collection, record.id as string);
      const expires = await extendSession(db, collection, session.id);
      if (!principal.viaCookie) {
        return authResponse(collection, record, bearerToken(request));
      }
      const response = authResponse(collection, record, undefined);
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
 * Runs records API work in one transaction whose statements Postgres stops
 * after `statementTimeout`, so an expensive filter cannot run unbounded.
 * Set with set_config(..., true), which is SET LOCAL: transaction-scoped, so
 * it works through transaction poolers, unlike a session or startup setting.
 * Writes nest inside as savepoints.
 */
function bounded<T>(context: Context, run: (tx: Tx) => Promise<T>): Promise<T> {
  return context.db.transaction(async (tx) => {
    if (context.statementTimeout > 0) {
      await tx
        .newQuery("SELECT set_config('statement_timeout', {:ms}, true)")
        .bind({ ms: String(context.statementTimeout) })
        .execute();
    }
    return run(tx);
  });
}

function parse({ request }: Context): { url: URL } {
  return { url: new URL(request.url) };
}

/** What rules may read about the request: `@request.method`, `.query`, `.headers` and `.body`. */
function recordsContext(
  context: Context,
  body: Record<string, unknown>,
  {
    db = context.db,
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
    breachedPasswords: context.breachedPasswords,
    request: {
      method,
      query: Object.fromEntries(query ?? new URL(request.url).searchParams),
      headers: Object.fromEntries(request.headers),
      body,
    },
  };
}

/** A status and JSON body: one write's outcome, alone or in a batch. */
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

/** Creates, updates or deletes a record. 204 when the caller may not view the result. */
async function writeRecord(
  context: Context,
  db: DB | Tx,
  write: RecordWrite,
): Promise<Reply> {
  const collection = context.schema.get(write.collection);
  const ctx = recordsContext(context, write.body, {
    db,
    method: write.method,
    query: write.query,
  });
  let result: Record<string, unknown> | undefined;
  if (write.method === "POST") {
    result = await newRecord(ctx, collection, write.body, write.query);
  } else if (write.method === "PATCH") {
    result = await updateRecord(
      ctx,
      collection,
      write.id as string,
      write.body,
      write.query,
    );
  } else {
    await deleteRecord(ctx, collection, write.id as string);
  }
  return result ? { status: 200, body: result } : { status: 204 };
}

const MAX_BATCH = 50;

/**
 * Validates a batch: `{ requests: [{ method, url, body }] }`, where each url
 * is a records path below the base path, such as `/collections/posts/records`,
 * optionally with `expand` and `fields`.
 */
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

/**
 * A POST route for an email flow on an auth collection, answering 204: the
 * same for accounts that exist and ones that do not.
 */
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
        const { breachedPasswords } = context;
        await run(
          { db, schema, mailer, breachedPasswords },
          collection,
          input,
          principal,
        );
        return new Response(null, { status: 204 });
      },
    },
  ];
}

/**
 * Starts a session for `record` and answers with it: the token in the body,
 * or with `cookie` in an HttpOnly cookie. A cookie sign-in ends the session
 * in the cookie it replaces (OWASP: regenerate the session when the
 * authenticated user changes).
 */
async function startSession(
  { request, db, principal }: Pick<Context, "request" | "db" | "principal">,
  collection: AuthCollection,
  record: Record<string, unknown>,
  cookie: boolean,
): Promise<Response> {
  if (cookie && principal.viaCookie && principal.session) {
    await deleteSession(db, principal.session);
  }
  const { token, session } = await createSession(
    db,
    collection,
    record,
    request.headers.get("user-agent") ?? "",
  );
  const response = authResponse(collection, record, cookie ? undefined : token);
  if (cookie) {
    response.headers.append(
      "set-cookie",
      setSessionCookie(request, { token, expires: session.expires }),
    );
  }
  return response;
}

function authResponse(
  collection: AuthCollection,
  record: Record<string, unknown>,
  token: string | undefined,
): Response {
  const principal: Principal = {
    collection,
    record,
    superuser: collection.id === "_superusers",
  };
  return Response.json({
    ...(token !== undefined && { token }),
    record: serializeRecord(collection, record, principal),
  });
}

/** The caller's session; session endpoints need a signed-in caller. */
function requireSession(principal: Principal): Session {
  if (!principal.session)
    throw new ApiError(401, "Sign in to manage sessions.");
  return principal.session;
}

/**
 * The auth record of a path, which only the record itself and superusers
 * may manage. Anyone else gets 404, so it reveals no records.
 */
function ownRecord(
  schema: Schema,
  principal: Principal,
  params: string[],
): { collection: AuthCollection; id: string } {
  const collection = authCollection(schema, params[0] as string);
  const id = params[1] as string;
  if (!principal.superuser && !principal.record) {
    throw new ApiError(401, "Sign in to manage linked providers.");
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

/**
 * Runs a schema change, reporting data that blocks its DDL (for example a
 * new unique index over duplicate values) as a 400 rather than a server error.
 */
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
