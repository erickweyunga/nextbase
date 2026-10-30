import { createHash, randomBytes } from 'node:crypto';
import type {
  AuthCollection,
  SessionModel,
  SignInMethod,
} from '@nextbasejs/client';
import { type Builder, type DB, hash, type Row } from '@nextbasejs/dbx';
import { table } from '../db/system.ts';
import { decodeRecordJson } from '../db/types.ts';
import { ApiError } from '../errors.ts';
import { newId } from '../random.ts';
import { SCHEMA_RACE, type Schema, type SchemaCache } from '../schema/cache.ts';

/**
 * `__Host-` stops sibling subdomains from setting or overwriting the cookie;
 * plain HTTP in development cannot use the prefix.
 */
export const SESSION_COOKIES = {
  secure: '__Host-nextbase_session',
  plain: 'nextbase_session',
} as const;

/** Keeps a superuser's cookie session while they impersonate in this browser. */
export const IMPERSONATOR_COOKIES = {
  secure: '__Host-nextbase_impersonator',
  plain: 'nextbase_impersonator',
} as const;

/** Holds a pending second sign-in step after an OAuth2 sign-in. */
export const MFA_COOKIES = {
  secure: '__Host-nextbase_mfa',
  plain: 'nextbase_mfa',
} as const;

const SUPERUSERS = '_superusers';

// Extend at most once a day, so active users stay signed in without a write per request.
const UPDATE_AGE = 86_400;
/** Absolute lifetime, so a stolen session cannot be kept alive forever by using it. */
const MAX_AGE = 30 * 86_400;
const MAX_USER_AGENT = 512;
/** Impersonation sessions last from a minute to an hour. */
export const IMPERSONATION_DURATION = { min: 60, max: 3600 } as const;

/** A session row, without its secrets. */
export interface Session {
  id: string;
  collectionId: string;
  recordId: string;
  created: Date;
  expires: Date;
  userAgent: string;
  /** The superuser acting as the record, on an impersonation session. */
  impersonatedBy: string | null;
  /**
   * How the session was signed in, such as `password` and `totp`. Empty for
   * sessions created before methods were recorded.
   */
  methods: SignInMethod[];
}

export interface ActiveSession {
  session: Session;
  collection: AuthCollection;
  record: Row;
  /** This lookup extended the session, so its cookie should be renewed. */
  extended: boolean;
}

// Tokens are stored hashed, so a database leak hands out no live sessions.
function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Rotating the record's `tokenKey` or the collection's secret invalidates the
 * session, as does a deleted record whose id is later reused.
 */
export function sessionKey(collection: AuthCollection, record: Row): string {
  return createHash('sha256')
    .update(`${record.tokenKey as string}:${collection.tokens.auth.secret}`)
    .digest('hex');
}

const COLUMNS = `id, collection_id AS "collectionId", record_id AS "recordId",
  created, expires, user_agent AS "userAgent", impersonator_id AS "impersonatedBy",
  methods`;

export interface SessionOptions {
  /** Seconds; defaults to the collection's auth token duration. */
  duration?: number;
  /**
   * The superuser who acts as the record. The session ends once they are
   * deleted or their key changes, and it is never extended.
   */
  impersonator?: { collection: AuthCollection; record: Row };
  /** How the record signed in, such as `["password", "totp"]`. */
  methods?: readonly SignInMethod[];
}

/** The returned token is shown only once. */
export async function createSession(
  q: Builder,
  collection: AuthCollection,
  record: Row,
  userAgent: string,
  { duration, impersonator, methods = [] }: SessionOptions = {},
): Promise<{ token: string; session: Session }> {
  const token = randomBytes(32).toString('base64url');
  // Expired sessions are removed in the same statement.
  const [session] = await q
    .newQuery(
      `WITH expired AS (
         DELETE FROM {{${table('_sessions')}}} WHERE expires <= now()
       )
       INSERT INTO {{${table('_sessions')}}}
         (id, token_hash, collection_id, record_id, key_hash, user_agent, expires,
          impersonator_id, impersonator_key_hash, methods)
       VALUES ({:id}, {:tokenHash}, {:collectionId}, {:recordId}, {:keyHash}, {:userAgent},
               now() + make_interval(secs => least({:duration}, ${MAX_AGE})),
               {:impersonatorId}, {:impersonatorKeyHash}, {:methods}::text[])
       RETURNING ${COLUMNS}`,
    )
    .bind({
      id: newId(),
      tokenHash: tokenHash(token),
      collectionId: collection.id,
      recordId: record.id,
      keyHash: sessionKey(collection, record),
      userAgent: userAgent.slice(0, MAX_USER_AGENT),
      duration: duration ?? collection.tokens.auth.duration,
      impersonatorId: impersonator ? (impersonator.record.id as string) : null,
      impersonatorKeyHash: impersonator
        ? sessionKey(impersonator.collection, impersonator.record)
        : null,
      methods: [...new Set(methods)],
    })
    .all<Session>();
  return { token, session: session as Session };
}

