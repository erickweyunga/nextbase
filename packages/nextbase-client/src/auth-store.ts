import type { RecordModel } from './shared/api.ts';

/** Storage for an auth store, shaped like `localStorage`. */
export interface AuthStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AuthStoreOptions {
  /**
   * Defaults to `localStorage` in the browser. Pass `null` for memory only, as on
   * the server, where a store must never be shared between users.
   */
  storage?: AuthStorage | null;
  /** Storage key. Defaults to `nextbase_auth`. */
  key?: string;
}

export type AuthChangeListener = (
  token: string,
  record: RecordModel | null,
) => void;

type StorageListener = (event: {
  key: string | null;
  newValue: string | null;
}) => void;

// Typed by hand: the package compiles without the DOM library.
interface BrowserGlobals {
  document?: unknown;
  localStorage?: AuthStorage;
  addEventListener?(type: 'storage', listener: StorageListener): void;
  removeEventListener?(type: 'storage', listener: StorageListener): void;
}

const browser = globalThis as BrowserGlobals;

// Removes a store's storage listener once the store is garbage collected.
const listening = new FinalizationRegistry<StorageListener>((listener) => {
  browser.removeEventListener?.('storage', listener);
});

const DEFAULT_KEY = 'nextbase_auth';
const SUPERUSERS = '_superusers';

/** The signed-in record and its token, kept in sync with storage and other tabs. */
export class AuthStore {
  #token = '';
  #record: RecordModel | null = null;
  readonly #storage: AuthStorage | null;
  readonly #key: string;
  readonly #listeners = new Set<AuthChangeListener>();

  constructor(options: AuthStoreOptions = {}) {
    this.#storage =
      options.storage === undefined ? browserStorage() : options.storage;
    this.#key = options.key ?? DEFAULT_KEY;
    this.#load(this.#read());
    if (this.#storage && this.#storage === browserStorage()) {
      // Through a WeakRef, so the window's listener does not keep the store.
      const store = new WeakRef(this);
      const key = this.#key;
      const listener: StorageListener = (event) => {
        if (event.key !== key) return;
        const current = store.deref();
        if (current) current.#changedElsewhere(event.newValue);
      };
      browser.addEventListener?.('storage', listener);
      listening.register(this, listener);
    }
  }

  get token(): string {
    return this.#token;
  }

  get record(): RecordModel | null {
    return this.#record;
  }

  /**
   * Whether the client believes it is signed in (a token, or a cookie session's
   * record). Only the server knows; a 401 clears the store.
   */
  get isValid(): boolean {
    return this.#token !== '' || this.#record !== null;
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
      // Storage full or blocked: memory state still works.
    }
    this.#notify();
  }

  clear(): void {
    this.#token = '';
    this.#record = null;
    try {
      this.#storage?.removeItem(this.#key);
    } catch {
      // Blocked storage.
    }
    this.#notify();
  }

  /** Calls `listener` on every change. Returns an unsubscribe function. */
  onChange(listener: AuthChangeListener, fireImmediately = false): () => void {
    this.#listeners.add(listener);
    if (fireImmediately) listener(this.#token, this.#record);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // Another tab signed in or out.
  #changedElsewhere(raw: string | null): void {
    this.#load(raw);
    this.#notify();
  }

  #read(): string | null {
    try {
      return this.#storage?.getItem(this.#key) ?? null;
    } catch {
      return null;
    }
  }

  #load(raw: string | null): void {
    let token = '';
    let record: RecordModel | null = null;
    try {
      const parsed: unknown = raw === null ? null : JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        typeof (parsed as { token?: unknown }).token === 'string'
      ) {
        token = (parsed as { token: string }).token;
        const stored = (parsed as { record?: unknown }).record;
        record =
          stored !== null && typeof stored === 'object'
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
    // Node.js has its own `localStorage`, so require a document too.
    return browser.document === undefined
      ? null
      : (browser.localStorage ?? null);
  } catch {
    // Sandboxed iframes and blocked site data throw.
    return null;
  }
}
