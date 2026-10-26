import adminHtml from "@nextbasejs/admin/index.html?raw";
import type { AuthCollection } from "@nextbasejs/client";
import {
  AuthStore,
  ClientError,
  type CurrentSession,
  DEFAULT_BASE_PATH,
  type HealthResponse,
  NextBaseClient,
} from "@nextbasejs/client";
import { DB, type Pool } from "@nextbasejs/dbx";
import { waitUntil as vercelWaitUntil } from "@vercel/functions";
import { ROUTES } from "./api/routes.ts";
import { checkAppUrl } from "./app-url.ts";
import { Mailer, type MailOptions } from "./auth/mail.ts";
import { OAuth2, type OAuth2Options } from "./auth/oauth2.ts";
import { type Principal, resolvePrincipal } from "./auth/principal.ts";
import {
  bearerToken,
  checkSameOrigin,
  type OriginPolicy,
  SESSION_COOKIES,
  sessionCookie,
} from "./auth/sessions.ts";
import { Sms, type SmsOptions } from "./auth/sms.ts";
import {
  hasSuperuser,
  insertSuperuser,
  setupToken,
} from "./auth/superusers.ts";
import { migrate } from "./db/migrations.ts";
import { sharedPool } from "./db/pool.ts";
import { TYPES } from "./db/types.ts";
import { Effects } from "./effects.ts";
import { ApiError } from "./errors.ts";
import {
  newStorage,
  type Storage,
  type StorageOptions,
} from "./files/storage.ts";
import { readSchemaVersion, type Schema, SchemaCache } from "./schema/cache.ts";

/**
 * Postgres errors the Postgres docs say a retry of the whole transaction can
 * fix: serialization failures and deadlocks.
 */
const RETRYABLE: ReadonlySet<string> = new Set(["40001", "40P01"]);

/**
 * A missing table or column: retryable only when a concurrent schema change
 * renamed or dropped it after this request read the schema; otherwise a bug.
 */
const SCHEMA_RACE: ReadonlySet<string> = new Set(["42P01", "42703"]);

const DEFAULT_STATEMENT_TIMEOUT = 8_000;

// Origin of in-process requests from `client()`. Never resolved or fetched.
const IN_PROCESS_ORIGIN = "http://nextbase.internal";

// While no superuser exists, the setup token is logged at most this often.
const SETUP_LOG_INTERVAL_MS = 60_000;

export type {
  ApiErrorBody,
  AuthMethods,
  AuthProvider,
  CurrentSession,
  ErrorData,
  FieldError,
  HealthResponse,
  LinkedAccountModel,
} from "@nextbasejs/client";
export type { Pool } from "@nextbasejs/dbx";
export type {
  MailContext,
  MailKind,
  MailMessage,
  MailOptions,
  MailTemplate,
} from "./auth/mail.ts";
export type { OAuth2Options, OAuth2ProviderOptions } from "./auth/oauth2.ts";
export type {
  SmsContext,
  SmsKind,
  SmsMessage,
  SmsOptions,
  SmsTemplate,
} from "./auth/sms.ts";
export type { S3StorageOptions, StorageOptions } from "./files/storage.ts";

/**
 * Whether a request carries a session cookie, without checking it: for an
 * optimistic redirect in `proxy.ts`, which Next.js recommends keep to cookie
 * checks. Anyone can send a cookie, so it proves nothing; the data stays
 * protected by collection rules wherever it is read.
 */
export function hasSessionCookie(request: Request): boolean {
  return sessionCookie(request) !== undefined;
}

