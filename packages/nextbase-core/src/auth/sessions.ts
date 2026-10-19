import { createHash, randomBytes } from "node:crypto";
import type { AuthCollection, SessionModel } from "@nextbasejs/client";
import { type Builder, hash, type Row } from "@nextbasejs/dbx";
import { table } from "../db/system.ts";
import { ApiError } from "../errors.ts";
import { LOWER_ALPHANUMERIC, randomString } from "../random.ts";
import type { Schema } from "../schema/cache.ts";

/**
 * Names of the cookie holding a session token. Over HTTPS the `__Host-`
 * prefix makes browsers refuse it unless it is Secure, host-only and on
 * `Path=/`, so a sibling subdomain cannot set or shadow it (OWASP Session
 * Management Cheat Sheet). Plain HTTP, in development, cannot use it.
 */
export const SESSION_COOKIES = {
  secure: "__Host-nextbase_session",
  plain: "nextbase_session",
} as const;

// A session in use is extended once it is this old, at most once a day, so
// active users stay signed in without a write on every request.
const UPDATE_AGE = 86_400;
/**
 * However active, a session ends this long after sign-in (OWASP: "an absolute
 * timeout, regardless of session activity"; NIST SP 800-63B rev 4 sets 30 days
 * as the longest reauthentication interval at AAL1).
 */
const MAX_AGE = 30 * 86_400;
const MAX_USER_AGENT = 512;

/** A session row, without its secrets. */
export interface Session {
  id: string;
  collectionId: string;
  recordId: string;
  created: Date;
  expires: Date;
  userAgent: string;
}

/** A valid session with the record it belongs to. */
export interface ActiveSession {
  session: Session;
  collection: AuthCollection;
  record: Row;
  /** Whether this lookup extended the session, so a cookie should be renewed. */
  extended: boolean;
}