interface SessionRow {
  schemaVersion: string;
  // Null when no valid session has this token; the same goes for the other session columns.
  id: string | null;
  collectionId: string;
  recordId: string;
  created: Date;
  expires: Date;
  userAgent: string;
  impersonatedBy: string | null;
  methods: SignInMethod[];
  keyHash: string;
  impersonatorKeyHash: string | null;
  /** The impersonator's current tokenKey; null once they are deleted. */
  impersonatorTokenKey: string | null;
  now: Date;
  record: Row | null;
}

/**
 * Reads the schema version, the session and the signed-in record with a
 * single query. The record can be in any auth collection, so the query has
 * one branch per auth collection in `schema`. It always returns one row, so
 * the schema version comes back even when the token is unknown.
 */
async function readSession(
  db: DB,
  schema: Schema,
  hashed: string,
): Promise<SessionRow> {
  const [row] = await readSessions(db, schema, [hashed]);
  return row as SessionRow;
}

/** As `readSessions`, by session id instead of token. */
async function readSessionById(
  db: DB,
  schema: Schema,
  id: string,
): Promise<SessionRow> {
  const [row] = await readSessions(db, schema, [id], 'id');
  return row as SessionRow;
}

/**
 * `readSession` for several token hashes, or session ids with `by: 'id'`, with
 * one query: a row for each, in order.
 */
async function readSessions(
  db: DB,
  schema: Schema,
  keys: readonly string[],
  by: 'token_hash' | 'id' = 'token_hash',
): Promise<SessionRow[]> {
  const params: Record<string, unknown> = { keys: [...keys] };
  const branches = schema.collections
    .filter((c) => c.type === 'auth')
    .map((c, i) => {
      params[`c${i}`] = c.id;
      return `WHEN {:c${i}} THEN (SELECT to_json(r) FROM {{${table(c.name)}}} r WHERE r.id = s.record_id)`;
    });
  return db
    .newQuery(
      `SELECT m.schema_version AS "schemaVersion",
              s.id, s.collection_id AS "collectionId", s.record_id AS "recordId",
              s.created, s.expires, s.user_agent AS "userAgent",
              s.impersonator_id AS "impersonatedBy", s.methods,
              s.key_hash AS "keyHash",
              s.impersonator_key_hash AS "impersonatorKeyHash",
              (SELECT su."tokenKey" FROM {{${table(SUPERUSERS)}}} su
               WHERE su.id = s.impersonator_id) AS "impersonatorTokenKey",
              now() AS now,
              CASE s.collection_id ${branches.join(' ')} END AS record
       FROM {{${table('_meta')}}} m
       CROSS JOIN unnest({:keys}::text[]) WITH ORDINALITY AS h(key, i)
       LEFT JOIN {{${table('_sessions')}}} s
         ON s.${by} = h.key AND s.expires > now()
       ORDER BY h.i`,
    )
    .bind(params)
    .all<SessionRow>();
}

/**
 * Finds the token's session and returns it with the current schema. This
 * takes one query. When the schema changed since it was cached, the schema
 * is reloaded and the record is read again, which takes a few more. With
 * `extend`, a session due for it is extended; a function is first given the
 * new end, and the session is extended only if it returns true.
 */
