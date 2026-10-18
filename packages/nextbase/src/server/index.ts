import adminHtml from "@nextbase/admin/index.html?raw";
import { DB, type Pool } from "@nextbase/dbx";
import { AuthStore } from "../client/auth-store.ts";
import { NextBaseClient } from "../client/index.ts";
import { DEFAULT_BASE_PATH, type HealthResponse } from "../shared/api.ts";
import type { AuthCollection } from "../shared/schema.ts";
import { ROUTES } from "./api/routes.ts";
import { type Principal, resolvePrincipal } from "./auth/principal.ts";
import {
  hasSuperuser,
  insertSuperuser,
  setupToken,
} from "./auth/superusers.ts";
import { migrate } from "./db/migrations.ts";
import { sharedPool } from "./db/pool.ts";
import { TYPES } from "./db/types.ts";
import { ApiError } from "./errors.ts";
import { SchemaCache } from "./schema/cache.ts";

/**
 * Postgres errors a retry can fix: serialization failures and deadlocks, and a
 * table or column that a concurrent schema change renamed or dropped after
 * this request read the schema.
 */
const RETRYABLE: ReadonlySet<string> = new Set([
  "40001",
  "40P01",
  "42P01",
  "42703",
]);

// Origin of in-process requests from `client()`. Never resolved or fetched.
const IN_PROCESS_ORIGIN = "http://nextbase.internal";

// While no superuser exists, the setup token is logged at most this often.
const SETUP_LOG_INTERVAL_MS = 60_000;

export type { Pool } from "@nextbase/dbx";
export type {
  ApiErrorBody,
  ErrorData,
  FieldError,
  HealthResponse,
} from "../shared/api.ts";

export interface NextBaseOptions {
  /** Path the route handler is mounted at. Defaults to `/api/nextbase`. */
  basePath?: string;
  /**
   * A Postgres connection string, or a `pg.Pool`-compatible pool such as one
   * from `@neondatabase/serverless`. Defaults to `process.env.DATABASE_URL`.
   * A pool you pass in stays yours to end.
   */
  database?: string | Pool;
}

export interface ServerClientOptions {
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
  #db: DB | undefined;
  #migrated: Promise<void> | undefined;
  readonly #schema = new SchemaCache();
  #superuserExists = false;
  #setupLoggedAt = Number.NEGATIVE_INFINITY;

  /**
   * Exports for `app/api/nextbase/[...path]/route.ts`. Safe to destructure:
   * every handler is bound to this instance.
   */
  readonly handlers: {
    GET: RouteHandler;
    POST: RouteHandler;
    PATCH: RouteHandler;
    DELETE: RouteHandler;
  };

  constructor(options: NextBaseOptions = {}) {
    this.#basePath = (options.basePath ?? DEFAULT_BASE_PATH).replace(
      /\/+$/,
      "",
    );
    this.#database = options.database;
    this.handlers = {
      GET: this.handle,
      POST: this.handle,
      PATCH: this.handle,
      DELETE: this.handle,
    };
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
   * A client SDK instance for server code that calls this instance in-process:
   * no network hop, but the same routing, validation, rules and output as
   * HTTP. Signed out unless `superuser` is set; to act as a user, sign in or
   * save their token in its `authStore`. Create one per request, never share
   * a signed-in client between users.
   */
  client(options: ServerClientOptions = {}): NextBaseClient {
    const principal: Principal | undefined = options.superuser
      ? { superuser: true }
      : undefined;
    return new NextBaseClient({
      baseUrl: `${IN_PROCESS_ORIGIN}${this.#basePath}`,
      fetch: async (input, init) =>
        this.#dispatch(new Request(input, init), { principal, http: false }),
      authStore: new AuthStore({ storage: null }),
    });
  }

  /** Handles any request under `basePath`. Bound, so safe to pass around. */
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
      return new ApiError(404, "Not found.").toResponse();
    }
    const route = pathname.slice(basePath.length) || "/";
    // Next.js answers HEAD with the GET handler and drops the body.
    const verb = request.method === "HEAD" ? "GET" : request.method;

    if (verb === "GET" && route === "/health") {
      return Response.json({ status: "ok" } satisfies HealthResponse);
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
      try {
        await this.migrate();
        const db = this.#connection();
        const schema = await this.#schema.get(db);
        // The log shows a URL to call, which in-process requests do not have.
        if (http) await this.#announceSetup(db, new URL(request.url));
        const params = match.slice(1).map((p) => decodeURIComponent(p));
        return await handler({
          request,
          params,
          db,
          schema,
          principal: principal ?? (await resolvePrincipal(request, db, schema)),
        });
      } catch (error) {
        if (error instanceof ApiError) return error.toResponse();
        // decodeURIComponent on a malformed escape such as `%E0`.
        if (error instanceof URIError)
          return new ApiError(400, "The URL is malformed.").toResponse();
        if (RETRYABLE.has((error as { code?: unknown }).code as string)) {
          return new ApiError(
            409,
            "The request conflicted with a concurrent change. Retry it.",
          ).toResponse();
        }
        console.error("[nextbase] request failed:", error);
        return new ApiError(
          500,
          "Something went wrong while processing the request.",
        ).toResponse();
      }
    }
    return new ApiError(404, "Not found.").toResponse();
  }
}