export interface NextBaseOptions {
  /** Path the route handler is mounted at. Defaults to `/api/nextbase`. */
  basePath?: string;
  /**
   * A Postgres connection string, or a `pg.Pool`-compatible pool such as one
   * from `@neondatabase/serverless`. Defaults to `process.env.DATABASE_URL`.
   * A pool you pass in stays yours to end.
   */
  database?: string | Pool;
  /**
   * Milliseconds a statement of a records API request may run before Postgres
   * stops it, so an expensive filter cannot hold the database. Defaults to
   * 8000 (8 seconds), long enough for normal requests. 0 turns it off; a
   * statement_timeout set on the database role still applies then.
   */
  statementTimeout?: number;
  /**
   * Other hosts allowed to write through the session cookie, for a frontend
   * on another subdomain: `app.example.com`, `*.example.com` (one label) or
   * `**.example.com`, as in Next.js's `serverActions.allowedOrigins`.
   */
  trustedOrigins?: string[];
  /**
   * Read the request's host from X-Forwarded-Host, which only a proxy you
   * run in front should set. Off by default: platforms such as Vercel set
   * Host to the domain the client used.
   */
  trustProxy?: boolean;
  /**
   * Your app's URL, such as `https://example.com`, which email links and
   * OAuth2 redirects are built from. Never taken from the request's Host
   * header, which an attacker can set. HTTPS, except on localhost.
   */
  appUrl?: string;
  /**
   * Sends verification, password reset and email change emails. Without it,
   * those endpoints answer 400 in production; in development the emails
   * are logged.
   */
  mail?: MailOptions;
  /**
   * Where uploaded files are kept: a local directory by default, or an
   * S3-compatible bucket with `{ s3: { bucket, ... } }`. Serverless hosts
   * such as Vercel lose local files, so use a bucket there.
   */
  storage?: StorageOptions;
  /**
   * Sends the codes of phone sign-in, for auth collections with `phoneSignIn`.
   * Without it, phone endpoints answer 400 in production; in development
   * the texts are logged.
   */
  sms?: SmsOptions;
  /**
   * Rejects new passwords that appear in known data breaches, which attackers
   * try first. Checked with the Have I Been Pwned password service, which
   * receives only the first 5 characters of the password's SHA-1 hash, never
   * the password. When the service cannot be reached, passwords are accepted.
   * Off by default.
   */
  rejectBreachedPasswords?: boolean;
  /**
   * Sign-in with OAuth2 providers, by name: `google` and `github`, or any
   * OpenID Connect provider with its `issuer`. Each needs your app's URL in
   * `appUrl`; register `{appUrl origin}{basePath}/callback/{name}`, such as
   * `https://example.com/api/nextbase/callback/google`, at the provider as
   * the redirect URI.
   */
  oauth2?: OAuth2Options;
  /**
   * Keeps background work, such as sending email after the response, alive
   * on serverless platforms. Defaults to Vercel's waitUntil, which does
   * nothing elsewhere; on Next.js you can pass `after` from `next/server`.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * The parts of Next.js's `cookies()` store that `client()` uses. With `set`
 * (in server actions and route handlers), signing in and out updates it.
 */
export interface CookieStore {
  get(name: string): { value: string } | undefined;
  set?(
    name: string,
    value: string,
    options: {
      path: string;
      maxAge: number;
      httpOnly: boolean;
      sameSite: "lax";
      secure: boolean;
    },
  ): unknown;
}

export interface ServerClientOptions {
  /** Act as the user signed in through the session cookie: `await cookies()`. */
  cookies?: CookieStore;
  /**
   * Act as a superuser, bypassing every rule. For trusted server code only:
   * never let user input choose what such a client reads or writes.
   */
  superuser?: boolean;
}

export type RouteHandler = (request: Request) => Promise<Response>;

export class NextBase {
  readonly #basePath: string;
  readonly #database: string | Pool | undefined;
  readonly #statementTimeout: number;
  readonly #origins: OriginPolicy;
  readonly #mailer: Mailer;
  readonly #oauth2: OAuth2;
  readonly #sms: Sms;
  readonly #rejectBreachedPasswords: boolean;
  readonly #storage: Storage;
  readonly #waitUntil: (promise: Promise<unknown>) => void;
  #db: DB | undefined;
  #migrated: Promise<void> | undefined;
  readonly #schema = new SchemaCache();
  #superuserExists = false;
  #setupLoggedAt = Number.NEGATIVE_INFINITY;

