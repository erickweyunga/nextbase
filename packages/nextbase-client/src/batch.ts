import type { NextBaseClient, SendOptions } from "./index.ts";

/** One write's outcome: 200 with the record, or 204 when the caller may not view it. */
export interface BatchResult {
  status: number;
  body?: Record<string, unknown>;
}

interface BatchRequest {
  method: "POST" | "PATCH" | "DELETE";
  url: string;
  body?: Record<string, unknown>;
}

/** Query options a batched write takes. */
export interface BatchWriteOptions {
  expand?: string;
  fields?: string;
}

/**
 * Collects record writes and sends them as one request that runs in a single
 * transaction: every write is saved, or none is. At most 50 writes.
 */
export class Batch {
  readonly #client: NextBaseClient;
  readonly #requests: BatchRequest[] = [];

  constructor(client: NextBaseClient) {
    this.#client = client;
  }

  /** Queues writes to one collection, by name or id. */
  collection(idOrName: string): BatchCollection {
    return new BatchCollection(this, this.#requests, idOrName);
  }

  /**
   * Sends the queued writes. Resolves with one result per write, in order, or
   * rejects with a 400 ClientError naming the failed write; then nothing was
   * saved, and `data.requests[index]` holds that write's field errors.
   */
  send(options?: SendOptions): Promise<BatchResult[]> {
    return this.#client.send("/batch", {
      ...options,
      method: "POST",
      body: { requests: this.#requests },
    });
  }
}

/** Queues writes to one collection. Each method returns the batch, to chain on. */
export class BatchCollection {
  readonly #batch: Batch;
  readonly #requests: BatchRequest[];
  readonly #path: string;

  constructor(batch: Batch, requests: BatchRequest[], idOrName: string) {
    this.#batch = batch;
    this.#requests = requests;
    this.#path = `/collections/${encodeURIComponent(idOrName)}/records`;
  }

  create(body: Record<string, unknown>, options?: BatchWriteOptions): Batch {
    this.#requests.push({ method: "POST", url: this.#url("", options), body });
    return this.#batch;
  }

  update(
    id: string,
    body: Record<string, unknown>,
    options?: BatchWriteOptions,
  ): Batch {
    this.#requests.push({
      method: "PATCH",
      url: this.#url(`/${encodeURIComponent(id)}`, options),
      body,
    });
    return this.#batch;
  }

  delete(id: string): Batch {
    this.#requests.push({
      method: "DELETE",
      url: this.#url(`/${encodeURIComponent(id)}`),
    });
    return this.#batch;
  }

  #url(suffix: string, options: BatchWriteOptions = {}): string {
    const query = new URLSearchParams();
    if (options.expand) query.set("expand", options.expand);
    if (options.fields) query.set("fields", options.fields);
    return `${this.#path}${suffix}${query.size > 0 ? `?${query}` : ""}`;
  }
}
