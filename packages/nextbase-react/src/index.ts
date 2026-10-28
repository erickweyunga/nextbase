import {
  type ClientOptions,
  type CurrentSession,
  NextBaseClient,
  type RecordModel,
} from "@nextbasejs/client";
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
} from "react";

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
  baseUrl?: ClientOptions["baseUrl"];
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
  else if (store.token === "" && store.record !== null) store.clear();
}

function useShared(): Shared {
  const shared = useContext(NextBaseContext);
  if (!shared) {
    throw new Error("Wrap the component tree in <NextBaseProvider>.");
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
  /** Reloads the session from the server. */
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
