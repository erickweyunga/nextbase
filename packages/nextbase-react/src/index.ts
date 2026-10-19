"use client";

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
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

interface Shared {
  client: NextBaseClient;
  /** The record the server rendered with, for hydration. */
  initial: RecordModel | null;
  /** Whether the session is known: given by the server, or loaded. */
  ready: boolean;
  refetch(): Promise<void>;
}

const NextBaseContext = createContext<Shared | null>(null);

export interface NextBaseProviderProps {
  /**
   * The session the server read, such as `await (await serverClient(nextbase)).getSession()`,
   * so the first render already shows the signed-in user. `null` when signed
   * out. Leave it out to load the session in the browser after mounting.
   */
  session?: CurrentSession | null;
  /** URL of the NextBase route handler. Defaults to `/api/nextbase`. */
  baseUrl?: ClientOptions["baseUrl"];
  children?: ReactNode;
}

/** Shares one NextBase client, and the signed-in record, with the components below. */
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
  useEffect(() => {
    if (session !== undefined) return;
    // Signed-out or failed loads leave the store as the server answered.
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

/**
 * Puts the server's view of the session into the auth store. A Bearer token
 * the browser keeps is left alone: the server only sees the cookie.
 */
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
  /** Whether the session is still being loaded. */
  isPending: boolean;
  /** Reloads the session from the server. */
  refetch(): Promise<void>;
}

/**
 * The signed-in record, kept current as the user signs in and out, in this
 * tab or another.
 */
export function useSession<
  T extends RecordModel = RecordModel,
>(): SessionState<T> {
  const { client, initial, ready, refetch } = useShared();
  const store = client.authStore;
  const data = useSyncExternalStore(
    (onChange) => store.onChange(onChange),
    () => store.record,
    // What the server rendered, so hydration matches it.
    () => initial,
  );
  return { data: data as T | null, isPending: !ready, refetch };
}
