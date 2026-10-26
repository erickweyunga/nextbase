import { AuthStore } from "./auth-store.ts";
import { Batch } from "./batch.ts";
import { ClientError } from "./client-error.ts";
import { CollectionService } from "./collections.ts";
import { FileService } from "./files.ts";
import { type FilterValue, filter } from "./filter.ts";
import { RecordService } from "./records.ts";
import {
  type ApiErrorBody,
  type CurrentSession,
  DEFAULT_BASE_PATH,
  type HealthResponse,
  type RecordModel,
  type SessionModel,
  type SetupStatus,
} from "./shared/api.ts";

export {
  type AuthChangeListener,
  type AuthStorage,
  AuthStore,
  type AuthStoreOptions,
} from "./auth-store.ts";
export type {
  Batch,
  BatchCollection,
  BatchResult,
  BatchWriteOptions,
} from "./batch.ts";
export { ClientError } from "./client-error.ts";
export type { CollectionInput, CollectionService } from "./collections.ts";
export type { FileService, FileUrlOptions } from "./files.ts";
export { type FilterValue, filter } from "./filter.ts";
export type {
  AuthOptions,
  FullListOptions,
  ListOptions,
  OAuth2Options,
  RecordOptions,
  RecordService,
} from "./records.ts";
export type {
  ApiErrorBody,
  AuthMethods,
  AuthProvider,
  AuthResponse,
  CurrentSession,
  ErrorData,
  FieldError,
  HealthResponse,
  LinkedAccountModel,
  ListResult,
  RecordModel,
  SessionModel,
  SetupStatus,
} from "./shared/api.ts";
export { DEFAULT_BASE_PATH } from "./shared/api.ts";
export type {
  AuthCollection,
  AutodateField,
  BaseCollection,
  BoolField,
  Collection,
  DateField,
  EmailField,
  Field,
  FieldType,
  FileField,
  Index,
  JsonField,
  NumberField,
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
} from "./shared/schema.ts";

export interface ClientOptions {
  /** URL of the NextBase route handler. Defaults to `/api/nextbase`. */
  baseUrl?: string;
  /** Custom fetch, e.g. to call the handler in-process on the server. */
  fetch?: typeof globalThis.fetch;
  /** Defaults to a store persisted in `localStorage` in the browser, in memory elsewhere. */
  authStore?: AuthStore;
}

type QueryValue = string | number | boolean | null | undefined;

/** Options every request takes, including fetch's own, such as `signal` or `cache`. */
export interface SendOptions
  extends Omit<RequestInit, "body" | "method" | "headers"> {
  method?: string;
  /** Query parameters; `null` and `undefined` values are left out. */
  query?: Record<string, QueryValue>;
  headers?: Record<string, string>;
  /** Sent as JSON, unless it is already a body fetch understands. */
  body?: unknown;
}

/**
 * The NextBase SDK. `Schema` maps collection names to their record types,
 * such as the `Collections` type `nextbase typegen` writes, so
 * `collection("posts")` is typed without annotations.
 */
export class NextBaseClient<
  Schema extends Record<string, RecordModel> = Record<never, RecordModel>,