  constructor(options: NextBaseOptions = {}) {
    this.#basePath = (options.basePath ?? DEFAULT_BASE_PATH).replace(
      /\/+$/,
      "",
    );
    this.#database = options.database;
    this.#rejectBreachedPasswords = options.rejectBreachedPasswords ?? false;
    const appUrl =
      options.appUrl === undefined ? undefined : checkAppUrl(options.appUrl);
    this.#mailer = new Mailer(options.mail, appUrl, options.waitUntil);
    this.#sms = new Sms(options.sms, options.waitUntil);
    this.#storage = newStorage(options.storage);
    this.#waitUntil = options.waitUntil ?? vercelWaitUntil;
    this.#oauth2 = new OAuth2(
      options.oauth2,
      appUrl ??
        (options.mail?.appUrl === undefined
          ? undefined
          : checkAppUrl(options.mail.appUrl, "mail.appUrl")),
      this.#basePath,
    );
    this.#origins = {
      trustedOrigins: [...(options.trustedOrigins ?? [])],
      trustProxy: options.trustProxy ?? false,
    };
    this.#statementTimeout =
      options.statementTimeout ?? DEFAULT_STATEMENT_TIMEOUT;
    if (
      !Number.isInteger(this.#statementTimeout) ||
      this.#statementTimeout < 0
    ) {
      throw new RangeError(
        "statementTimeout must be a whole number of milliseconds, or 0.",
      );
    }
  }

  /**
   * Creates or upgrades NextBase's tables. Requests that need the database do
   * this on their own; call it from a deploy script to do it ahead of traffic.
   * Runs once per instance; a failed attempt is retried on the next call.
   */
  migrate(): Promise<void> {
    // Async so a missing database rejects instead of throwing synchronously.
    this.#migrated ??= (async () => migrate(this.#connection()))().catch(
      (error: unknown) => {
        this.#migrated = undefined;
        throw error;
      },
    );
    return this.#migrated;
  }

  // Created on first use, not in the constructor: `next build` evaluates route
  // modules without a database, so constructing NextBase must never connect.
  #connection(): DB {
    if (this.#db) return this.#db;
    const database = this.#database ?? process.env.DATABASE_URL;
    if (database === undefined || database === "") {
      throw new Error(
        "NextBase needs a database: set DATABASE_URL or pass the `database` option.",
      );
    }
    this.#db = new DB(
      typeof database === "string" ? sharedPool(database) : database,
      { types: TYPES },
    );
    return this.#db;
  }

  /**
   * Creates a superuser, for scripts and seeding. Unlike the setup flow it
   * works at any time, so never expose it to untrusted input.
   */
  async createSuperuser(email: string, password: string): Promise<void> {
    await this.migrate();
    const db = this.#connection();
    const schema = await this.#schema.get(db);
    await insertSuperuser(
      db,
      schema.get("_superusers") as AuthCollection,
      email,
      password,
    );
  }

  // Logs a setup token while no superuser exists. It goes to the server logs,
  // which only the owner can read, so a stranger who finds a fresh deployment
  // first cannot claim it.
  async #announceSetup(db: DB, url: URL): Promise<void> {
    if (this.#superuserExists) return;
    if (await hasSuperuser(db)) {
      this.#superuserExists = true;
      return;
    }
    if (Date.now() - this.#setupLoggedAt < SETUP_LOG_INTERVAL_MS) return;
    this.#setupLoggedAt = Date.now();
    const token = await setupToken(db);
    console.info(
      `[nextbase] No superuser exists yet. Within the next hour, create one with:\n` +
        `  curl -X POST ${url.origin}${this.#basePath}/setup -H 'content-type: application/json' \\\n` +
        `    -d '{"token":"${token}","email":"you@example.com","password":"a long password"}'`,
    );
  }

  /**
   * The session of a request's cookie or Bearer token, checked against the
   * database, or null: for `proxy.ts`, to redirect signed-out visitors before
   * a page renders. It neither extends the session nor sets cookies. Proxy
   * runs on every matched request, prefetches included, so match only the
   * routes that need it; `hasSessionCookie()` is the database-free check.
   */
  async getSession(request: Request): Promise<CurrentSession | null> {
    const token = sessionCookie(request) ?? bearerToken(request);
    if (!token) return null;
    const nb = this.client();
    nb.authStore.save(token, null);
    try {
      return await nb.getSession();
    } catch (error) {
      if (error instanceof ClientError && error.status === 401) return null;
      throw error;
    }
  }

  /**
   * A client SDK instance for server code that calls this instance in-process:
   * no network hop, but the same routing, validation, rules and output as
   * HTTP. With `cookies`, it acts as the user of the session cookie, and
   * signing in with `{ cookie: true }` or out updates that cookie. Create one
   * per request, never share a signed-in client between users.
   */
  client(options: ServerClientOptions = {}): NextBaseClient {
    const principal: Principal | undefined = options.superuser
      ? { superuser: true }
      : undefined;
    return new NextBaseClient({
      baseUrl: `${IN_PROCESS_ORIGIN}${this.#basePath}`,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const cookies = Object.values(SESSION_COOKIES).flatMap((name) => {
          const value = options.cookies?.get(name)?.value;
          return value ? [`${name}=${value}`] : [];
        });
        if (cookies.length > 0)
          request.headers.set("cookie", cookies.join("; "));
        const response = await this.#dispatch(request, {
          principal,
          http: false,
        });
        if (options.cookies) applySessionCookie(options.cookies, response);
        return response;
      },
      authStore: new AuthStore({ storage: null }),
    });
  }

  /**
   * Deletes stored files in the background. A failure only leaves an unused
   * file behind, so it is logged rather than failing the request.
   */
  #deleteFiles(keys: readonly string[]): void {
    if (keys.length === 0) return;
    this.#waitUntil(
      this.#storage.delete(keys).catch((error: unknown) => {
        console.error("[nextbase] deleting stored files failed:", error);
      }),
    );
  }

  /**
   * Handles any request under `basePath`: a web-standard Request in, a
   * Response out, so any framework that speaks the Fetch API can mount it.
   * Bound, so safe to pass around. For Next.js, see `newNextHandler()` in
   * `@nextbasejs/next`.
   */
  readonly handle: RouteHandler = (request) =>
    this.#dispatch(request, { http: true });

  /**
   * Routes a request. Only `client()` passes a `principal`, which HTTP
   * requests cannot reach: theirs always comes from their own credentials.
   */
  async #dispatch(
    request: Request,
    { principal, http }: { principal?: Principal | undefined; http: boolean },
  ): Promise<Response> {
    const { pathname } = new URL(request.url);
    const basePath = this.#basePath;
    if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) {
      return api(new ApiError(404, "Not found.").toResponse());
    }
    const route = pathname.slice(basePath.length) || "/";
    // Next.js answers HEAD with the GET handler and drops the body.
    const verb = request.method === "HEAD" ? "GET" : request.method;

    if (verb === "GET" && route === "/health") {
      return api(Response.json({ status: "ok" } satisfies HealthResponse));
    }
    // Served at `/_` without redirects: Next.js strips trailing slashes by
    // default, so redirecting to `/_/` would loop. The UI uses hash routing.
    if (verb === "GET" && (route === "/_" || route === "/_/")) {
      return new Response(adminHtml, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "x-frame-options": "DENY",
          "x-content-type-options": "nosniff",
          "referrer-policy": "same-origin",
        },
      });
    }

    for (const { method, pattern, handler } of ROUTES) {
      const match = verb === method ? pattern.exec(route) : null;
      if (!match) continue;
      let setCookie: string | undefined;
      // Emails and file cleanup that wait for the request's outcome.
      const effects = new Effects();
      const response = await (async (): Promise<Response> => {
        let db: DB | undefined;
        let schema: Schema | undefined;
        try {
          await this.migrate();
          db = this.#connection();
          schema = await this.#schema.get(db);
          // The log shows a URL to call, which in-process requests do not have.
          if (http) await this.#announceSetup(db, new URL(request.url));
          const params = match.slice(1).map((p) => decodeURIComponent(p));
          let caller = principal;
          if (!caller) {
            // Server components cannot set cookies, so in-process reads
            // neither renew sessions nor remove a stale cookie.
            const resolved = await resolvePrincipal(request, db, schema, {
              extend: http,
            });
            caller = resolved.principal;
            if (http) setCookie = resolved.setCookie;
          }
          // Browsers attach the cookie to other sites' requests too, so writes
          // through it must come from this site. In-process calls are server code.
          if (http && verb !== "GET" && caller.viaCookie) {
            checkSameOrigin(request, this.#origins);
          }
          const response = await handler({
            request,
            params,
            db,
            schema,
            principal: caller,
            inProcess: !http,
            statementTimeout: this.#statementTimeout,
            origins: this.#origins,
            mailer: this.#mailer,
            sms: this.#sms,
            oauth2: this.#oauth2,
            rejectBreachedPasswords: this.#rejectBreachedPasswords,
            effects,
            storage: this.#storage,
          });
          for (const mail of effects.mail) {
            this.#mailer.send(mail.kind, mail.collection, mail.to);
          }
          this.#deleteFiles(effects.obsoleteFiles);
          return response;
        } catch (error) {
          // The request's database changes rolled back; so do its files.
          this.#deleteFiles(effects.newFiles);
          const code = (error as { code?: unknown }).code as string;
          const raced =
            SCHEMA_RACE.has(code) &&
            db !== undefined &&
            schema !== undefined &&
            (await schemaChanged(db, schema.version));
          return errorResponse(error, raced);
        }
      })();
      // Renewing the caller's session must not override a sign-in or
      // sign-out of this response, which already set the cookie.
      const setsSession = response.headers
        .getSetCookie()
        .some((c) =>
          Object.values(SESSION_COOKIES).some((n) => c.startsWith(`${n}=`)),
        );
      if (setCookie && !setsSession) {
        response.headers.append("set-cookie", setCookie);
      }
      return api(response);
    }

    // A path that exists, asked with a method it does not take, answers 405
    // and lists the methods it does take in the Allow header.
    const allowed = new Set(
      ROUTES.filter((r) => r.pattern.test(route)).map((r) => r.method),
    );
    if (route === "/health" || route === "/_" || route === "/_/") {
      allowed.add("GET");
    }
    if (allowed.size > 0) {
      if (allowed.has("GET")) allowed.add("HEAD");
      return api(
        new ApiError(
          405,
          `${request.method} is not allowed here.`,
          {},
          { allow: [...allowed].join(", ") },
        ).toResponse(),
      );
    }
    return api(new ApiError(404, "Not found.").toResponse());
  }
}

