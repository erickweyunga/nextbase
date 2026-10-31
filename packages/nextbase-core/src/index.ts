import adminHtml from '@nextbasejs/admin/index.html?raw';
import type {
  AuthCollection,
  RecordModel,
  TotpSetup,
} from '@nextbasejs/client';
import {
  AuthStore,
  ClientError,
  type CurrentSession,
  DEFAULT_BASE_PATH,
  type HealthResponse,
  NextBaseClient,
} from '@nextbasejs/client';
import { DB, hash, type Pool, type Row, type Tx } from '@nextbasejs/dbx';
import { waitUntil as vercelWaitUntil } from '@vercel/functions';
import { beginRoute, ROUTES, type Route } from './api/routes.ts';
import { checkAppUrl } from './app-url.ts';
import { findByEmail } from './auth/identity.ts';
import { Mailer, type MailOptions } from './auth/mail.ts';
import { checkPassword, Mfa, resetMfa } from './auth/mfa.ts';
import {
  type AccessTokenModel,
  OAuth2,
  type OAuth2Options,
} from './auth/oauth2.ts';
import { Passkeys } from './auth/passkeys.ts';
import { type Principal, resolvePrincipal } from './auth/principal.ts';
import { SecretKeys, secretKeysFromEnv } from './auth/secret-keys.ts';
import {
  bearerToken,
  checkSameOrigin,
  IMPERSONATOR_COOKIES,
  MFA_COOKIES,
  type OriginPolicy,
  SESSION_COOKIES,
  sessionCookie,
} from './auth/sessions.ts';
import { Sms, type SmsOptions } from './auth/sms.ts';
import {
  hasSuperuser,
  insertSuperuser,
  setupToken,
} from './auth/superusers.ts';
import type { ValidateSignIn } from './auth/validate.ts';
import {
  type ClientIp,
  type ClientIpOption,
  clientIpReader,
} from './client-ip.ts';
import { migrate } from './db/migrations.ts';
import { sharedPool } from './db/pool.ts';
import { table } from './db/system.ts';
import { TYPES } from './db/types.ts';
import { Effects } from './effects.ts';
import { ApiError } from './errors.ts';
import {
  newStorage,
  type Storage,
  type StorageOptions,
} from './files/storage.ts';
import { hasThumbs, Thumbs, thumbsPrefix } from './files/thumbs.ts';
import { Logger, type LogsOptions } from './logs/logger.ts';
import { type RequestOutcome, requestEntry } from './logs/request.ts';
import {
  type Limited,
  RateLimits,
  type RateLimitsOptions,
} from './rate-limits.ts';
import { Realtime, type RealtimeOptions } from './realtime/stream.ts';
import {
  Hooks,
  type Join,
  type JoinedClient,
  type RecordHooks,
} from './records/hooks.ts';
import {
  readSchemaVersion,
  SCHEMA_RACE,
  type Schema,
  SchemaCache,
} from './schema/cache.ts';

// Serialization failures and deadlocks: retrying the transaction can fix them.
const RETRYABLE: ReadonlySet<string> = new Set(['40001', '40P01']);

const DEFAULT_STATEMENT_TIMEOUT = 8_000;

/** Set to `none` on responses to requests that had no session. */
const SESSION_HEADER = 'nextbase-session';

// Host of in-process requests from `client()`; never fetched.
const IN_PROCESS_HOST = 'nextbase.internal';

// While no superuser exists, the setup token is logged at most this often.
const SETUP_LOG_INTERVAL_MS = 60_000;

// How deep writes through `e.nextbase` in on hooks may nest, so a hook that
// writes the records that fire it fails instead of looping forever.
const MAX_HOOK_DEPTH = 8;

const SUPERUSER: Principal = { superuser: true };

// Routes whose first parameter is a collection.
const COLLECTION_PATH = /^\/(?:collections|files)\//;

export type {
  ApiErrorBody,
  AuthMethods,
  AuthProvider,
  CurrentSession,
  ErrorData,
  FieldError,
  HealthResponse,
  LinkedAccountModel,
  MfaConfig,
  MfaRequired,
  MfaStatus,
  RecoveryCodes,
  SignInMethod,
  TotpSetup,
} from '@nextbasejs/client';
export type { Pool } from '@nextbasejs/dbx';
export type {
  MailContext,
  MailKind,
  MailMessage,
  MailOptions,
  MailTemplate,
} from './auth/mail.ts';
export type {
  AccessTokenModel,
  OAuth2Options,
  OAuth2ProviderOptions,
} from './auth/oauth2.ts';
export type {
  SmsContext,
  SmsKind,
  SmsMessage,
  SmsOptions,
  SmsTemplate,
} from './auth/sms.ts';
export type {
  SignInCheck,
  SignInRefusal,
  ValidateSignIn,
} from './auth/validate.ts';
export type { ClientIpOption } from './client-ip.ts';
export { ApiError } from './errors.ts';
export type { S3StorageOptions, StorageOptions } from './files/storage.ts';
export type { LogsOptions } from './logs/logger.ts';
export type { RateLimitRule, RateLimitsOptions } from './rate-limits.ts';
export type { RealtimeOptions } from './realtime/stream.ts';
export type {
  BeforeCreateEvent,
  BeforeDeleteEvent,
  BeforeUpdateEvent,
  CollectionHooks,
  HookAuthCollection,
  HookCollection,
  HookPrincipal,
  HookRequest,
  HookSource,
  RecordEvent,
  RecordHooks,
  UpdateEvent,
} from './records/hooks.ts';

