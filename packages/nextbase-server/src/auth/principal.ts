import type { AuthCollection } from "@nextbase/client";
import type { DB, Row } from "@nextbase/dbx";
import { ApiError } from "../errors.ts";
import type { Schema } from "../schema/cache.ts";
import {
  bearerToken,
  findSession,
  type Session,
  sessionCookie,
  setSessionCookie,
} from "./sessions.ts";

/** Who is making a request. */
export interface Principal {
  /** The auth collection of the authenticated record. */
  collection?: AuthCollection;
  /** The authenticated record's row. */
  record?: Row;
  /** The session the request authenticated with. */
  session?: Session;
  /** Whether the session came from the cookie rather than a Bearer header. */
  viaCookie?: boolean;
  /** Whether the record is a superuser, who bypasses every rule. */
  superuser: boolean;
}

export interface Resolved {
  principal: Principal;
  /** A `Set-Cookie` header the response must carry: a renewed or removed cookie. */
  setCookie?: string;
}

const ANONYMOUS: Principal = { superuser: false };

const SUPERUSERS = "_superusers";

/**
 * Resolves the caller from an `Authorization: Bearer <token>` header, or else
 * the session cookie. An invalid Bearer token is a 401, so API clients notice
 * instead of silently getting anonymous results. An invalid cookie is
 * removed and the request continues anonymously, so a revoked session never
 * breaks public pages. `extend` renews sessions due for it; only requests whose
 * response can renew the cookie too should.
 */
export async function resolvePrincipal(
  request: Request,
  db: DB,
  schema: Schema,
  { extend }: { extend: boolean },
): Promise<Resolved> {
  const bearer = bearerToken(request);
  const cookie = bearer === undefined ? sessionCookie(request) : undefined;
  const token = bearer ?? cookie;
  if (token === undefined) return { principal: ANONYMOUS };

  const active =
    token === "" ? undefined : await findSession(db, schema, token, { extend });
  if (!active) {
    if (cookie === undefined) {
      throw new ApiError(
        401,
        "The authorization token is invalid or has expired.",
      );
    }
    return {
      principal: ANONYMOUS,
      setCookie: setSessionCookie(request),
    };
  }
  const { session, collection, record, extended } = active;
  return {
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

/** Throws 401 for anonymous callers and 403 for authenticated non-superusers. */
export function requireSuperuser(principal: Principal): void {
  if (principal.superuser) return;
  if (!principal.record)
    throw new ApiError(401, "Sign in as a superuser to do this.");
  throw new ApiError(403, "Only superusers can do this.");
}