export async function findSession(
  db: DB,
  schemas: SchemaCache,
  token: string,
  { extend }: { extend: boolean | ((expires: Date) => boolean) },
): Promise<{ schema: Schema; active: ActiveSession | undefined }> {
  const hashed = tokenHash(token);
  let built = schemas.cached ?? (await schemas.get(db));
  let row: SessionRow;
  try {
    row = await readSession(db, built, hashed);
  } catch (error) {
    // A collection was renamed or deleted after the schema was cached, so its table is gone.
    // Reload the schema and try once more.
    if (!SCHEMA_RACE.has((error as { code?: string }).code ?? '')) throw error;
    built = await schemas.get(db);
    row = await readSession(db, built, hashed);
  }
  const schema = await schemas.get(db, Number(row.schemaVersion));
  const found = await activeSession(db, schema, built, row);
  if (!found) return { schema, active: undefined };
  const { session, collection, record } = found;
  const { now } = row;

  const { duration } = collection.tokens.auth;
  const remaining = (session.expires.getTime() - now.getTime()) / 1000;
  const cap = session.created.getTime() + MAX_AGE * 1000;
  // Impersonation sessions end when they were set to.
  const due =
    session.impersonatedBy === null &&
    remaining < duration - Math.min(UPDATE_AGE, duration / 2) &&
    session.expires.getTime() < cap;
  let extended = false;
  if (due && extend !== false) {
    // The end extendSession sets, by the database's clock.
    const expires = new Date(Math.min(now.getTime() + duration * 1000, cap));
    extended = extend === true || extend(expires);
  }
  if (extended)
    session.expires = await extendSession(db, collection, session.id);
  return { schema, active: { session, collection, record, extended } };
}

/**
 * The sessions of several tokens, with one query, as `findSession` finds
 * them but never extended: undefined for a token without one.
 */
export async function findSessions(
  db: DB,
  schemas: SchemaCache,
  tokens: readonly string[],
): Promise<(ActiveSession | undefined)[]> {
  if (tokens.length === 0) return [];
  const hashes = tokens.map(tokenHash);
  let built = schemas.cached ?? (await schemas.get(db));
  let rows: SessionRow[];
  try {
    rows = await readSessions(db, built, hashes);
  } catch (error) {
    // As in findSession: a table of the cached schema is gone.
    if (!SCHEMA_RACE.has((error as { code?: string }).code ?? '')) throw error;
    built = await schemas.get(db);
    rows = await readSessions(db, built, hashes);
  }
  const schema = await schemas.get(db, Number(rows[0]?.schemaVersion));
  const found: (ActiveSession | undefined)[] = [];
  for (const row of rows) {
    const active = await activeSession(db, schema, built, row);
    found.push(active && { ...active, extended: false });
  }
  return found;
}

/**
 * The token's session as `schema` finds it, never extended, or undefined,
 * as when a table of `schema` is gone since.
 */
export async function sessionIn(
  db: DB,
  schema: Schema,
  token: string,
): Promise<Omit<ActiveSession, 'extended'> | undefined> {
  try {
    const row = await readSession(db, schema, tokenHash(token));
    return await activeSession(db, schema, schema, row);
  } catch (error) {
    if (SCHEMA_RACE.has((error as { code?: string }).code ?? ''))
      return undefined;
    throw error;
  }
}

/**
 * The session with this id, if still valid, as `sessionIn` finds a token's.
 * For tokens minted on a session that must end with it.
 */
export async function sessionById(
  db: DB,
  schema: Schema,
  id: string,
): Promise<Omit<ActiveSession, 'extended'> | undefined> {
  try {
    const row = await readSessionById(db, schema, id);
    return await activeSession(db, schema, schema, row);
  } catch (error) {
    if (SCHEMA_RACE.has((error as { code?: string }).code ?? ''))
      return undefined;
    throw error;
  }
}

/**
 * The session of a row `readSessions` read, if it is still valid: its
 * record exists in an auth collection and its key matches the record's.
 * An impersonation session also needs its superuser, with the key they had
 * when it started, so deleting them or changing their password ends it.
 */
async function activeSession(
  db: DB,
  schema: Schema,
  built: Schema,
  row: SessionRow,
): Promise<Omit<ActiveSession, 'extended'> | undefined> {
  const {
    schemaVersion,
    id,
    keyHash,
    impersonatorKeyHash,
    impersonatorTokenKey,
    now,
    record: json,
    ...rest
  } = row;
  if (id === null) return undefined;
  const session: Session = { id, ...rest };
  const collection = schema.find(session.collectionId);
  if (collection?.type !== 'auth') return undefined;
  if (session.impersonatedBy !== null) {
    const superusers = schema.find(SUPERUSERS);
    if (
      superusers?.type !== 'auth' ||
      impersonatorTokenKey === null ||
      sessionKey(superusers, { tokenKey: impersonatorTokenKey }) !==
        impersonatorKeyHash
    ) {
      return undefined;
    }
  }
  // When the schema changed, the record may come from the wrong table, so read it again.
  const record =
    schema.version === built.version
      ? json && decodeRecordJson(collection, json)
      : (
          await db
            .select()
            .from(table(collection.name))
            .where(hash({ id: session.recordId }))
            .all()
        )[0];
  if (!record || sessionKey(collection, record) !== keyHash) return undefined;
  return { session, collection, record };
}

