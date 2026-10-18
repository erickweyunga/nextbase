import {
  type ApiErrorBody,
  DEFAULT_BASE_PATH,
  type HealthResponse,
  type RecordModel,
  type SetupStatus,
} from "../shared/api.ts";
import { AuthStore } from "./auth-store.ts";
import { ClientError } from "./client-error.ts";
import { CollectionService } from "./collections.ts";
import { type FilterValue, filter } from "./filter.ts";
import { RecordService } from "./records.ts";

export type {
  ApiErrorBody,
  AuthResponse,
  ErrorData,
  FieldError,
  HealthResponse,
  ListResult,
  RecordModel,
  SetupStatus,
} from "../shared/api.ts";
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
  RelationField,
  Rule,
  SelectField,
  TextField,
  TokenConfig,
  TokenType,
  UrlField,
} from "../shared/schema.ts";
export {
  type AuthChangeListener,
  type AuthStorage,
  AuthStore,
  type AuthStoreOptions,
} from "./auth-store.ts";
export { ClientError } from "./client-error.ts";
export type { CollectionInput, CollectionService } from "./collections.ts";
export { type FilterValue, filter } from "./filter.ts";
export type {
  FullListOptions,
  ListOptions,
  RecordOptions,
  RecordService,
} from "./records.ts";

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

export class NextBaseClient {
  readonly authStore: AuthStore;
  /** Collection definitions. Superusers only. */
  readonly collections: CollectionService;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: ClientOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_PATH).replace(/\/+$/, "");
    // Called unbound: browsers throw "Illegal invocation" otherwise.
    const fetch = options.fetch ?? globalThis.fetch;
    this.#fetch = (input, init) => fetch(input, init);
    this.authStore = options.authStore ?? new AuthStore();
    this.collections = new CollectionService(this);
  }

  /** Records of one collection, by name or id. */
  collection<T extends RecordModel = RecordModel>(
    idOrName: string,
  ): RecordService<T> {
    return new RecordService<T>(this, idOrName);
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
   * Sign in afterwards with `collection("_superusers").authWithPassword()`.
   */
  setup(
    params: { token: string; email: string; password: string },
    options?: SendOptions,
  ): Promise<RecordModel> {
    return this.send("/setup", { ...options, method: "POST", body: params });
  }

  /**
   * Sends a request to `path` below the base URL with the current auth token,
   * and returns the parsed JSON body (undefined for 204). Throws
   * {@link ClientError} for anything else. A 401 to a signed-in request signs
   * out, since the token is no longer accepted.
   */
  async send<T>(path: string, options: SendOptions = {}): Promise<T> {
    const { query, headers: extraHeaders, body, ...init } = options;
    const token = this.authStore.token;
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
    if (response.status === 401 && token && token === this.authStore.token) {
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