/**
 * Whether a request has a session cookie, unverified: for optimistic redirects
 * in `proxy.ts`. It proves nothing; collection rules still protect the data.
 */
export function hasSessionCookie(request: Request): boolean {
  return sessionCookie(request) !== undefined;
}

/** Record types by collection name, such as `Collections` from `nextbase typegen`. */
type Collections = Record<string, RecordModel>;

export interface NextBaseOptions<C extends Collections = Collections> {
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
   * Encrypts secrets NextBase reads back: base64 of 32 random bytes. Pass several to
   * rotate (first encrypts). Defaults to `NEXTBASE_SECRET_KEY`, comma-separated.
   */
  secretKey?: string | string[];
  /**
   * Reject new passwords found in known breaches, via Have I Been Pwned (only a
   * 5-character SHA-1 prefix is sent; accepts if unreachable). Defaults to false.
   */
  rejectBreachedPasswords?: boolean;
  /**
   * Decides who may sign up, link OAuth2, or sign in, by every method: return
   * `{ error, message }` to refuse. OAuth2 sees the current profile at each sign-in.
   */
  validateSignIn?: ValidateSignIn;
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
  /**
   * Hooks on record writes by collection, or `"*"`: before the write is checked,
   * in its transaction, or in the background after commit.
   */
  hooks?: RecordHooks<NoInfer<C>>;
  /**
   * Lets clients subscribe to records as they are created, updated and
   * deleted: `true` for every collection, or `{ collections: [...] }`.
   */
  realtime?: true | RealtimeOptions<NoInfer<keyof C & string>>;
  /**
   * Logs HTTP requests and background failures, for superusers via `/logs`.
   * On by default, kept 7 days; `false` turns it off.
   */
  logs?: false | LogsOptions;
  /**
   * Where the client's IP comes from, for logs and rate limits. Defaults to
   * `"vercel"` on Vercel; elsewhere unknown unless you name your proxy's header.
   */
  clientIp?: ClientIpOption;
  /**
   * Limits requests per caller, counted in the database: signed-in callers per
   * record, guests per IP from `clientIp`. On by default; `false` turns it off.
   */
  rateLimits?: false | RateLimitsOptions;
}

/**
 * The part of Next.js's `cookies()` store `client()` uses; `set` lets sign-in,
 * sign-out and session renewal update it.
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
      sameSite: 'lax';
      secure: boolean;
    },
  ): unknown;
}

export interface ServerClientOptions {
  /** Act as the user signed in through the session cookie: `await cookies()`. */
  cookies?: CookieStore;
  /**
   * Whether the page was requested over HTTPS, which names the session
   * cookie outside production. Defaults to whether the secure cookie is set.
   */
  secure?: boolean;
  /** Bypass every rule. Trusted server code only: never let user input steer it. */
  superuser?: boolean;
}

export type RouteHandler = (request: Request) => Promise<Response>;

/**
 * NextBase in your app. `C` maps collection names to record types, such as
 * `Collections` from `nextbase typegen`.
 */
export class NextBase<C extends Collections = Collections> {
  readonly #basePath: string;
  readonly #database: string | Pool | undefined;
  readonly #statementTimeout: number;
  readonly #origins: OriginPolicy;
  readonly #mailer: Mailer;
  readonly #oauth2: OAuth2;
  readonly #sms: Sms;
  readonly #mfa: Mfa;
  readonly #passkeys: Passkeys;
  readonly #rejectBreachedPasswords: boolean;
  readonly #validateSignIn: ValidateSignIn | undefined;
  readonly #storage: Storage;
  readonly #thumbs: Thumbs;
  readonly #waitUntil: (promise: Promise<unknown>) => void;
  readonly #appUrl: URL | undefined;
  readonly #hooks: Hooks;
  readonly #realtime: Realtime | undefined;
  readonly #logger: Logger;
  readonly #clientIp: ClientIp;
  readonly #rateLimits: RateLimits | undefined;
  /** Work running after responses, such as after hooks and emails. */
  readonly #background = new Set<Promise<unknown>>();
  #db: DB | undefined;
  #migrated: Promise<void> | undefined;
  readonly #schema = new SchemaCache();
  #superuserExists = false;
  #setupLoggedAt = Number.NEGATIVE_INFINITY;