/** Never past the session's absolute end; never an impersonation session. */
export async function extendSession(
  q: Builder,
  collection: AuthCollection,
  id: string,
): Promise<Date> {
  const [expires] = await q
    .newQuery(
      `UPDATE {{${table('_sessions')}}}
       SET expires = CASE WHEN impersonator_id IS NULL
         THEN least(now() + make_interval(secs => {:duration}),
                    created + make_interval(secs => ${MAX_AGE}))
         ELSE expires END
       WHERE id = {:id} RETURNING expires`,
    )
    .bind({ id, duration: collection.tokens.auth.duration })
    .column<Date>();
  return expires as Date;
}

export async function listSessions(
  q: Builder,
  collectionId: string,
  recordId: string,
): Promise<Session[]> {
  return q
    .newQuery(
      `SELECT ${COLUMNS} FROM {{${table('_sessions')}}}
       WHERE collection_id = {:collectionId} AND record_id = {:recordId} AND expires > now()
       ORDER BY created DESC, id`,
    )
    .bind({ collectionId, recordId })
    .all<Session>();
}

export async function deleteSession(
  q: Builder,
  session: { id: string; collectionId: string; recordId: string },
): Promise<boolean> {
  const deleted = await q
    .newQuery(
      `DELETE FROM {{${table('_sessions')}}}
       WHERE id = {:id} AND collection_id = {:collectionId} AND record_id = {:recordId}
       RETURNING id`,
    )
    .bind(session)
    .column();
  return deleted.length > 0;
}

export async function deleteOtherSessions(
  q: Builder,
  keep: { id: string; collectionId: string; recordId: string },
): Promise<void> {
  await q
    .newQuery(
      `DELETE FROM {{${table('_sessions')}}}
       WHERE collection_id = {:collectionId} AND record_id = {:recordId} AND id <> {:id}`,
    )
    .bind(keep)
    .execute();
}

/** After a tokenKey rotation, re-binds `keep` so changing your password signs out only other devices. */
export async function rekeySessions(
  q: Builder,
  collection: AuthCollection,
  record: Row,
  keep: string | undefined,
): Promise<void> {
  const where = { collectionId: collection.id, recordId: record.id };
  await q
    .newQuery(
      `DELETE FROM {{${table('_sessions')}}}
       WHERE collection_id = {:collectionId} AND record_id = {:recordId}
         AND id IS DISTINCT FROM {:keep}`,
    )
    .bind({ ...where, keep: keep ?? null })
    .execute();
  if (keep !== undefined) {
    await q
      .newQuery(
        `UPDATE {{${table('_sessions')}}} SET key_hash = {:keyHash} WHERE id = {:keep}`,
      )
      .bind({ keep, keyHash: sessionKey(collection, record) })
      .execute();
  }
}

/** Records one more way the session proved who it is, such as `totp`. */
export async function addSessionMethod(
  q: Builder,
  id: string,
  method: SignInMethod,
): Promise<void> {
  await q
    .newQuery(
      `UPDATE {{${table('_sessions')}}}
       SET methods = array_append(methods, {:method})
       WHERE id = {:id} AND NOT ({:method} = ANY(methods))`,
    )
    .bind({ id, method })
    .execute();
}

export function sessionModel(session: Session, current: boolean): SessionModel {
  return {
    id: session.id,
    created: session.created.toISOString(),
    expires: session.expires.toISOString(),
    userAgent: session.userAgent,
    current,
    methods: [...session.methods],
    ...(session.impersonatedBy !== null && {
      impersonatedBy: session.impersonatedBy,
    }),
  };
}

export function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  if (header === null) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  // A malformed header is an invalid token, never an anonymous request.
  return match?.[1] ?? '';
}

export function isSecure(request: Request): boolean {
  return (
    new URL(request.url).protocol === 'https:' ||
    process.env.NODE_ENV === 'production'
  );
}

export function sessionCookie(request: Request): string | undefined {
  return readCookie(
    request,
    isSecure(request) ? SESSION_COOKIES.secure : SESSION_COOKIES.plain,
  );
}

/** The pending second sign-in step of an OAuth2 sign-in in this browser. */
export function mfaCookie(request: Request): string | undefined {
  const value = readCookie(
    request,
    isSecure(request) ? MFA_COOKIES.secure : MFA_COOKIES.plain,
  );
  return value === '' ? undefined : value;
}

