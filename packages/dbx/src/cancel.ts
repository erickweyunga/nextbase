import type { QueryConfig, QueryResult } from "./builder.ts";
import type { PoolClient } from "./db.ts";

// How long a cancel request may take before its connection is dropped.
const CANCEL_TIMEOUT_MS = 10_000;

// node-postgres has no public cancel API, so this reaches into its client: the
// backend key from BackendKeyData, the server address, and the Connection
// transport, which applies TLS, `sslnegotiation` and custom streams the same
// way as for normal connections.
interface PgConnection {
  stream: { destroy(): void };
  connect(port: number | string, host?: string): void;
  requestSsl(): void;
  cancel(processID: number, secretKey: number): void;
  end(): void;
  on(event: string, listener: () => void): unknown;
}

interface PgClient {
  processID: number | null;
  secretKey: number | null;
  host: string;
  port: number;
  ssl: unknown;
  sslNegotiation: string;
  connection: PgConnection;
  connectionParameters: object;
}

/**
 * Runs `config` on `client`. When `signal` aborts first, the returned promise
 * rejects with the signal's reason, the server is asked to cancel the
 * statement, and `onCancel` is called.
 *
 * `settled` resolves once the statement has finished on the connection. A
 * connection that had a cancel request may still receive it late, so it must
 * not run another caller's statements.
 */
export function queryWithSignal(
  client: PoolClient,
  config: QueryConfig,
  signal: AbortSignal,
  clientConfig: object | undefined,
  onCancel: () => void,
): { result: Promise<QueryResult>; settled: Promise<void> } {
  const pending = client.query(config);
  const result = new Promise<QueryResult>((resolve, reject) => {
    let finished = false;
    const onAbort = (): void => {
      if (finished) return;
      onCancel();
      void cancelStatement(client, clientConfig);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const finish = (): void => {
      finished = true;
      signal.removeEventListener("abort", onAbort);
    };
    pending.then(
      (value) => {
        finish();
        resolve(value);
      },
      (error: unknown) => {
        finish();
        reject(error);
      },
    );
  });
  const settled = pending.then(
    () => undefined,
    () => undefined,
  );
  return { result, settled };
}

/**
 * Sends a CancelRequest for the statement running on `client`, as libpq's
 * PQcancel does: a new connection, made with `clientConfig` (or the client's
 * own parameters), carrying the backend's key. Poolers such as PgBouncer
 * forward it to the right server connection. Never rejects: a client that is
 * not a node-postgres client, or a request that fails, is ignored, because
 * the caller has already stopped waiting.
 */
function cancelStatement(
  client: PoolClient,
  clientConfig: object | undefined,
): Promise<void> {
  const target = client as unknown as Partial<PgClient>;
  const { processID, secretKey, host, port } = target;
  if (typeof processID !== "number" || typeof secretKey !== "number") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let canceler: PgClient;
    try {
      const PgClientClass = client.constructor as new (
        config: object,
      ) => PgClient;
      canceler = new PgClientClass(
        clientConfig ?? target.connectionParameters ?? {},
      );
    } catch {
      resolve();
      return;
    }
    const connection = canceler.connection;
    if (!isPgConnection(connection)) {
      resolve();
      return;
    }

    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      connection.stream.destroy();
      resolve();
    };
    // Runs a step of the exchange; if pg's internals ever behave differently,
    // the request is abandoned instead of throwing from an event handler.
    const step = (fn: () => void) => (): void => {
      try {
        fn();
      } catch {
        finish();
      }
    };
    const timer = setTimeout(finish, CANCEL_TIMEOUT_MS);
    timer.unref();

    const send = step(() => {
      connection.cancel(processID, secretKey);
      connection.end();
    });
    connection.on(
      "connect",
      step(() => {
        if (!canceler.ssl) send();
        else if (canceler.sslNegotiation !== "direct") connection.requestSsl();
      }),
    );
    connection.on("sslconnect", send);
    connection.on("end", finish);
    connection.on("error", finish);
    step(() => {
      if (typeof host === "string" && host.startsWith("/")) {
        connection.connect(`${host}/.s.PGSQL.${port}`);
      } else {
        connection.connect(port ?? 5432, host);
      }
    })();
  });
}

function isPgConnection(value: unknown): value is PgConnection {
  const connection = value as Partial<PgConnection> | undefined;
  return (
    typeof connection?.connect === "function" &&
    typeof connection.requestSsl === "function" &&
    typeof connection.cancel === "function" &&
    typeof connection.end === "function" &&
    typeof connection.on === "function" &&
    typeof connection.stream?.destroy === "function"
  );
}