  constructor(options: NextBaseOptions<C> = {}) {
    const basePath = options.basePath ?? DEFAULT_BASE_PATH;
    // Requests are matched on their URL's pathname, so any other form, such
    // as one without the leading slash, would match nothing.
    if (
      !basePath.startsWith('/') ||
      new URL(basePath, `http://${IN_PROCESS_HOST}`).pathname !== basePath
    ) {
      throw new TypeError(
        `basePath must be an absolute URL path such as "${DEFAULT_BASE_PATH}", not ${JSON.stringify(basePath)}.`,
      );
    }
    this.#basePath = basePath.replace(/\/+$/, '');
    this.#database = options.database;
    this.#rejectBreachedPasswords = options.rejectBreachedPasswords ?? false;
    if (
      options.validateSignIn !== undefined &&
      typeof options.validateSignIn !== 'function'
    ) {
      throw new TypeError('validateSignIn must be a function.');
    }
    this.#validateSignIn = options.validateSignIn;
    const appUrl =
      options.appUrl === undefined ? undefined : checkAppUrl(options.appUrl);
    this.#waitUntil = keepingAlive(
      options.waitUntil ?? vercelWaitUntil,
      this.#background,
    );
    this.#logger = new Logger(options.logs, {
      db: () => this.#connection(),
      ready: () => this.migrate(),
      waitUntil: this.#waitUntil,
    });
    this.#clientIp = clientIpReader(options.clientIp);
    this.#rateLimits =
      options.rateLimits === false
        ? undefined
        : new RateLimits(options.rateLimits ?? {}, {
            logger: this.#logger,
            waitUntil: this.#waitUntil,
          });
    this.#mailer = new Mailer(
      options.mail,
      appUrl,
      this.#waitUntil,
      this.#logger,
    );
    this.#sms = new Sms(options.sms, this.#waitUntil, this.#logger);
    this.#storage = newStorage(options.storage);
    this.#thumbs = new Thumbs(this.#storage, this.#logger);
    this.#appUrl =
      appUrl ??
      (options.mail?.appUrl === undefined
        ? undefined
        : checkAppUrl(options.mail.appUrl, 'mail.appUrl'));
    const secretKeys = new SecretKeys(
      options.secretKey ?? secretKeysFromEnv(process.env.NEXTBASE_SECRET_KEY),
    );
    this.#oauth2 = new OAuth2(
      options.oauth2,
      this.#appUrl,
      this.#basePath,
      secretKeys,
    );
    this.#mfa = new Mfa({
      secretKeys,
      mailer: this.#mailer,
      sms: this.#sms,
      issuer: this.#appUrl?.hostname ?? 'NextBase',
      oauth2: this.#oauth2.list().length > 0,
    });
    this.#passkeys = new Passkeys(this.#appUrl, this.#mailer);
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
        'statementTimeout must be a whole number of milliseconds, or 0.',
      );
    }
    this.#realtime = options.realtime
      ? new Realtime(options.realtime as true | RealtimeOptions, {
          db: () => this.#connection(),
          database:
            typeof options.database === 'string' ? options.database : undefined,
          schemas: this.#schema,
          waitUntil: this.#waitUntil,
          logger: this.#logger,
        })
      : undefined;
    this.#hooks = new Hooks(
      options.hooks as RecordHooks | undefined,
      {
        chained: (chain) => this.#chained(chain),
        joined: (join) => this.#joined(join),
      },
      this.#logger,
      this.#realtime,
    );
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

  /**
   * Waits for work running after responses, then writes pending log entries. Call it
   * before ending a pool you passed in or before exit, so no entry is lost.
   */
  async flush(): Promise<void> {
    for (;;) {
      if (this.#background.size > 0) {
        await Promise.allSettled([...this.#background]);
        continue;
      }
      await this.#logger.flush();
      if (this.#background.size === 0) return;
    }
  }

  // Lazy: `next build` evaluates route modules without a database.
  #connection(): DB {
    if (this.#db) return this.#db;
    const database = this.#database ?? process.env.DATABASE_URL;
    if (database === undefined || database === '') {
      throw new Error(
        'NextBase needs a database: set DATABASE_URL or pass the `database` option.',
      );
    }
    this.#db = new DB(
      typeof database === 'string' ? sharedPool(database) : database,
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
      schema.get('_superusers') as AuthCollection,
      email,
      password,
    );
  }

  // The setup token goes to server logs, which only the owner can read. The URL comes
  // from the options, never from the spoofable Host header.
  async #announceSetup(db: DB): Promise<void> {
    if (this.#superuserExists) return;
    if (await hasSuperuser(db)) {
      this.#superuserExists = true;
      return;
    }
    if (Date.now() - this.#setupLoggedAt < SETUP_LOG_INTERVAL_MS) return;
    this.#setupLoggedAt = Date.now();
    const token = await setupToken(db);
    const origin = this.#appUrl?.origin ?? 'https://<your app>';
    console.info(
      `[nextbase] No superuser exists yet. Within the next hour, create one with:\n` +
        `  curl -X POST ${origin}${this.#basePath}/setup -H 'content-type: application/json' \\\n` +
        `    -d '{"token":"${token}","email":"you@example.com","password":"a long password"}'`,
    );
  }

  /**
   * Removes a superuser's authenticator app and recovery codes; false when no such
   * email. For scripts; never expose it to untrusted input.
   */
  async resetSuperuserMfa(email: string): Promise<boolean> {
    const found = await this.#superuser(email);
    if (!found) return false;
    await resetMfa(found.db, '_superusers', found.record.id as string);
    return true;
  }

  /**
   * Starts a superuser's authenticator app setup without their password; confirm with
   * `confirmSuperuserTotp`. For scripts; never expose it to untrusted input.
   */
  async startSuperuserTotp(email: string): Promise<TotpSetup | undefined> {
    const found = await this.#superuser(email);
    if (!found) return undefined;
    return this.#mfa.startTotpTrusted(found.db, found.collection, found.record);
  }

  /**
   * Turns on the app `startSuperuserTotp` set up with a code from it, and
   * returns the recovery codes. Every session of the superuser ends.
   */
  async confirmSuperuserTotp(email: string, code: string): Promise<string[]> {
    const found = await this.#superuser(email);
    if (!found) throw new ApiError(404, 'No superuser has this email.');
    return this.#mfa.confirmTotp(
      found.db,
      found.collection,
      found.record,
      undefined,
      code,
    );
  }

  /**
   * The access token of a linked account at a provider with `storeTokens`, refreshed
   * when due or when `refresh`, for server code that calls the provider's API.
   */
  async getAccessToken(
    collectionName: string,
    recordId: string,
    provider: string,
    options: { refresh?: boolean } = {},
  ): Promise<AccessTokenModel> {
    await this.migrate();
    const db = this.#connection();
    const collection = (await this.#schema.get(db)).get(collectionName);
    if (collection.type !== 'auth') {
      throw new TypeError(`${collectionName} is not an auth collection.`);
    }
    return this.#oauth2.accessToken(
      db,
      collection,
      recordId,
      provider,
      options,
    );
  }

  /**
   * Whether `password` is the record's current one, for confirming sensitive actions.
   * Counted like a sign-in: too many wrong ones throw a 429.
   */
  async verifyPassword(
    collectionName: string,
    recordId: string,
    password: string,
  ): Promise<boolean> {
    await this.migrate();
    const db = this.#connection();
    const collection = (await this.#schema.get(db)).get(collectionName);
    if (collection.type !== 'auth') {
      throw new TypeError(`${collectionName} is not an auth collection.`);
    }
    const [record] = await db
      .select()
      .from(table(collection.name))
      .where(hash({ id: recordId }))
      .all();
    if (!record) return false;
    try {
      await checkPassword(db, collection, record, password);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) return false;
      throw error;
    }
  }

  async #superuser(
    email: string,
  ): Promise<{ db: DB; collection: AuthCollection; record: Row } | undefined> {
    await this.migrate();
    const db = this.#connection();
    const schema = await this.#schema.get(db);
    const collection = schema.get('_superusers') as AuthCollection;
    const record = await findByEmail(db, collection, email);
    return record && { db, collection, record };
  }

  /**
   * The verified session of a request, or null, for `proxy.ts`. Never extends it or
   * sets cookies; it hits the database, unlike `hasSessionCookie()`.
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
   * An in-process client with the same routing, rules and output as HTTP. Create one
   * per request; never share a signed-in client between users.
   */
  client(options: ServerClientOptions = {}): NextBaseClient<C> {
    const principal = options.superuser ? SUPERUSER : undefined;
    // In-process requests take the page's scheme, so they read and set the cookie the
    // browser sends.
    const secure =
      process.env.NODE_ENV === 'production' ||
      (options.secure ??
        options.cookies?.get(SESSION_COOKIES.secure) !== undefined);
    const { cookies } = options;
    // Next.js throws on cookie writes outside server actions and route
    // handlers, as in server components, and sessions are then not renewed.
    const writeCookie =
      cookies?.set &&
      ((header: string): boolean => {
        try {
          writeSessionCookie(cookies, header);
          return true;
        } catch {
          return false;
        }
      });
    return new NextBaseClient<C>({
      baseUrl: `${secure ? 'https' : 'http'}://${IN_PROCESS_HOST}${this.#basePath}`,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        // As fetch does, an aborted signal rejects before anything is sent.
        request.signal.throwIfAborted();
        // The session, and the superuser's kept while they impersonate.
        const sent = [
          secure ? SESSION_COOKIES.secure : SESSION_COOKIES.plain,
          secure ? IMPERSONATOR_COOKIES.secure : IMPERSONATOR_COOKIES.plain,
          // A sign-in's second step, after an OAuth2 first step.
          secure ? MFA_COOKIES.secure : MFA_COOKIES.plain,
        ].flatMap((name) => {
          const value = cookies?.get(name)?.value;
          return value ? [`${name}=${value}`] : [];
        });
        if (sent.length > 0) request.headers.set('cookie', sent.join('; '));
        const response = this.#dispatch(request, {
          principal,
          http: false,
          writeCookie,
        }).then((response) => {
          if (cookies) applySessionCookie(cookies, response);
          return response;
        });
        return abortable(response, request.signal);
      },
      authStore: new AuthStore({ storage: null }),
    });
  }

  /**
   * The superuser client of an on hook. Requests run one at a time, since savepoints
   * of one transaction nest, and it closes once the hook returns.
   */
  #joined(join: Join): JoinedClient {
    let queue: Promise<unknown> = Promise.resolve();
    let pending = 0;
    let open = true;
    const hook = join.chain.at(-1);
    const client = new NextBaseClient<C>({
      baseUrl: `http://${IN_PROCESS_HOST}${this.#basePath}`,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        request.signal.throwIfAborted();
        if (!open) {
          throw new Error(
            `e.nextbase was used after the ${hook} hook returned. Await its requests in the hook.`,
          );
        }
        checkHookDepth(join.chain);
        pending++;
        const response = queue.then(() =>
          this.#dispatch(request, { http: false, join }),
        );
        const done = (): void => {
          pending--;
        };
        queue = response.then(done, done);
        return abortable(response, request.signal);
      },
      authStore: new AuthStore({ storage: null }),
    });
    return {
      client: client as NextBaseClient<Collections>,
      close: async () => {
        open = false;
        if (pending === 0) return false;
        await queue;
        return true;
      },
    };
  }

  /**
   * The superuser client of an after hook. Requests carry the hooks that led to them,
   * so an after hook that fires itself stops as an on hook would.
   */
  #chained(chain: readonly string[]): NextBaseClient<Collections> {
    const client = new NextBaseClient<C>({
      baseUrl: `http://${IN_PROCESS_HOST}${this.#basePath}`,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        request.signal.throwIfAborted();
        checkHookDepth(chain);
        return abortable(
          this.#dispatch(request, {
            principal: SUPERUSER,
            http: false,
            chain,
          }),
          request.signal,
        );
      },
      authStore: new AuthStore({ storage: null }),
    });
    return client as NextBaseClient<Collections>;
  }

  /**
   * Does the work of the request's committed writes. It takes the work out,
   * so a request that fails while doing it does none of it twice.
   */
  #finish({ committed }: Effects): void {
    const mail = committed.mail.splice(0);
    const obsoleteFiles = committed.obsoleteFiles.splice(0);
    const hooks = committed.hooks.splice(0);
    for (const note of mail) {
      this.#mailer.send(note.kind, note.collection, note.to);
    }
    this.#deleteFiles(obsoleteFiles);
    this.#runAfterHooks(hooks);
  }

  /** Runs after hooks in the background, in the order their writes happened. */
  #runAfterHooks(hooks: readonly (() => Promise<void>)[]): void {
    if (hooks.length === 0) return;
    this.#waitUntil(
      (async () => {
        for (const run of hooks) await run();
      })().catch((error: unknown) => {
        this.#logger.failure('hook', 'running after hooks failed', error);
      }),
    );
  }

  // A failure only leaves an unused file, so it is just logged.
  #deleteFiles(keys: readonly string[]): void {
    if (keys.length === 0) return;
    const storage = this.#storage;
    this.#waitUntil(
      (async () => {
        await storage.delete(keys);
        // Thumbnails after their files: one made meanwhile is either deleted here or finds
        // its file gone and deletes itself.
        await Promise.all(
          keys
            .filter(hasThumbs)
            .map((key) => storage.deletePrefix(thumbsPrefix(key))),
        );
      })().catch((error: unknown) => {
        this.#logger.failure('storage', 'deleting stored files failed', error);
      }),
    );
  }

  /**
   * Handles any Fetch API request under `basePath`; bound, so safe to pass
   * around. For Next.js, use `newNextHandler()` from `@nextbasejs/next`.
   */
  readonly handle: RouteHandler = async (request) => {
    const started = performance.now();
    const trace: Trace = {};
    const response = await this.#dispatch(request, { http: true, trace });
    // Logging never changes the response.
    try {
      this.#logRequest(request, response.status, started, trace);
    } catch (error) {
      console.error('[nextbase] logging a request failed:', error);
    }
    return response;
  };

  /**
   * Skips successful health checks, admin pages and log reads, which would fill
   * the log with itself.
   */
  #logRequest(
    request: Request,
    status: number,
    started: number,
    trace: Trace,
  ): void {
    const config = this.#logger.config;
    if (!config) return;
    // Requests outside basePath are not NextBase's: anyone could fill the
    // log with them.
    if (trace.route === undefined) return;
    if (status < 400 && quietRoute(request.method, trace.route)) return;
    const outcome: RequestOutcome = {
      status,
      execTime: Math.round((performance.now() - started) * 100) / 100,
      principal: trace.principal,
      failure: trace.failure,
      unexpected: trace.unexpected,
      noted: trace.noted,
      authId: config.authId,
      ip: config.ip ? this.#clientIp(request) : undefined,
    };
    const { level, message, data } = requestEntry(request, outcome);
    this.#logger.add(level, message, data);
  }

  /**
   * Opens a route's transaction and returns it with the current schema. If
   * the schema changed since it was cached, it is reloaded first.
   */
  async #beginRoute(db: DB): Promise<{ tx: Tx; schema: Schema }> {
    for (;;) {
      const tx = await beginRoute(db, this.#statementTimeout);
      const version = Number(tx.startRows[0]?.schema_version);
      const cached = this.#schema.cached;
      if (cached && cached.version >= version) return { tx, schema: cached };
      // The reload uses another connection, so this one is closed first.
      await tx.rollback();
      await this.#schema.get(db, version);
    }
  }

  /**
   * Looks up the collection only when a rule needs it, in the cached schema if any:
   * outdated by a rename at worst until the next request reads it.
   */
  async #limited(
    db: DB,
    route: Route,
    method: string,
    path: string,
    params: readonly string[],
    schema: Schema | undefined,
  ): Promise<Limited> {
    const tags = route.tags ?? [];
    const limited: Limited = {
      method,
      route: path,
      tags,
      collection: undefined,
    };
    if (!this.#rateLimits?.needsCollection(tags)) return limited;
    const idOrName = params[0];
    if (idOrName === undefined || !COLLECTION_PATH.test(path)) return limited;
    const current =
      schema ?? this.#schema.cached ?? (await this.#schema.get(db));
    return { ...limited, collection: current.find(idOrName) };
  }

  /** What every route gets from this instance. */
  #services() {
    return {
      statementTimeout: this.#statementTimeout,
      origins: this.#origins,
      mailer: this.#mailer,
      sms: this.#sms,
      oauth2: this.#oauth2,
      mfa: this.#mfa,
      passkeys: this.#passkeys,
      validateSignIn: this.#validateSignIn,
      rejectBreachedPasswords: this.#rejectBreachedPasswords,
      storage: this.#storage,
      thumbs: this.#thumbs,
      hooks: this.#hooks,
      realtime: this.#realtime,
      logger: this.#logger,
    };
  }

  /**
   * Runs an on hook's `e.nextbase` request in a savepoint, as a superuser. A failure
   * undoes only its own writes; after hooks wait for the outer write's commit.
   */
  async #joinRoute(
    route: Route,
    match: RegExpExecArray,
    request: Request,
    join: Join,
  ): Promise<Response> {
    if (!route.joinsTransaction) {
      return new ApiError(
        400,
        'In an on hook, e.nextbase can only list, view, create, update and delete records, or send a batch.',
      ).toResponse();
    }
    const effects = new Effects();
    try {
      const params = match.slice(1).map((p) => decodeURIComponent(p));
      const response = await join.tx.transaction((tx) =>
        route.handler({
          ...this.#services(),
          request,
          params,
          db: this.#connection(),
          schema: join.schema,
          principal: SUPERUSER,
          inProcess: true,
          tx,
          effects,
          hookChain: join.chain,
          noteError: () => {},
          rateLimit: async () => {},
        }),
      );
      join.effects.absorb(effects);
      return response;
    } catch (error) {
      this.#deleteFiles(effects.newFiles);
      return failed(error, false).toResponse();
    }
  }

  // Only `client()` passes a `principal`; HTTP requests always use their own
  // credentials.
  async #dispatch(
    request: Request,
    {
      principal,
      http,
      writeCookie,
      join,
      chain = [],
      trace = {},
    }: {
      principal?: Principal | undefined;
      http: boolean;
      writeCookie?: ((header: string) => boolean) | undefined;
      join?: Join;
      chain?: readonly string[];
      trace?: Trace;
    },
  ): Promise<Response> {
    const fail = (error: ApiError): Response => {
      trace.failure = error;
      return api(error.toResponse());
    };
    const { pathname } = new URL(request.url);
    const basePath = this.#basePath;
    if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) {
      return fail(new ApiError(404, 'Not found.'));
    }
    const route = pathname.slice(basePath.length) || '/';
    trace.route = route;
    // Next.js answers HEAD with the GET handler and drops the body.
    const verb = request.method === 'HEAD' ? 'GET' : request.method;

    if (verb === 'GET' && route === '/health') {
      return api(Response.json({ status: 'ok' } satisfies HealthResponse));
    }
    // No redirect to `/_/`: Next.js strips trailing slashes, so it would loop.
    if (verb === 'GET' && (route === '/_' || route === '/_/')) {
      return new Response(adminHtml, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'x-frame-options': 'DENY',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'same-origin',
        },
      });
    }

    for (const matched of ROUTES) {
      const { method, pattern, transaction, stream, handler } = matched;
      const match = verb === method ? pattern.exec(route) : null;
      if (!match) continue;
      if (join)
        return api(await this.#joinRoute(matched, match, request, join));
      let setCookie: string | undefined;
      let signedOut = false;
      const effects = new Effects();
      const response = await (async (): Promise<Response> => {
        let db: DB | undefined;
        let schema: Schema | undefined;
        let tx: Tx | undefined;
        try {
          await this.migrate();
          db = this.#connection();
          const params = match.slice(1).map((p) => decodeURIComponent(p));
          const connection = db;
          // Rate limits apply to HTTP requests only: in-process requests
          // come from the app itself.
          const rateLimit = async (
            caller: Principal,
            requests?: readonly Limited[],
          ): Promise<void> => {
            if (!http || !this.#rateLimits) return;
            await this.#rateLimits.check(
              connection,
              { principal: caller, ip: this.#clientIp(request) },
              requests ?? [
                await this.#limited(
                  connection,
                  matched,
                  verb,
                  route,
                  params,
                  schema,
                ),
              ],
            );
          };
          let caller = principal;
          if (!caller) {
            // In-process requests renew a cookie session only where the cookie can be written.
            // A stream's response is sent before it ends, so it renews none.
            const resolved = await resolvePrincipal(request, db, this.#schema, {
              extend: http && !stream,
              writeCookie: stream ? undefined : writeCookie,
            }).catch(async (error: unknown) => {
              // An invalid token cost a lookup too, so it counts, as a
              // guest's request.
              if (error instanceof ApiError && error.status === 401) {
                await rateLimit({ superuser: false });
              }
              throw error;
            });
            schema = resolved.schema;
            caller = resolved.principal;
            trace.principal = caller;
            if (http) setCookie = resolved.setCookie;
            signedOut = http && !caller.record;
          }
          // Before the route's transaction, in its own autocommit statement, so refusals
          // stay counted whatever the route would have done.
          const counted = caller;
          if (!matched.countsItself) await rateLimit(counted);
          // In-process requests come from the app itself, not from someone
          // setting it up.
          if (http) await this.#announceSetup(db);
          // Browsers send the cookie on cross-site requests too, so cookie writes
          // must be same-origin.
          if (http && verb !== 'GET' && caller.viaCookie) {
            checkSameOrigin(request, this.#origins);
          }
          if (transaction) {
            ({ tx, schema } = await this.#beginRoute(db));
          } else {
            schema ??= await this.#schema.get(db);
          }
          const response = await handler({
            ...this.#services(),
            request,
            params,
            db,
            schema,
            principal: caller,
            inProcess: !http,
            ...(tx && { tx }),
            effects,
            hookChain: chain,
            noteError: (error) => {
              trace.noted = error;
            },
            rateLimit: (requests) => rateLimit(counted, requests),
          });
          await tx?.commit();
          effects.commit();
          this.#finish(effects);
          return response;
        } catch (error) {
          // If the rollback fails, the connection is closed. The error to
          // report is the one that caused the rollback.
          if (tx && !tx.done) await tx.rollback().catch(() => {});
          this.#deleteFiles(effects.newFiles);
          // Writes the request committed before it failed keep their work.
          this.#finish(effects);
          const code = (error as { code?: unknown }).code as string;
          // A missing table or column can be retried only if the schema changed meanwhile.
          const raced =
            SCHEMA_RACE.has(code) &&
            db !== undefined &&
            schema !== undefined &&
            (await schemaChanged(db, schema.version));
          const failure = failed(error, raced);
          trace.failure = failure;
          if (!(error instanceof ApiError) && failure.status === 500) {
            trace.unexpected = error;
          }
          return failure.toResponse();
        }
      })();
      // Session renewal must not override a sign-in or sign-out in this response.
      const setsSession = response.headers
        .getSetCookie()
        .some((c) =>
          Object.values(SESSION_COOKIES).some((n) => c.startsWith(`${n}=`)),
        );
      if (setCookie && !setsSession) {
        response.headers.append('set-cookie', setCookie);
      }
      // The cookie is HttpOnly and an ended one is just ignored, so this tells the
      // browser the request had no session.
      if (signedOut && !setsSession) {
        response.headers.set(SESSION_HEADER, 'none');
      }
      return api(response);
    }

    // Known path, wrong method: 405 with an Allow header.
    const allowed = new Set(
      ROUTES.filter((r) => r.pattern.test(route)).map((r) => r.method),
    );
    if (route === '/health' || route === '/_' || route === '/_/') {
      allowed.add('GET');
    }
    if (allowed.size > 0) {
      if (allowed.has('GET')) allowed.add('HEAD');
      return fail(
        new ApiError(
          405,
          `${request.method} is not allowed here.`,
          {},
          { allow: [...allowed].join(', ') },
        ),
      );
    }
    return fail(new ApiError(404, 'Not found.'));
  }
}