> {
  readonly authStore: AuthStore;
  /** Collection definitions. Superusers only. */
  readonly collections: CollectionService;
  /** Uploaded files: their URLs, and tokens for protected ones. */
  readonly files: FileService;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: ClientOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_PATH).replace(/\/+$/, "");
    // Called unbound: browsers throw "Illegal invocation" otherwise.
    const fetch = options.fetch ?? globalThis.fetch;
    this.#fetch = (input, init) => fetch(input, init);
    this.authStore = options.authStore ?? new AuthStore();
    this.collections = new CollectionService(this);
    this.files = new FileService(this);
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

  /** Starts a batch of record writes that are saved together or not at all. */
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
    return this.send("/health", options);
  }

  /** Whether the first superuser still has to be created. */
  setupStatus(options?: SendOptions): Promise<SetupStatus> {
    return this.send("/setup", options);
  }

  /**
   * Creates the first superuser with the setup token from the server log.
   * Sign in afterwards with `collection("_superusers").signInWithPassword()`.
   */
  setup(
    params: { token: string; email: string; password: string },
    options?: SendOptions,
  ): Promise<RecordModel> {
    return this.send("/setup", { ...options, method: "POST", body: params });
  }

  /**
   * The caller's current session and record, or null when signed out. Also
   * updates the auth store, so call it on startup with cookie sessions,
   * which scripts cannot inspect.
   */
  async getSession<T extends RecordModel = RecordModel>(
    options?: SendOptions,
  ): Promise<CurrentSession<T> | null> {
    const session = await this.send<CurrentSession<T> | null>(
      "/session",
      options,
    );
    if (session) this.authStore.save(this.authStore.token, session.record);
    else if (this.authStore.isValid) this.authStore.clear();
    return session;
  }

  /** Ends the current session on the server, removes its cookie, and clears the auth store. */
  async signOut(options?: SendOptions): Promise<void> {
    try {
      await this.send("/session", { ...options, method: "DELETE" });
    } finally {
      this.authStore.clear();
    }
  }

  /** The signed-in record's live sessions, newest first. */
  async listSessions(options?: SendOptions): Promise<SessionModel[]> {
    return (await this.send<{ items: SessionModel[] }>("/sessions", options))
      .items;
  }

  /** Ends every session of the signed-in record except this one. */
  async revokeOtherSessions(options?: SendOptions): Promise<void> {
    await this.send("/sessions", { ...options, method: "DELETE" });
  }

  /** Ends one of the signed-in record's sessions, such as a lost device. */
  async revokeSession(id: string, options?: SendOptions): Promise<void> {
    await this.send(`/sessions/${encodeURIComponent(id)}`, {
      ...options,
      method: "DELETE",
    });
  }

  /**
   * Sends a request to `path` below the base URL with the current auth token,
   * and returns the parsed JSON body (undefined for 204). Throws
   * {@link ClientError} for anything else. A 401 to a signed-in request signs
   * out, since the token is no longer accepted.
   */
  async send<T>(path: string, options: SendOptions = {}): Promise<T> {
    const { query, headers: extraHeaders, body, ...init } = options;
    const { token, record } = this.authStore;
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    let payload: RequestInit["body"];
    if (body !== undefined) {
      if (isBodyInit(body)) {
        payload = body;
      } else {
        headers["content-type"] = "application/json";
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
        { cause },
      );
    }

    let parsed: unknown;
    try {
      const text = await response.text();
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch (cause) {
      throw new ClientError(
        {
          status: response.ok ? 0 : response.status,
          message: response.ok
            ? "The server sent an invalid response."
            : `The request failed with status ${response.status}.`,
          data: {},
        },
        { cause },
      );
    }

    if (response.ok) return parsed as T;
    // Signed out by the server: unless the store changed meanwhile.
    if (
      response.status === 401 &&
      (token !== "" || record !== null) &&
      token === this.authStore.token &&
      record === this.authStore.record
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

  /**
   * The URL of `path` below the base URL, for links and redirects that
   * leave the SDK, such as an OAuth2 sign-in.
   */
  buildUrl(path: string, query: Record<string, QueryValue> = {}): string {
    return this.#url(path, query);
  }

  #url(path: string, query: Record<string, QueryValue> = {}): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined) params.set(key, String(value));
    }
    const search = params.size > 0 ? `?${params}` : "";
    return `${this.#baseUrl}${path}${search}`;
  }
}

function isBodyInit(value: unknown): value is NonNullable<RequestInit["body"]> {
  return (
    typeof value === "string" ||
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
    typeof value === "object" &&
    typeof (value as ApiErrorBody).status === "number" &&
    typeof (value as ApiErrorBody).message === "string" &&
    typeof (value as ApiErrorBody).data === "object"
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The request failed.";
}
