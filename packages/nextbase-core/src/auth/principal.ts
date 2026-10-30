import type { AuthCollection } from '@nextbasejs/client';
import type { DB, Row } from '@nextbasejs/dbx';
import { ApiError } from '../errors.ts';
import type { Schema, SchemaCache } from '../schema/cache.ts';
import {
  bearerToken,
  findSession,
  type Session,
  sessionCookie,
  setSessionCookie,
} from './sessions.ts';

export interface Principal {
  collection?: AuthCollection;
  record?: Row;
  session?: Session;
  viaCookie?: boolean;
  /** Superusers bypass every rule. */
  superuser: boolean;
  /**
   * The id of the superuser acting as `record`, on an impersonation
   * session. See `forbidImpersonated` for what such a session cannot do.
   */
  impersonatedBy?: string;
}

export interface Resolved {
  principal: Principal;
  /**
   * The current schema, read in the same query as the session. Not set when
   * the request has no token.
   */
  schema?: Schema;
  /** A renewed or removed session cookie the response must carry. */
  setCookie?: string;
}

const ANONYMOUS: Principal = { superuser: false };

const SUPERUSERS = '_superusers';

/**
 * An invalid Bearer token is a 401 so API clients notice; an invalid cookie is
 * cleared and the request continues anonymously so public pages never break.
 * Pass `extend` only when the response can also renew the cookie. With
 * `writeCookie`, cookie changes are written through it instead of returned,
 * and a cookie session is extended only once its renewed cookie is written.
 * It returns false when it cannot write, as in a Next.js server component:
 * a session extended past its cookie would end early all the same.
 */
export async function resolvePrincipal(
  request: Request,
  db: DB,
  schemas: SchemaCache,
  {
    extend,
    writeCookie,
  }: {
    extend: boolean;
    writeCookie?: ((header: string) => boolean) | undefined;
  },
): Promise<Resolved> {
  const bearer = bearerToken(request);
  const cookie = bearer === undefined ? sessionCookie(request) : undefined;
  const token = bearer ?? cookie;
  if (token === undefined) return { principal: ANONYMOUS };
  const { schema, active } = await findSession(db, schemas, token, {
    extend:
      cookie !== undefined && writeCookie
        ? (expires) =>
            writeCookie(setSessionCookie(request, { token: cookie, expires }))
        : extend,
  });
  if (!active) {
    if (cookie === undefined) {
      throw new ApiError(
        401,
        'The authorization token is invalid or has expired.',
      );
    }
    const cleared = setSessionCookie(request);
    if (!writeCookie)
      return { principal: ANONYMOUS, schema, setCookie: cleared };
    writeCookie(cleared);
    return { principal: ANONYMOUS, schema };
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
      ...(session.impersonatedBy !== null && {
        impersonatedBy: session.impersonatedBy,
      }),
    },
    ...(cookie !== undefined &&
      extended &&
      !writeCookie && {
        setCookie: setSessionCookie(request, {
          token: cookie,
          expires: session.expires,
        }),
      }),
  };
}

/**
 * The caller's record in `collection`. A 401 when signed out, which clients
 * read as an ended session, and a 403 when signed in to another collection.
 */
export function recordIn(
  principal: Principal,
  collection: AuthCollection,
  action: string,
): Row {
  const message = `Sign in to this collection to ${action}.`;
  if (!principal.record) throw new ApiError(401, message);
  if (principal.collection?.id !== collection.id) {
    throw new ApiError(403, message);
  }
  return principal.record;
}

export function requireSuperuser(principal: Principal): void {
  if (principal.superuser) return;
  if (!principal.record)
    throw new ApiError(401, 'Sign in as a superuser to do this.');
  throw new ApiError(403, 'Only superusers can do this.');
}

/**
 * A superuser acting as someone may do what they can, but nothing that
 * would leave a way back into the account once the session ends, or change
 * who else is signed in: no new or longer sessions, no new password, email,
 * phone, identity or token key, no linked providers, no other sessions
 * revoked. A 403 that says what was refused, such as `be refreshed`.
 */
export function forbidImpersonated(principal: Principal, action: string): void {
  if (principal.impersonatedBy !== undefined) {
    throw new ApiError(403, `Impersonation sessions cannot ${action}.`);
  }
}