/** What an HTTP request's log entry needs from its dispatch. */
interface Trace {
  /** The path below `basePath`, once the request is under it. */
  route?: string;
  principal?: Principal;
  failure?: ApiError;
  unexpected?: unknown;
  /** An error the route answered without an error status. */
  noted?: string;
}

/**
 * Reads whose successful requests are not logged. Deleting the logs is
 * logged, so the log shows it was emptied.
 */
function quietRoute(method: string, route: string): boolean {
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    return false;
  }
  return (
    route === '/health' ||
    route === '/_' ||
    route === '/_/' ||
    route === '/logs' ||
    route.startsWith('/logs/')
  );
}

/**
 * No caching: responses depend on the cookie, and a shared cache may store one
 * that sets a cookie (RFC 9111 7.3). No sniffing: JSON could run as a page.
 */
function api(response: Response): Response {
  if (response.headers.getSetCookie().length > 0) {
    response.headers.set('cache-control', 'private, no-store');
  } else if (!response.headers.has('cache-control')) {
    response.headers.set('cache-control', 'no-store');
  }
  response.headers.set('x-content-type-options', 'nosniff');
  return response;
}

/** Refuses a request through `e.nextbase` past MAX_HOOK_DEPTH hooks deep. */
function checkHookDepth(chain: readonly string[]): void {
  if (chain.length > MAX_HOOK_DEPTH) {
    throw new Error(
      `Writes through e.nextbase in hooks nest more than ${MAX_HOOK_DEPTH} deep: ${chain.join(' > ')}. A hook may be writing the records that fire it.`,
    );
  }
}

