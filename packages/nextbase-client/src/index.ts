import { AuthStore } from './auth-store.ts';
import { authSync } from './auth-sync.ts';
import { Batch } from './batch.ts';
import { ClientError } from './client-error.ts';
import { CollectionService } from './collections.ts';
import { FileService } from './files.ts';
import { type FilterValue, filter } from './filter.ts';
import { LogService } from './logs.ts';
import { RealtimeService } from './realtime.ts';
import { RecordService } from './records.ts';
import {
  type ApiErrorBody,
  type AuthResponse,
  type CurrentSession,
  DEFAULT_BASE_PATH,
  type HealthResponse,
  type RecordModel,
  type SessionModel,
  type SetupStatus,
} from './shared/api.ts';

export {
  type AuthChangeListener,
  type AuthStorage,
  AuthStore,
  type AuthStoreOptions,
} from './auth-store.ts';
export type {
  Batch,
  BatchCollection,
  BatchResult,
  BatchWriteOptions,
} from './batch.ts';
export { ClientError, isMfaRequired } from './client-error.ts';
export type { CollectionInput, CollectionService } from './collections.ts';
export type { FileService, FileUrlOptions } from './files.ts';
export { type FilterValue, filter } from './filter.ts';
export type { LogListOptions, LogService, LogStatsOptions } from './logs.ts';
export type {
  RealtimeAction,
  RealtimeEvent,
  RealtimeService,
  SubscribeOptions,
} from './realtime.ts';
export type {
  AccessToken,
  AuthOptions,
  FullListOptions,
  ImpersonateOptions,
  ListOptions,
  OAuth2LinkOptions,
  OAuth2Options,
  RecordOptions,
  RecordService,
  SecondStepOptions,
  SignUpPending,
  StepUpOptions,
} from './records.ts';
export type {
  ApiErrorBody,
  AuthMethods,
  AuthProvider,
  AuthResponse,
  CurrentSession,
  ErrorData,
  FieldError,
  HealthResponse,
  ImpersonateResponse,
  LinkedAccountModel,
  ListResult,
  LogModel,
  LogStat,
  MfaRequired,
  MfaStatus,
  RecordModel,
  RecoveryCodes,
  SessionModel,
  SetupStatus,
  SignInMethod,
  TotpSetup,
} from './shared/api.ts';
export { DEFAULT_BASE_PATH } from './shared/api.ts';
export type {
  AuthCollection,
  AutodateField,
  BaseCollection,
  BoolField,
  Collection,
  DateField,
  EmailField,
  EmailVerificationConfig,
  Field,
  FieldType,
  FileField,
  Index,
  JsonField,
  MfaConfig,
  NumberField,
  OtpConfig,
  PasswordField,
  PhoneField,
  RelationField,
  Rule,
  SelectField,
  TextField,
  TokenConfig,
  TokenType,
  UrlField,
  ViewCollection,
} from './shared/schema.ts';

export interface ClientOptions {
  /** URL of the NextBase route handler. Defaults to `/api/nextbase`. */
  baseUrl?: string;
  /** Custom fetch, e.g. to call the handler in-process on the server. */
  fetch?: typeof globalThis.fetch;
  /** Defaults to `localStorage` in the browser and memory elsewhere. */
  authStore?: AuthStore;
}

type QueryValue = string | number | boolean | null | undefined;

/** Per-request options, including fetch's own such as `signal` or `cache`. */
export interface SendOptions
  extends Omit<RequestInit, 'body' | 'method' | 'headers'> {
  method?: string;
  /** Query parameters; `null` and `undefined` values are left out. */
  query?: Record<string, QueryValue>;
  headers?: Record<string, string>;
  /** Sent as JSON unless it is already a fetch body. */
  body?: unknown;
}

/**
 * The NextBase SDK. `Schema` maps collection names to record types (e.g. the
 * `Collections` type from `nextbase typegen`) so `collection("posts")` is typed.
 */