// Tokens are stored hashed, so a database leak hands out no live sessions.
function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Binds a session to the record's `tokenKey` and the collection's auth
 * secret. Rotating either (on a password or email change, or to revoke all of
 * a collection's sessions) invalidates the session, and so does a deleted
 * record whose id is later reused.
 */
function sessionKey(collection: AuthCollection, record: Row): string {
  return createHash("sha256")
    .update(`${record.tokenKey as string}:${collection.tokens.auth.secret}`)
    .digest("hex");
}

const COLUMNS = `id, collection_id AS "collectionId", record_id AS "recordId",
  created, expires, user_agent AS "userAgent"`;

/** Starts a session for `record`. Returns its token, which is shown only once. */
export async function createSession(
  q: Builder,
  collection: AuthCollection,
  record: Row,
  userAgent: string,
): Promise<{ token: string; session: Session }> {
  // Expired sessions are cleaned up here, where sessions are created.
  await q
    .newQuery(`DELETE FROM {{${table("_sessions")}}} WHERE expires <= now()`)
    .execute();
  const token = randomBytes(32).toString("base64url");
  const [session] = await q
    .newQuery(
      `INSERT INTO {{${table("_sessions")}}}
         (id, token_hash, collection_id, record_id, key_hash, user_agent, expires)
       VALUES ({:id}, {:tokenHash}, {:collectionId}, {:recordId}, {:keyHash}, {:userAgent},
               now() + make_interval(secs => least({:duration}, ${MAX_AGE})))
       RETURNING ${COLUMNS}`,
    )
    .bind({
      id: randomString(15, LOWER_ALPHANUMERIC),
      tokenHash: tokenHash(token),
      collectionId: collection.id,
      recordId: record.id,
      keyHash: sessionKey(collection, record),
      userAgent: userAgent.slice(0, MAX_USER_AGENT),
      duration: collection.tokens.auth.duration,
    })
    .all<Session>();
  return { token, session: session as Session };
}

/**
 * Finds the live session for `token`, extending it when it is due. Returns
 * undefined for unknown, expired or revoked sessions.
 */
export async function findSession(
  q: Builder,
  schema: Schema,
  token: string,
  { extend }: { extend: boolean },
): Promise<ActiveSession | undefined> {
  const [row] = await q
    .newQuery(
      `SELECT ${COLUMNS}, key_hash AS "keyHash", now() AS now
       FROM {{${table("_sessions")}}}
       WHERE token_hash = {:tokenHash} AND expires > now()`,
    )
    .bind({ tokenHash: tokenHash(token) })
    .all<Session & { keyHash: string; now: Date }>();
  if (!row) return undefined;
  const { keyHash, now, ...session } = row;

  const collection = schema.find(session.collectionId);
  if (collection?.type !== "auth") return undefined;
  const [record] = await q
    .select()
    .from(table(collection.name))
    .where(hash({ id: session.recordId }))
    .all();
  if (!record || sessionKey(collection, record) !== keyHash) return undefined;

  const { duration } = collection.tokens.auth;
  const remaining = (session.expires.getTime() - now.getTime()) / 1000;
  const cap = session.created.getTime() + MAX_AGE * 1000;
  const extended =
    extend &&
    remaining < duration - Math.min(UPDATE_AGE, duration / 2) &&
    session.expires.getTime() < cap;
  if (extended)
    session.expires = await extendSession(q, collection, session.id);
  return { session, collection, record, extended };
}

/**
 * Resets a session's lifetime to the collection's full auth duration, never
 * past its absolute end.
 */
export async function extendSession(
  q: Builder,
  collection: AuthCollection,
  id: string,
): Promise<Date> {
  const [expires] = await q
    .newQuery(
      `UPDATE {{${table("_sessions")}}}
       SET expires = least(now() + make_interval(secs => {:duration}),
                          created + make_interval(secs => ${MAX_AGE}))
       WHERE id = {:id} RETURNING expires`,
    )
    .bind({ id, duration: collection.tokens.auth.duration })
    .column<Date>();
  return expires as Date;
}

/** The sessions of one record, newest first. */
export async function listSessions(
  q: Builder,
  collectionId: string,
  recordId: string,
): Promise<Session[]> {
  return q
    .newQuery(
      `SELECT ${COLUMNS} FROM {{${table("_sessions")}}}
       WHERE collection_id = {:collectionId} AND record_id = {:recordId} AND expires > now()
       ORDER BY created DESC, id`,
    )
    .bind({ collectionId, recordId })
    .all<Session>();
}

/** Ends one of a record's sessions. Returns whether it existed. */
export async function deleteSession(
  q: Builder,
  session: { id: string; collectionId: string; recordId: string },
): Promise<boolean> {
  const deleted = await q
    .newQuery(
      `DELETE FROM {{${table("_sessions")}}}
       WHERE id = {:id} AND collection_id = {:collectionId} AND record_id = {:recordId}
       RETURNING id`,
    )
    .bind(session)
    .column();
  return deleted.length > 0;
}

/**
 * After a record's `tokenKey` changed: ends its other sessions and keeps the
 * caller's own (`keep`) valid under the new key, so changing your password
 * signs out every other device but not this one.
 */
export async function rekeySessions(
  q: Builder,
  collection: AuthCollection,
  record: Row,
  keep: string | undefined,
): Promise<void> {
  const where = { collectionId: collection.id, recordId: record.id };
  await q
    .newQuery(
      `DELETE FROM {{${table("_sessions")}}}
       WHERE collection_id = {:collectionId} AND record_id = {:recordId}
         AND id IS DISTINCT FROM {:keep}`,
    )
    .bind({ ...where, keep: keep ?? null })
    .execute();
  if (keep !== undefined) {
    await q
      .newQuery(
        `UPDATE {{${table("_sessions")}}} SET key_hash = {:keyHash} WHERE id = {:keep}`,
      )
      .bind({ keep, keyHash: sessionKey(collection, record) })
      .execute();
  }
}

export function sessionModel(session: Session, current: boolean): SessionModel {
  return {
    id: session.id,
    created: session.created.toISOString(),
    expires: session.expires.toISOString(),
    userAgent: session.userAgent,
    current,
  };
}

/** The token of an `Authorization: Bearer` header, or undefined without one. */
export function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (header === null) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  // A malformed header is an invalid token, never an anonymous request.
  return match?.[1] ?? "";
}

/** Whether a request's cookies are Secure, and so `__Host-` prefixed. */
export function isSecure(request: Request): boolean {
  return (
    new URL(request.url).protocol === "https:" ||
    process.env.NODE_ENV === "production"
  );
}