async function schemaChanged(db: DB, version: number): Promise<boolean> {
  try {
    return (await readSchemaVersion(db)) > version;
  } catch {
    return false;
  }
}

/** The error a failed request answers with. */
function failed(error: unknown, schemaRaced: boolean): ApiError {
  if (error instanceof ApiError) return error;
  // decodeURIComponent on a malformed escape such as `%E0`.
  if (error instanceof URIError)
    return new ApiError(400, 'The URL is malformed.');
  if (
    schemaRaced ||
    RETRYABLE.has((error as { code?: unknown }).code as string)
  ) {
    return new ApiError(
      409,
      'The request conflicted with a concurrent change. Retry it.',
    );
  }
  console.error('[nextbase] request failed:', error);
  // query_canceled: statementTimeout, or a cancel from an administrator.
  if ((error as { code?: unknown }).code === '57014') {
    return new ApiError(500, 'The request took too long and was stopped.');
  }
  return new ApiError(
    500,
    'Something went wrong while processing the request.',
  );
}

// Next.js allows setting cookies in server actions and route handlers only.
function applySessionCookie(cookies: CookieStore, response: Response): void {
  for (const header of response.headers.getSetCookie()) {
    writeSessionCookie(cookies, header);
  }
}

const SESSION_COOKIE_NAMES: ReadonlySet<string> = new Set([
  ...Object.values(SESSION_COOKIES),
  ...Object.values(IMPERSONATOR_COOKIES),
  ...Object.values(MFA_COOKIES),
]);

