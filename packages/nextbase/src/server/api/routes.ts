import type { DB } from "@nextbase/dbx";
import type { AuthCollection, Collection } from "../../shared/schema.ts";
import { authWithPassword, checkAuthRule } from "../auth/login.ts";
import {
  authToken,
  type Principal,
  requireSuperuser,
} from "../auth/principal.ts";
import { completeSetup, hasSuperuser } from "../auth/superusers.ts";
import { peekToken } from "../auth/tokens.ts";
import { ApiError } from "../errors.ts";
import { readJsonObject } from "../http.ts";
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
}

interface Route {
  method: string;
  /** Matched against the path below `basePath`; groups become `params`. */
  pattern: RegExp;
  handler(context: Context): Promise<Response>;
}

const segment = "([^/]+)";

const records = new RegExp(`^/collections/${segment}/records$`);
const record = new RegExp(`^/collections/${segment}/records/${segment}$`);

export const ROUTES: readonly Route[] = [
  {
    method: "GET",
    pattern: records,
    async handler(context) {
      const { url } = parse(context);
      return Response.json(
        await listRecords(
          recordsContext(context, {}),
          context.schema.get(context.params[0] as string),
          url.searchParams,
        ),
      );
    },
  },
  {
    method: "POST",
    pattern: records,
    async handler(context) {
      const input = await readJsonObject(context.request);
      const { url } = parse(context);
      const created = await newRecord(
        recordsContext(context, input),
        context.schema.get(context.params[0] as string),
        input,
        url.searchParams,
      );
      return created
        ? Response.json(created)
        : new Response(null, { status: 204 });
    },
  },
  {
    method: "GET",
    pattern: record,
    async handler(context) {
      const { url } = parse(context);
      const [collection, id] = context.params as [string, string];
      return Response.json(
        await viewRecord(
          recordsContext(context, {}),
          context.schema.get(collection),
          id,
          url.searchParams,
        ),
      );
    },
  },
  {
    method: "PATCH",
    pattern: record,
    async handler(context) {
      const input = await readJsonObject(context.request);
      const { url } = parse(context);
      const [collection, id] = context.params as [string, string];
      const updated = await updateRecord(
        recordsContext(context, input),
        context.schema.get(collection),
        id,
        input,
        url.searchParams,
      );
      return updated
        ? Response.json(updated)
        : new Response(null, { status: 204 });
    },
  },
  {
    method: "DELETE",
    pattern: record,
    async handler(context) {
      const [collection, id] = context.params as [string, string];
      await deleteRecord(
        recordsContext(context, {}),
        context.schema.get(collection),
        id,
      );
      return new Response(null, { status: 204 });
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
    async handler({ request, params, db, schema }) {
      const collection = authCollection(schema, params[0] as string);
      const { identity, password } = await readJsonObject(request);
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
      const record = await authWithPassword(
        db,
        schema,
        collection,
        identity,
        password,
      );
      return authResponse(collection, record);
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/collections/${segment}/auth-refresh$`),
    async handler({ request, params, schema, principal, db }) {
      const collection = authCollection(schema, params[0] as string);
      const claims = peekToken(
        request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "",
      );
      if (
        !principal.record ||
        principal.collection?.id !== collection.id ||
        claims?.refreshable !== true
      ) {
        throw new ApiError(
          401,
          "Sign in to this collection to refresh the token.",
        );
      }
      await checkAuthRule(
        db,
        schema,
        collection,
        principal.record.id as string,
      );
      return authResponse(collection, principal.record);
    },
  },
];

function parse({ request }: Context): { url: URL } {
  return { url: new URL(request.url) };
}

/** What rules may read about the request: `@request.method`, `.query`, `.headers` and `.body`. */
function recordsContext(
  context: Context,
  body: Record<string, unknown>,
): RecordsContext {
  const { request, db, schema, principal } = context;
  const url = new URL(request.url);
  return {
    db,
    schema,
    principal,
    request: {
      method: request.method,
      query: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries(request.headers),
      body,
    },
  };
}

async function authResponse(
  collection: AuthCollection,
  record: Record<string, unknown>,
): Promise<Response> {
  const principal: Principal = {
    collection,
    record,
    superuser: collection.id === "_superusers",
  };
  return Response.json({
    token: await authToken(collection, record),
    record: serializeRecord(collection, record, principal),
  });
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
    throw error;
  }
}