/** The session cookie's value, or undefined without one. */
export function sessionCookie(request: Request): string | undefined {
  return readCookie(
    request,
    isSecure(request) ? SESSION_COOKIES.secure : SESSION_COOKIES.plain,
  );
}

/** A cookie's value, or undefined without it. */
export function readCookie(
  request: Request,
  wanted: string,
): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === wanted) return value.join("=");
  }
  return undefined;
}

/**
 * A `Set-Cookie` header for a session token, or one that removes the cookie
 * when `token` is undefined. HttpOnly keeps it from scripts; SameSite=Lax keeps
 * other sites' requests from carrying it, except top-level navigations.
 */
export function setSessionCookie(
  request: Request,
  session?: { token: string; expires: Date },
): string {
  const maxAge = session
    ? Math.max(0, Math.floor((session.expires.getTime() - Date.now()) / 1000))
    : 0;
  const secure = isSecure(request);
  const name = secure ? SESSION_COOKIES.secure : SESSION_COOKIES.plain;
  return [
    `${name}=${session?.token ?? ""}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/** Which other sites may write through the session cookie, and how to know this one. */
export interface OriginPolicy {
  /**
   * Hosts besides this one, as in Next.js's `serverActions.allowedOrigins`:
   * `app.example.com`, `*.example.com` (one label) or `**.example.com`.
   */
  trustedOrigins: readonly string[];
  /** Read this host from X-Forwarded-Host, set by a proxy in front. */
  trustProxy: boolean;
}

/**
 * Rejects cross-site requests that would act through the session cookie, as
 * the OWASP CSRF Prevention Cheat Sheet describes: by `Sec-Fetch-Site` where
 * the browser sends it, and otherwise by `Origin`, which browsers send on
 * such writes. The request's origin must be this host or a trusted one.
 * Hosts are compared rather than full origins, as Next.js does for server
 * actions, since proxies often change the scheme the app sees.
 */
export function checkSameOrigin(request: Request, policy: OriginPolicy): void {
  const site = request.headers.get("sec-fetch-site");
  // "none": the user started it, such as by typing a URL.
  if (site === "same-origin" || site === "none") return;

  let originHost: string | undefined;
  try {
    const origin = request.headers.get("origin");
    originHost = origin ? new URL(origin).host : undefined;
  } catch {
    originHost = undefined;
  }
  if (originHost !== undefined) {
    if (policy.trustedOrigins.some((p) => matchesHost(originHost, p))) return;
    // A cross-site or same-site request comes from another origin, so only a
    // trusted origin passes; same-site includes sibling subdomains.
    if (site === null && originHost.toLowerCase() === thisHost(request, policy))
      return;
  }
  throw new ApiError(403, "Cross-site requests cannot use the session cookie.");
}

/**
 * This server's host: Host by default, which platforms such as Vercel set to
 * the domain the client used. X-Forwarded-Host only behind a trusted proxy
 * (OWASP: "Use the X-Forwarded-Host header value only from trusted proxies").
 */
function thisHost(request: Request, policy: OriginPolicy): string {
  const forwarded = policy.trustProxy
    ? request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()
    : undefined;
  return (
    forwarded ||
    request.headers.get("host") ||
    new URL(request.url).host
  ).toLowerCase();
}

/**
 * Whether `host` matches `pattern` the way Next.js matches allowedOrigins:
 * case-insensitive, `*` is one label, a leading `**` is one or more, and a
 * wildcard alone matches nothing.
 */
function matchesHost(host: string, pattern: string): boolean {
  const hostParts = host.toLowerCase().split(".");
  const patternParts = pattern.toLowerCase().split(".");
  if (
    patternParts.length === 1 &&
    (patternParts[0] === "*" || patternParts[0] === "**")
  ) {
    return false;
  }
  if (hostParts.length < patternParts.length) return false;
  while (patternParts.length > 0) {
    const part = patternParts.pop() as string;
    if (part === "**") return patternParts.length === 0 && hostParts.length > 0;
    const hostPart = hostParts.pop();
    if (part === "" || hostPart === undefined) return false;
    if (part !== "*" && part !== hostPart) return false;
  }
  return hostParts.length === 0;
}
