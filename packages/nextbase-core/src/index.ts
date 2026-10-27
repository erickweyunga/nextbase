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
import {
  readSchemaVersion,
  SCHEMA_RACE,
  type Schema,
  SchemaCache,
} from "./schema/cache.ts";

// Serialization failures and deadlocks: retrying the transaction can fix them.
const RETRYABLE: ReadonlySet<string> = new Set(["40001", "40P01"]);

const DEFAULT_STATEMENT_TIMEOUT = 8_000;

// Origin of in-process requests from `client()`; never fetched.
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
 * Whether a request has a session cookie, unverified: for optimistic redirects
 * in `proxy.ts`. It proves nothing; collection rules still protect the data.
 */
export function hasSessionCookie(request: Request): boolean {
  return sessionCookie(request) !== undefined;
}

export interface NextBaseOptions {
  /** Path the route handler is mounted at. Defaults to `/api/nextbase`. */
  basePath?: string;
  /**
   * Connection string or `pg.Pool`-compatible pool. Defaults to
   * `process.env.DATABASE_URL`. A pool you pass in stays yours to end.
   */
  database?: string | Pool;
  /**
   * Max milliseconds per records API statement, so an expensive filter cannot
   * hold the database. Defaults to 8000; 0 turns it off.
   */
  statementTimeout?: number;
  /**
   * Other hosts allowed to write via the session cookie: `app.example.com`,
   * `*.example.com` (one label) or `**.example.com`.
   */
  trustedOrigins?: string[];
  /** Read the host from X-Forwarded-Host; enable only behind your own proxy. Defaults to false. */
  trustProxy?: boolean;
  /**
   * Your app's URL for email links and OAuth2 redirects, never taken from the
   * spoofable Host header. HTTPS, except on localhost.
   */
  appUrl?: string;
  /** Sends auth emails. Without it, production answers 400; dev logs them. */
  mail?: MailOptions;
  /** Local disk by default, or `{ s3: { bucket, ... } }`. Use a bucket on serverless hosts. */
  storage?: StorageOptions;
  /** Sends phone sign-in codes. Without it, production answers 400; dev logs them. */
  sms?: SmsOptions;
  /**
   * Reject new passwords found in known breaches, via Have I Been Pwned (only a
   * 5-character SHA-1 prefix is sent; accepts if unreachable). Defaults to false.
   */
  rejectBreachedPasswords?: boolean;
  /**
   * OAuth2 providers by name: `google`, `github`, or any OpenID Connect `issuer`.
   * Requires `appUrl`; the redirect URI is `{appUrl origin}{basePath}/callback/{name}`.
   */
  oauth2?: OAuth2Options;
  /**
   * Keeps background work alive on serverless. Defaults to Vercel's waitUntil
   * (a no-op elsewhere); on Next.js you can pass `after` from `next/server`.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** The part of Next.js's `cookies()` store `client()` uses; `set` lets sign-in/out update it. */
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
  /** Bypass every rule. Trusted server code only: never let user input steer it. */
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
   * Creates or upgrades NextBase's tables, once per instance (retried after a
   * failure). Requests do this on their own; call it to migrate ahead of traffic.
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

  // Lazy: `next build` evaluates route modules without a database.
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

  /** Creates a superuser at any time, for scripts; never expose it to untrusted input. */
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

  // The setup token goes to server logs, which only the owner can read, so a
  // stranger who finds a fresh deployment first cannot claim it.
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
   * The verified session of a request's cookie or Bearer token, or null; for
   * `proxy.ts`. Never extends the session or sets cookies. It hits the database,
   * so match only routes that need it; `hasSessionCookie()` does not.
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
   * An in-process client with the same routing, rules and output as HTTP. With
   * `cookies`, it acts as that session's user and sign-in/out updates the cookie.
   * Create one per request; never share a signed-in client between users.
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

  // A failure only leaves an unused file, so it is just logged.
  #deleteFiles(keys: readonly string[]): void {
    if (keys.length === 0) return;
    this.#waitUntil(
      this.#storage.delete(keys).catch((error: unknown) => {
        console.error("[nextbase] deleting stored files failed:", error);
      }),
    );
  }

  /**
   * Handles any Fetch API request under `basePath`; bound, so safe to pass
   * around. For Next.js, use `newNextHandler()` from `@nextbasejs/next`.
   */
  readonly handle: RouteHandler = (request) =>
    this.#dispatch(request, { http: true });

  // Only `client()` passes a `principal`; HTTP requests always use their own credentials.
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
    // No redirect to `/_/`: Next.js strips trailing slashes, so it would loop.
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
      const effects = new Effects();
      const response = await (async (): Promise<Response> => {
        let db: DB | undefined;
        let schema: Schema | undefined;
        try {
          await this.migrate();
          db = this.#connection();
          let caller = principal;
          if (caller) {
            schema = await this.#schema.get(db);
          } else {
            // This also loads the schema, in the same query as the session.
            // Server components cannot set cookies, so in-process reads
            // neither renew sessions nor remove a stale cookie.
            const resolved = await resolvePrincipal(request, db, this.#schema, {
              extend: http,
            });
            schema = resolved.schema;
            caller = resolved.principal;
            if (http) setCookie = resolved.setCookie;
          }
          // The log shows a URL to call, which in-process requests do not have.
          if (http) await this.#announceSetup(db, new URL(request.url));
          const params = match.slice(1).map((p) => decodeURIComponent(p));
          // Browsers send the cookie on cross-site requests too, so cookie writes
          // must be same-origin.
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
          this.#deleteFiles(effects.newFiles);
          const code = (error as { code?: unknown }).code as string;
          // A missing table or column can be retried only if the schema changed meanwhile.
          const raced =
            SCHEMA_RACE.has(code) &&
            db !== undefined &&
            schema !== undefined &&
            (await schemaChanged(db, schema.version));
          return errorResponse(error, raced);
        }
      })();
      // Session renewal must not override a sign-in or sign-out in this response.
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

    // Known path, wrong method: 405 with an Allow header.
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
 * No caching: responses depend on the cookie, which shared caches cannot see.
 * No sniffing: it could turn a JSON response into a page that runs scripts.
 */
function api(response: Response): Response {
  if (!response.headers.has("cache-control")) {
    response.headers.set("cache-control", "no-store");
  }
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}

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

// Next.js allows setting cookies in server actions and route handlers only.
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
