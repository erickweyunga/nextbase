import {
  ClientError,
  type ClientOptions,
  type CurrentSession,
  type ListResult,
  NextBaseClient,
  type RealtimeEvent,
  type RecordModel,
} from '@nextbasejs/client';
import {
  createContext,
  createElement,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

interface Shared {
  client: NextBaseClient;
  initial: RecordModel | null;
  ready: boolean;
  refetch(): Promise<void>;
}

const NextBaseContext = createContext<Shared | null>(null);

export interface NextBaseProviderProps {
  /**
   * The server's session (`null` when signed out) so the first render is signed in.
   * Omit it to load the session in the browser after mount.
   */
  session?: CurrentSession | null;
  /** Route handler URL. Defaults to `/api/nextbase`. */
  baseUrl?: ClientOptions['baseUrl'];
  children?: ReactNode;
}

/** Provides one NextBase client and the signed-in record to its children. */
export function NextBaseProvider({
  session,
  baseUrl,
  children,
}: NextBaseProviderProps): ReactElement {
  const [client] = useState(() => {
    const nb = new NextBaseClient(baseUrl === undefined ? {} : { baseUrl });
    if (session !== undefined) seed(nb, session);
    return nb;
  });
  const [ready, setReady] = useState(session !== undefined);
  // A new session from the server, as after a server action signs in or out
  // and the page refreshes.
  const seeded = useRef(session);
  useEffect(() => {
    if (session === undefined || session === seeded.current) return;
    seeded.current = session;
    seed(client, session);
    setReady(true);
  }, [client, session]);
  useEffect(() => {
    if (session !== undefined) return;
    // A failed load leaves the store as it was.
    client
      .getSession()
      .catch(() => null)
      .finally(() => setReady(true));
  }, [client, session]);
  const value = useMemo<Shared>(
    () => ({
      client,
      initial: session?.record ?? null,
      ready,
      refetch: async () => {
        await client.getSession();
      },
    }),
    [client, session, ready],
  );
  return createElement(NextBaseContext.Provider, { value }, children);
}

// Keeps any browser-held Bearer token: the server only sees the cookie.
function seed(client: NextBaseClient, session: CurrentSession | null): void {
  const store = client.authStore;
  if (session) store.save(store.token, session.record);
  else if (store.token === '' && store.record !== null) store.clear();
}

function useShared(): Shared {
  const shared = useContext(NextBaseContext);
  if (!shared) {
    throw new Error('Wrap the component tree in <NextBaseProvider>.');
  }
  return shared;
}

/** The NextBase client of the nearest NextBaseProvider. */
export function useNextBase(): NextBaseClient {
  return useShared().client;
}

export interface SessionState<T extends RecordModel = RecordModel> {
  /** The signed-in record, or null. */
  data: T | null;
  /** Whether the session is still loading. */
  isPending: boolean;
  refetch(): Promise<void>;
}

/** The signed-in record, kept current across sign-ins and sign-outs in any tab. */
export function useSession<
  T extends RecordModel = RecordModel,
>(): SessionState<T> {
  const { client, initial, ready, refetch } = useShared();
  const store = client.authStore;
  // The same function each render, so React subscribes once.
  const subscribe = useCallback(
    (onChange: () => void) => store.onChange(onChange),
    [store],
  );
  const data = useSyncExternalStore(
    subscribe,
    () => store.record,
    // What the server rendered, so hydration matches it.
    () => initial,
  );
  return { data: data as T | null, isPending: !ready, refetch };
}

/** What a live hook holds. */
interface LiveState<V> {
  data: V | undefined;
  error: ClientError | undefined;
  isPending: boolean;
}

/** State one live hook shares with React through `useSyncExternalStore`. */
class Live<V> {
  #state: LiveState<V>;
  readonly #listeners = new Set<() => void>();
  /** Loads again; set while the hook is mounted. */
  reload: () => Promise<void> = async () => {};

  constructor(initial: V | undefined, enabled: boolean) {
    this.#state = {
      data: initial,
      error: undefined,
      isPending: enabled && initial === undefined,
    };
  }

  get state(): LiveState<V> {
    return this.#state;
  }

  listen(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  set(next: Partial<LiveState<V>>): void {
    this.#state = { ...this.#state, ...next };
    for (const listener of this.#listeners) listener();
  }
}

/** Events in this window reload a list once. */
const RELOAD_DELAY_MS = 150;

function clientError(error: unknown): ClientError {
  return error instanceof ClientError
    ? error
    : new ClientError({
        status: 0,
        message: error instanceof Error ? error.message : String(error),
        data: {},
      });
}

/**
 * The live store for `key`, new when the key changes. `initial` seeds only
 * the first, which the server rendered with.
 */
function useLive<V>(
  key: string,
  initial: V | undefined,
  enabled: boolean,
): Live<V> {
  const first = useRef(key);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new store per key.
  return useMemo(
    () => new Live<V>(key === first.current ? initial : undefined, enabled),
    [key],
  );
}

function useLiveState<V>(live: Live<V>): LiveState<V> {
  const listen = useCallback(
    (onChange: () => void) => live.listen(onChange),
    [live],
  );
  return useSyncExternalStore(
    listen,
    () => live.state,
    () => live.state,
  );
}

export interface RecordsOptions<T extends RecordModel = RecordModel> {
  /** A filter expression; build one from user input with `nb.filter()`. */
  filter?: string;
  /** Comma-separated fields, `-` for descending, e.g. `-created,title`. */
  sort?: string;
  /** Relations to load, e.g. `author`. */
  expand?: string;
  /** Output fields, e.g. `id,title`. */
  fields?: string;
  page?: number;
  perPage?: number;
  /** Skip counting matches: faster, but `totalItems` and `totalPages` are -1. */
  skipTotal?: boolean;
  /** The page a server component loaded, for the first render. */
  initial?: ListResult<T>;
  /** `false` loads nothing and subscribes to nothing. */
  enabled?: boolean;
}

export interface LiveResult<V> {
  /** Undefined until loaded. */
  data: V | undefined;
  /** Why the last load failed, or the subscription was refused. */
  error: ClientError | undefined;
  /** Whether the first load is still running. */
  isPending: boolean;
  refetch(): Promise<void>;
}

/**
 * A page of records kept live; any change reloads it so filter, order and count stay
 * right. Needs the collection in the server's `realtime` option.
 */
export function useRecords<T extends RecordModel = RecordModel>(
  collection: string,
  options: RecordsOptions<T> = {},
): LiveResult<ListResult<T>> {
  const client = useNextBase();
  const {
    filter,
    sort,
    expand,
    fields,
    page = 1,
    perPage = 30,
    skipTotal,
    initial,
    enabled = true,
  } = options;
  const key = JSON.stringify([
    collection,
    filter,
    sort,
    expand,
    fields,
    page,
    perPage,
    skipTotal,
    enabled,
  ]);
  const live = useLive<ListResult<T>>(key, initial, enabled);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` covers the options.
  useEffect(() => {
    if (!enabled) return;
    const records = client.collection<T>(collection);
    let stopped = false;
    let latest = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      const ticket = ++latest;
      try {
        const data = await records.getList(page, perPage, {
          filter,
          sort,
          expand,
          fields,
          skipTotal,
        });
        // Only the newest load counts.
        if (!stopped && ticket === latest) {
          live.set({ data, error: undefined, isPending: false });
        }
      } catch (error) {
        if (!stopped && ticket === latest) {
          live.set({ error: clientError(error), isPending: false });
        }
      }
    };
    live.reload = load;
    // Every change the caller can see, not only the filter's: a record
    // updated out of the filter sends no event of the filter's own.
    const unsubscribe = records.subscribe(
      '*',
      (event) => {
        const data = live.state.data;
        if (data) live.set({ data: patchPage(data, event) });
        // Not pushed back by later events, so a steady stream still reloads.
        timer ??= setTimeout(() => {
          timer = undefined;
          void load();
        }, RELOAD_DELAY_MS);
      },
      {
        expand,
        fields,
        // Loaded once the subscription is live, so no change is missed.
        onReset: () => void load(),
        onError: (error) => {
          if (!stopped) live.set({ error, isPending: false });
        },
      },
    );
    return () => {
      stopped = true;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [client, live]);
  const state = useLiveState(live);
  const refetch = useCallback(() => live.reload(), [live]);
  return { ...state, refetch };
}

/** The page with an updated record replaced, or a deleted one left out. */
function patchPage<T extends RecordModel>(
  page: ListResult<T>,
  { action, record }: RealtimeEvent<T>,
): ListResult<T> {
  // Without `id` in `fields`, the reload brings the change.
  if (action === 'create' || record.id === undefined) return page;
  const at = page.items.findIndex((item) => item.id === record.id);
  if (at === -1) return page;
  const items = [...page.items];
  if (action === 'delete') items.splice(at, 1);
  else items[at] = record;
  return { ...page, items };
}

export interface RecordOptions<T extends RecordModel = RecordModel> {
  /** Relations to load, e.g. `author`. */
  expand?: string;
  /** Output fields, e.g. `id,title`. */
  fields?: string;
  /** The record a server component loaded, for the first render. */
  initial?: T | null;
  /** `false` loads nothing and subscribes to nothing. */
  enabled?: boolean;
}

/**
 * One record kept live; `null` once deleted, missing or not viewable. Needs the
 * collection in the server's `realtime` option.
 */
export function useRecord<T extends RecordModel = RecordModel>(
  collection: string,
  id: string | undefined,
  options: RecordOptions<T> = {},
): LiveResult<T | null> {
  const client = useNextBase();
  const { expand, fields, initial } = options;
  const enabled = (options.enabled ?? true) && id !== undefined && id !== '';
  const key = JSON.stringify([collection, id, expand, fields, enabled]);
  const live = useLive<T | null>(key, initial, enabled);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` covers the options.
  useEffect(() => {
    if (!enabled || id === undefined) return;
    const records = client.collection<T>(collection);
    let stopped = false;
    let latest = 0;
    const load = async (): Promise<void> => {
      const ticket = ++latest;
      try {
        const data = await records.getOne(id, { expand, fields });
        if (!stopped && ticket === latest) {
          live.set({ data, error: undefined, isPending: false });
        }
      } catch (error) {
        if (stopped || ticket !== latest) return;
        const failure = clientError(error);
        // Gone, or never visible to the caller.
        if (failure.status === 404) {
          live.set({ data: null, error: undefined, isPending: false });
        } else {
          live.set({ error: failure, isPending: false });
        }
      }
    };
    live.reload = load;
    const unsubscribe = records.subscribe(
      id,
      ({ action, record }) => {
        // The event carries the record as the caller sees it; a load in
        // flight would only bring older data.
        latest++;
        live.set({
          data: action === 'delete' ? null : record,
          error: undefined,
          isPending: false,
        });
      },
      {
        expand,
        fields,
        onReset: () => void load(),
        onError: (error) => {
          if (!stopped) live.set({ error, isPending: false });
        },
      },
    );
    return () => {
      stopped = true;
      unsubscribe();
    };
  }, [client, live]);
  const state = useLiveState(live);
  const refetch = useCallback(() => live.reload(), [live]);
  return { ...state, refetch };
}
