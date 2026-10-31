import { hasFiles, withUploadedFiles } from './files.ts';
import type { NextBaseClient, SendOptions } from './index.ts';

/** One write's outcome: 200 with the record, or 204 when the caller may not view it. */
export interface BatchResult {
  status: number;
  body?: Record<string, unknown>;
}

interface BatchRequest {
  method: 'POST' | 'PATCH' | 'DELETE';
  url: string;
  body?: Record<string, unknown>;
  /** The collection, for uploading the body's files. */
  collection: string;
}

export interface BatchWriteOptions {
  expand?: string;
  fields?: string;
}

/** Record writes sent as one request and saved in a single transaction. At most 50 writes. */
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
   * Resolves with one result per write, in order. On failure nothing is saved and the
   * 400 error's `data.requests[index]` holds field errors. Files need a bucket.
   */
  async send(options: SendOptions = {}): Promise<BatchResult[]> {
    const requests = [];
    for (const { collection, body, ...request } of this.#requests) {
      requests.push({
        ...request,
        ...(body && {
          body: hasFiles(body)
            ? await withUploadedFiles(this.#client, collection, body, options)
            : body,
        }),
      });
    }
    return this.#client.send('/batch', {
      ...options,
      method: 'POST',
      body: { requests },
    });
  }
}

/** Queues writes to one collection. Each method returns the batch for chaining. */
export class BatchCollection {
  readonly #batch: Batch;
  readonly #requests: BatchRequest[];
  readonly #collection: string;
  readonly #path: string;

  constructor(batch: Batch, requests: BatchRequest[], idOrName: string) {
    this.#batch = batch;
    this.#requests = requests;
    this.#collection = idOrName;
    this.#path = `/collections/${encodeURIComponent(idOrName)}/records`;
  }

  create(body: Record<string, unknown>, options?: BatchWriteOptions): Batch {
    this.#requests.push({
      method: 'POST',
      url: this.#url('', options),
      body,
      collection: this.#collection,
    });
    return this.#batch;
  }

  update(
    id: string,
    body: Record<string, unknown>,
    options?: BatchWriteOptions,
  ): Batch {
    this.#requests.push({
      method: 'PATCH',
      url: this.#url(`/${encodeURIComponent(id)}`, options),
      body,
      collection: this.#collection,
    });
    return this.#batch;
  }

  delete(id: string): Batch {
    this.#requests.push({
      method: 'DELETE',
      url: this.#url(`/${encodeURIComponent(id)}`),
      collection: this.#collection,
    });
    return this.#batch;
  }

  #url(suffix: string, options: BatchWriteOptions = {}): string {
    const query = new URLSearchParams();
    if (options.expand) query.set('expand', options.expand);
    if (options.fields) query.set('fields', options.fields);
    return `${this.#path}${suffix}${query.size > 0 ? `?${query}` : ''}`;
  }
}