/** Removes the cookie when `pending` is undefined. */
export function setMfaCookie(
  request: Request,
  pending?: { mfaId: string; maxAge: number },
): string {
  const secure = isSecure(request);
  return [
    `${secure ? MFA_COOKIES.secure : MFA_COOKIES.plain}=${pending?.mfaId ?? ''}`,
    'Path=/',
    `Max-Age=${pending?.maxAge ?? 0}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/** The superuser session kept while impersonating in this browser. */
export function impersonatorCookie(request: Request): string | undefined {
  return readCookie(
    request,
    isSecure(request)
      ? IMPERSONATOR_COOKIES.secure
      : IMPERSONATOR_COOKIES.plain,
  );
}

export function readCookie(
  request: Request,
  wanted: string,
): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === wanted) return value.join('=');
  }
  return undefined;
}

/**
 * Removes the cookie when `token` is undefined. HttpOnly hides it from
 * scripts; SameSite=Lax limits cross-site sends to top-level navigations.
 */
export function setSessionCookie(
  request: Request,
  session?: { token: string; expires: Date },
): string {
  return cookieHeader(request, SESSION_COOKIES, session);
}

/** As `setSessionCookie`, for the superuser session kept while impersonating. */
export function setImpersonatorCookie(
  request: Request,
  session?: { token: string; expires: Date },
): string {
  return cookieHeader(request, IMPERSONATOR_COOKIES, session);
}

function cookieHeader(
  request: Request,
  names: { secure: string; plain: string },
  session: { token: string; expires: Date } | undefined,
): string {
  const maxAge = session
    ? Math.max(0, Math.floor((session.expires.getTime() - Date.now()) / 1000))
    : 0;
  const secure = isSecure(request);
  const name = secure ? names.secure : names.plain;
  return [
    `${name}=${session?.token ?? ''}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export interface OriginPolicy {
  /**
   * Extra hosts allowed to write via the cookie: `app.example.com`,
   * `*.example.com` (one label) or `**.example.com`.
   */
  trustedOrigins: readonly string[];
  /** Read this host from X-Forwarded-Host; only behind a proxy you run. */
  trustProxy: boolean;
}

/**
 * Browsers attach the cookie to requests other sites make, so writes must come
 * from this host or a trusted one (`Sec-Fetch-Site`, else `Origin`). Hosts,
 * not full origins, are compared since proxies often change the scheme.
 */
export function checkSameOrigin(request: Request, policy: OriginPolicy): void {
  const site = request.headers.get('sec-fetch-site');
  // "none": the user started it, such as by typing a URL.
  if (site === 'same-origin' || site === 'none') return;

  let originHost: string | undefined;
  try {
    const origin = request.headers.get('origin');
    originHost = origin ? new URL(origin).host : undefined;
  } catch {
    originHost = undefined;
  }
  if (originHost !== undefined) {
    if (policy.trustedOrigins.some((p) => matchesHost(originHost, p))) return;
    // Same-site includes sibling subdomains, so it must be trusted too.
    if (site === null && originHost.toLowerCase() === thisHost(request, policy))
      return;
  }
  throw new ApiError(403, 'Cross-site requests cannot use the session cookie.');
}

/** X-Forwarded-Host only behind a proxy you run, since any client can send it. */
function thisHost(request: Request, policy: OriginPolicy): string {
  const forwarded = policy.trustProxy
    ? request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
    : undefined;
  return (
    forwarded ||
    request.headers.get('host') ||
    new URL(request.url).host
  ).toLowerCase();
}

/** Case-insensitive; `*` is one label, a leading `**` one or more; a bare wildcard matches nothing. */
function matchesHost(host: string, pattern: string): boolean {
  const hostParts = host.toLowerCase().split('.');
  const patternParts = pattern.toLowerCase().split('.');
  if (
    patternParts.length === 1 &&
    (patternParts[0] === '*' || patternParts[0] === '**')
  ) {
    return false;
  }
  if (hostParts.length < patternParts.length) return false;
  while (patternParts.length > 0) {
    const part = patternParts.pop() as string;
    if (part === '**') return patternParts.length === 0 && hostParts.length > 0;
    const hostPart = hostParts.pop();
    if (part === '' || hostPart === undefined) return false;
    if (part !== '*' && part !== hostPart) return false;
  }
  return hostParts.length === 0;
}