/**
 * Headers every API response carries. Responses depend on who is asking,
 * including through the session cookie, which shared caches cannot see, so
 * nothing may store them; and browsers must not guess another content type,
 * which could turn a JSON response into a page that runs scripts.
 */
function api(response: Response): Response {
  if (!response.headers.has("cache-control")) {
    response.headers.set("cache-control", "no-store");
  }
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}

/** Whether another instance changed the schema since `version`. */
async function schemaChanged(db: DB, version: number): Promise<boolean> {
  try {
    return (await readSchemaVersion(db)) > version;
  } catch {
    return false;
  }
}

function errorResponse(error: unknown, schemaRaced: boolean): Response {
  if (error instanceof ApiError) return error.toResponse();
  // decodeURIComponent on a malformed escape such as `%E0`.
  if (error instanceof URIError)
    return new ApiError(400, "The URL is malformed.").toResponse();
  if (
    schemaRaced ||
    RETRYABLE.has((error as { code?: unknown }).code as string)
  ) {
    return new ApiError(
      409,
      "The request conflicted with a concurrent change. Retry it.",
    ).toResponse();
  }
  console.error("[nextbase] request failed:", error);
  // query_canceled: statementTimeout, or a cancel from an administrator.
  if ((error as { code?: unknown }).code === "57014") {
    return new ApiError(
      500,
      "The request took too long and was stopped.",
    ).toResponse();
  }
  return new ApiError(
    500,
    "Something went wrong while processing the request.",
  ).toResponse();
}

/**
 * Copies the session cookie a response sets or removes, on signing in or out,
 * into Next.js's cookie store. Next.js allows that in server actions and
 * route handlers, not while rendering server components.
 */
function applySessionCookie(cookies: CookieStore, response: Response): void {
  const names: ReadonlySet<string> = new Set(Object.values(SESSION_COOKIES));
  for (const header of response.headers.getSetCookie()) {
    const [pair = "", ...attributes] = header.split("; ");
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator);
    if (!names.has(name)) continue;
    const maxAge = Number(
      attributes.find((a) => a.startsWith("Max-Age="))?.slice(8) ?? 0,
    );
    cookies.set?.(name, pair.slice(separator + 1), {
      path: "/",
      maxAge,
      httpOnly: true,
      sameSite: "lax",
      secure: attributes.includes("Secure"),
    });
  }
}
