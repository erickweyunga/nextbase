import type { AuthCollection } from "@nextbasejs/client";
import type { DB, Row } from "@nextbasejs/dbx";
import { ApiError } from "../errors.ts";
import type { Schema, SchemaCache } from "../schema/cache.ts";
import {
  bearerToken,
  findSession,
  type Session,
  sessionCookie,
  setSessionCookie,
} from "./sessions.ts";

export interface Principal {
  collection?: AuthCollection;
  record?: Row;
  session?: Session;
  viaCookie?: boolean;
  /** Superusers bypass every rule. */
  superuser: boolean;
}

export interface Resolved {
  principal: Principal;
  /** The current schema, checked during the session lookup. */
  schema: Schema;
  /** A renewed or removed session cookie the response must carry. */
  setCookie?: string;
}

const ANONYMOUS: Principal = { superuser: false };

const SUPERUSERS = "_superusers";

/**
 * An invalid Bearer token is a 401 so API clients notice; an invalid cookie is
 * cleared and the request continues anonymously so public pages never break.
 * Pass `extend` only when the response can also renew the cookie.
 */
export async function resolvePrincipal(
  request: Request,
  db: DB,
  schemas: SchemaCache,
  { extend }: { extend: boolean },
): Promise<Resolved> {
  const bearer = bearerToken(request);
  const cookie = bearer === undefined ? sessionCookie(request) : undefined;
  const token = bearer ?? cookie;
  const { schema, active } = token
    ? await findSession(db, schemas, token, { extend })
    : { schema: await schemas.get(db), active: undefined };
  if (token === undefined) return { principal: ANONYMOUS, schema };
  if (!active) {
    if (cookie === undefined) {
      throw new ApiError(
        401,
        "The authorization token is invalid or has expired.",
      );
    }
    return {
      principal: ANONYMOUS,
      schema,
      setCookie: setSessionCookie(request),
    };
  }
  const { session, collection, record, extended } = active;
  return {
    schema,
    principal: {
      collection,
      record,
      session,
      viaCookie: cookie !== undefined,
      superuser: collection.id === SUPERUSERS,
    },
    ...(cookie !== undefined &&
      extended && {
        setCookie: setSessionCookie(request, {
          token: cookie,
          expires: session.expires,
        }),
      }),
  };
}

export function requireSuperuser(principal: Principal): void {
  if (principal.superuser) return;
  if (!principal.record)
    throw new ApiError(401, "Sign in as a superuser to do this.");
  throw new ApiError(403, "Only superusers can do this.");
}