export class NextBaseClient<
  Schema extends Record<string, RecordModel> = Record<never, RecordModel>,
> {
  readonly authStore: AuthStore;
  /** Collection definitions. Superusers only. */
  readonly collections: CollectionService;
  /** File URLs and tokens for protected files. */
  readonly files: FileService;
  /** The server's request and error log. Superusers only. */
  readonly logs: LogService;
  /**
   * Realtime subscriptions, all over one streamed request. Subscribe with
   * `collection(name).subscribe()`.
   */
  readonly realtime: RealtimeService;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: ClientOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_PATH).replace(/\/+$/, '');
    // Called unbound: browsers throw "Illegal invocation" otherwise.
    const fetch = options.fetch ?? globalThis.fetch;
    this.#fetch = (input, init) => fetch(input, init);
    this.authStore = options.authStore ?? new AuthStore();
    this.collections = new CollectionService(this);
    this.files = new FileService(this);
    this.logs = new LogService(this);
    this.realtime = new RealtimeService(this, (init) =>
      this.#fetch(this.#url('/realtime'), init),
    );
  }

  /** Records of one collection, by name or id. */
  collection<N extends keyof Schema & string>(
    name: N,
  ): RecordService<Schema[N]>;
  collection<T extends RecordModel = RecordModel>(
    idOrName: string,
  ): RecordService<T>;
  collection(idOrName: string): RecordService<RecordModel> {
    return new RecordService(this, idOrName);
  }

  /**
   * A client of the same server, signed in through `authStore` instead,
   * such as one acting as another account.
   */
  withAuthStore(authStore: AuthStore): NextBaseClient<Schema> {
    return new NextBaseClient<Schema>({
      baseUrl: this.#baseUrl,
      fetch: this.#fetch,
      authStore,
    });
  }

  /** Starts a batch of record writes applied all or nothing. */
  createBatch(): Batch {
    return new Batch(this);
  }

  /** {@inheritDoc filter} */
  filter(
    expression: string,
    params?: Readonly<Record<string, FilterValue>>,
  ): string {
    return filter(expression, params);
  }

  health(options?: SendOptions): Promise<HealthResponse> {
    return this.send('/health', options);
  }

  /** Whether the first superuser still has to be created. */
  setupStatus(options?: SendOptions): Promise<SetupStatus> {
    return this.send('/setup', options);
  }

  /** Creates the first superuser with the setup token from the server log. Does not sign in. */
  setup(
    params: { token: string; email: string; password: string },
    options?: SendOptions,
  ): Promise<RecordModel> {
    return this.send('/setup', { ...options, method: 'POST', body: params });
  }

  /**
   * The current session, or null. Updates the auth store, so call it on startup with
   * cookie sessions, which scripts cannot read; a store changed meanwhile is kept.
   */
  async getSession<T extends RecordModel = RecordModel>(
    options?: SendOptions,
  ): Promise<CurrentSession<T> | null> {
    const unchanged = authSync(this.authStore).snapshot();
    const session = await this.send<CurrentSession<T> | null>(
      '/session',
      options,
    );
    if (!unchanged()) return session;
    if (session) this.authStore.save(this.authStore.token, session.record);
    else if (this.authStore.isValid) this.authStore.clear();
    return session;
  }

  /**
   * Clears the auth store unless a sign-in started meanwhile saved a new session.
   * Ending a cookie impersonation signs the superuser back in.
   */
  async signOut(options?: SendOptions): Promise<void> {
    const apply = authSync(this.authStore).intent();
    let restored: AuthResponse | undefined;
    try {
      restored = await this.send<AuthResponse | undefined>('/session', {
        ...options,
        method: 'DELETE',
      });
    } finally {
      apply(() => {
        if (restored) this.authStore.save('', restored.record);
        else this.authStore.clear();
      });
    }
  }

  /** The signed-in record's live sessions, newest first. */
  async listSessions(options?: SendOptions): Promise<SessionModel[]> {
    return (await this.send<{ items: SessionModel[] }>('/sessions', options))
      .items;
  }

  /** Ends every session of the signed-in record except this one. */
  async revokeOtherSessions(options?: SendOptions): Promise<void> {
    await this.send('/sessions', { ...options, method: 'DELETE' });
  }

  /** Ends one of the signed-in record's sessions. */
  async revokeSession(id: string, options?: SendOptions): Promise<void> {
    await this.send(`/sessions/${encodeURIComponent(id)}`, {
      ...options,
      method: 'DELETE',
    });
  }

  /**
   * Sends an authenticated request to `path` and returns the parsed JSON (undefined
   * for 204). Throws {@link ClientError}; a 401 on a signed-in request signs out.
   */
  async send<T>(path: string, options: SendOptions = {}): Promise<T> {
    const { query, headers: extraHeaders, body, ...init } = options;
    const { token, record } = this.authStore;
    const unchanged = authSync(this.authStore).snapshot();
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    let payload: RequestInit['body'];
    if (body !== undefined) {
      if (isBodyInit(body)) {
        payload = body;
      } else {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body);
      }
    }
    Object.assign(headers, extraHeaders);

    let response: Response;
    try {
      response = await this.#fetch(this.#url(path, query), {
        ...init,
        headers,
        body: payload,
      });
    } catch (cause) {
      throw new ClientError(
        { status: 0, message: errorMessage(cause), data: {} },
        { cause, signal: init.signal },
      );
    }

    let parsed: unknown;
    try {
      const text = await response.text();
      parsed = text === '' ? undefined : JSON.parse(text);
    } catch (cause) {
      // Aborted while the body arrived: no response, as above.
      if (init.signal?.aborted) {
        throw new ClientError(
          { status: 0, message: errorMessage(cause), data: {} },
          { cause, signal: init.signal },
        );
      }
      throw new ClientError(
        {
          status: response.ok ? 0 : response.status,
          message: response.ok
            ? 'The server sent an invalid response.'
            : `The request failed with status ${response.status}.`,
          data: {},
        },
        { cause },
      );
    }

    // A cookie session that ended: scripts cannot read its cookie, so the server
    // says so. Skipped if the store changed while the request was in flight.
    if (
      unchanged() &&
      token === '' &&
      record !== null &&
      response.headers.get('nextbase-session') === 'none'
    ) {
      this.authStore.clear();
    }
    if (response.ok) return parsed as T;
    // A first sign-in step that needs a second one says nothing about the
    // session in the store.
    if (
      response.status === 401 &&
      (token !== '' || record !== null) &&
      unchanged() &&
      !(isErrorBody(parsed) && typeof parsed.mfaId === 'string')
    ) {
      this.authStore.clear();
    }
    throw new ClientError(
      isErrorBody(parsed)
        ? parsed
        : {
            status: response.status,
            message: `The request failed with status ${response.status}.`,
            data: {},
          },
    );
  }

  /** The full URL of `path`, for links and redirects such as an OAuth2 sign-in. */
  buildUrl(path: string, query: Record<string, QueryValue> = {}): string {
    return this.#url(path, query);
  }

  #url(path: string, query: Record<string, QueryValue> = {}): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined) params.set(key, String(value));
    }
    const search = params.size > 0 ? `?${params}` : '';
    return `${this.#baseUrl}${path}${search}`;
  }
}

function isBodyInit(value: unknown): value is NonNullable<RequestInit['body']> {
  return (
    typeof value === 'string' ||
    value instanceof FormData ||
    value instanceof URLSearchParams ||
    value instanceof Blob ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof ReadableStream
  );
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as ApiErrorBody).status === 'number' &&
    typeof (value as ApiErrorBody).message === 'string' &&
    typeof (value as ApiErrorBody).data === 'object'
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'The request failed.';
}