/** Writes a session cookie's Set-Cookie header, or the kept impersonator one, to the store; other cookies are left out. */
function writeSessionCookie(cookies: CookieStore, header: string): void {
  const [pair = '', ...attributes] = header.split('; ');
  const separator = pair.indexOf('=');
  const name = pair.slice(0, separator);
  if (!SESSION_COOKIE_NAMES.has(name)) return;
  const maxAge = Number(
    attributes.find((a) => a.startsWith('Max-Age='))?.slice(8) ?? 0,
  );
  cookies.set?.(name, pair.slice(separator + 1), {
    path: '/',
    maxAge,
    httpOnly: true,
    sameSite: 'lax',
    secure: attributes.includes('Secure'),
  });
}

/**
 * Settles as `fetch` would with this signal: rejected with its reason once it
 * aborts. As over HTTP, work the request started may still finish.
 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

/**
 * Never throws: the work is already running, so a `waitUntil` that cannot take
 * it only means it may be cut short on serverless.
 */
function keepingAlive(
  waitUntil: (promise: Promise<unknown>) => void,
  running: Set<Promise<unknown>>,
): (promise: Promise<unknown>) => void {
  return (promise) => {
    // Kept until it settles, for `flush()`.
    running.add(promise);
    const done = (): void => {
      running.delete(promise);
    };
    promise.then(done, done);
    try {
      waitUntil(promise);
    } catch (error) {
      console.error('[nextbase] waitUntil refused background work:', error);
    }
  };
}
