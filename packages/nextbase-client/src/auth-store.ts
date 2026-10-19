import type { RecordModel } from "./shared/api.ts";

/** Where an auth store keeps its state. `localStorage` fits; so does any object like it. */
export interface AuthStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AuthStoreOptions {
  /**
   * Defaults to `localStorage` in the browser. Pass `null` to keep the state
   * in memory only, as on the server, where one store must never be shared
   * between users.
   */
  storage?: AuthStorage | null;
  /** Storage key. Defaults to `nextbase_auth`. */
  key?: string;
}

export type AuthChangeListener = (
  token: string,
  record: RecordModel | null,
) => void;

// The parts of a browser's globals the store uses. The package is typed
// without the DOM library, since most of it runs on the server.
interface BrowserGlobals {
  document?: unknown;
  localStorage?: AuthStorage;
  addEventListener?(
    type: "storage",
    listener: (event: { key: string | null; newValue: string | null }) => void,
  ): void;
}

const browser = globalThis as BrowserGlobals;

const DEFAULT_KEY = "nextbase_auth";
const SUPERUSERS = "_superusers";

/** The signed-in record and its token, kept in sync with storage and other tabs. */
export class AuthStore {
  #token = "";
  #record: RecordModel | null = null;
  readonly #storage: AuthStorage | null;
  readonly #key: string;
  readonly #listeners = new Set<AuthChangeListener>();

  constructor(options: AuthStoreOptions = {}) {
    this.#storage =
      options.storage === undefined ? browserStorage() : options.storage;
    this.#key = options.key ?? DEFAULT_KEY;
    this.#load(this.#read());
    // Another tab signed in or out.
    if (this.#storage && this.#storage === browserStorage()) {
      browser.addEventListener?.("storage", (event) => {
        if (event.key !== this.#key) return;
        this.#load(event.newValue);
        this.#notify();
      });
    }
  }

  get token(): string {
    return this.#token;
  }

  get record(): RecordModel | null {
    return this.#record;
  }

  /**
   * Whether the client believes it is signed in: it holds a token, or a
   * record whose session lives in the cookie. The server decides; a request
   * it rejects with 401 clears the store.
   */
  get isValid(): boolean {
    return this.#token !== "" || this.#record !== null;
  }

  get isSuperuser(): boolean {
    return this.isValid && this.#record?.collectionId === SUPERUSERS;
  }

  save(token: string, record: RecordModel | null): void {
    this.#token = token;
    this.#record = record;
    try {
      this.#storage?.setItem(this.#key, JSON.stringify({ token, record }));
    } catch {
      // Storage full or blocked: the in-memory state still works.
    }
    this.#notify();
  }

  clear(): void {
    this.#token = "";
    this.#record = null;
    try {
      this.#storage?.removeItem(this.#key);
    } catch {
      // Blocked storage.
    }
    this.#notify();
  }

  /** Calls `listener` on every change. Returns a function that unsubscribes. */
  onChange(listener: AuthChangeListener, fireImmediately = false): () => void {
    this.#listeners.add(listener);
    if (fireImmediately) listener(this.#token, this.#record);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #read(): string | null {
    try {
      return this.#storage?.getItem(this.#key) ?? null;
    } catch {
      return null;
    }
  }

  #load(raw: string | null): void {
    let token = "";
    let record: RecordModel | null = null;
    try {
      const parsed: unknown = raw === null ? null : JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        typeof (parsed as { token?: unknown }).token === "string"
      ) {
        token = (parsed as { token: string }).token;
        const stored = (parsed as { record?: unknown }).record;
        record =
          stored !== null && typeof stored === "object"
            ? (stored as RecordModel)
            : null;
      }
    } catch {
      // Corrupt entry: start signed out.
    }
    this.#token = token;
    this.#record = record;
  }

  #notify(): void {
    for (const listener of this.#listeners) listener(this.#token, this.#record);
  }
}

function browserStorage(): AuthStorage | null {
  try {
    // Checks for a document too: Node.js has a `localStorage` of its own.
    return browser.document === undefined
      ? null
      : (browser.localStorage ?? null);
  } catch {
    // Access denied, e.g. sandboxed iframes or blocked site data.
    return null;
  }
}
