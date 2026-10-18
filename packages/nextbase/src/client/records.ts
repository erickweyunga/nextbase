import type { AuthResponse, ListResult, RecordModel } from "../shared/api.ts";
import { ClientError } from "./client-error.ts";
import type { NextBaseClient, SendOptions } from "./index.ts";

export interface RecordOptions extends SendOptions {
  /** Relations to load, e.g. `author,comments_via_post.author`. */
  expand?: string;
  /** Output fields, e.g. `id,title,expand.author.name`. */
  fields?: string;
}

export interface ListOptions extends RecordOptions {
  /** A filter expression; build one from user input with `filter()`. */
  filter?: string;
  /** Comma-separated fields, `-` for descending, e.g. `-created,title`. */
  sort?: string;
  /** Skips counting the matches: faster, with `totalItems` and `totalPages` -1. */
  skipTotal?: boolean;
}

export interface FullListOptions extends ListOptions {
  /** Records fetched per request. Defaults to 1000, the server's maximum. */
  batch?: number;
}

const MAX_PER_PAGE = 1000;

/** Records of one collection. The auth methods work on auth collections only. */
export class RecordService<T extends RecordModel = RecordModel> {
  readonly #client: NextBaseClient;
  readonly #collection: string;

  constructor(client: NextBaseClient, idOrName: string) {
    this.#client = client;
    this.#collection = idOrName;
  }

  getList(
    page = 1,
    perPage = 30,
    options: ListOptions = {},
  ): Promise<ListResult<T>> {
    const { filter, sort, skipTotal, ...rest } = options;
    return this.#send("/records", {
      ...rest,
      query: { ...rest.query, page, perPage, filter, sort, skipTotal },
    });
  }

  /** Every matching record, fetched in batches. */
  async getFullList(options: FullListOptions = {}): Promise<T[]> {
    const { batch = MAX_PER_PAGE, ...rest } = options;
    if (!Number.isInteger(batch) || batch < 1 || batch > MAX_PER_PAGE) {
      throw new RangeError(
        `batch must be an integer from 1 to ${MAX_PER_PAGE}.`,
      );
    }
    const items: T[] = [];
    for (let page = 1; ; page++) {
      const result = await this.getList(page, batch, {
        ...rest,
        skipTotal: true,
      });
      items.push(...result.items);
      if (result.items.length < batch) return items;
    }
  }

  /** The first record matching `filter`. Throws a 404 {@link ClientError} when none does. */
  async getFirstListItem(
    filter: string,
    options: ListOptions = {},
  ): Promise<T> {
    const result = await this.getList(1, 1, {
      ...options,
      filter,
      skipTotal: true,
    });
    const [item] = result.items;
    if (!item) {
      throw new ClientError({
        status: 404,
        message: "No record matches the filter.",
        data: {},
      });
    }
    return item;
  }

  getOne(id: string, options?: RecordOptions): Promise<T> {
    return this.#send(`/records/${encodeURIComponent(id)}`, options);
  }

  /**
   * Creates a record. Returns it, or `null` when it was created but the
   * caller may not view it.
   */
  async create(
    body: Record<string, unknown>,
    options?: RecordOptions,
  ): Promise<T | null> {
    const record = await this.#send<T | undefined>("/records", {
      ...options,
      method: "POST",
      body,
    });
    return record ?? null;
  }

  /**
   * Updates a record. Returns it, or `null` when it was updated but the
   * caller may no longer view it. Updating the signed-in record refreshes it
   * in the auth store.
   */
  async update(
    id: string,
    body: Record<string, unknown>,
    options?: RecordOptions,
  ): Promise<T | null> {
    const record = await this.#send<T | undefined>(
      `/records/${encodeURIComponent(id)}`,
      { ...options, method: "PATCH", body },
    );
    const store = this.#client.authStore;
    if (record && this.#isSignedIn(record)) {
      store.save(store.token, { ...store.record, ...record });
    }
    return record ?? null;
  }

  /** Deletes a record. Deleting the signed-in record signs out. */
  async delete(id: string, options?: SendOptions): Promise<void> {
    const store = this.#client.authStore;
    const signedIn = store.record;
    await this.#send(`/records/${encodeURIComponent(id)}`, {
      ...options,
      method: "DELETE",
    });
    if (signedIn && signedIn.id === id && this.#matches(signedIn)) {
      store.clear();
    }
  }

  /** Signs in and saves the token and record in the auth store. */
  async authWithPassword(
    identity: string,
    password: string,
    options?: RecordOptions,
  ): Promise<AuthResponse<T>> {
    return this.#saveAuth(
      await this.#send<AuthResponse<T>>("/auth-with-password", {
        ...options,
        method: "POST",
        body: { identity, password },
      }),
    );
  }

  /** Exchanges the current token for a fresh one, reloading the record. */
  async authRefresh(options?: RecordOptions): Promise<AuthResponse<T>> {
    return this.#saveAuth(
      await this.#send<AuthResponse<T>>("/auth-refresh", {
        ...options,
        method: "POST",
      }),
    );
  }

  #saveAuth(response: AuthResponse<T>): AuthResponse<T> {
    this.#client.authStore.save(response.token, response.record);
    return response;
  }

  #isSignedIn(record: RecordModel): boolean {
    const signedIn = this.#client.authStore.record;
    return (
      signedIn?.id === record.id &&
      signedIn.collectionId === record.collectionId
    );
  }

  /** Whether a record from the auth store belongs to this collection. */
  #matches(record: RecordModel): boolean {
    return (
      record.collectionId === this.#collection ||
      record.collectionName === this.#collection
    );
  }

  #send<R>(path: string, options: RecordOptions = {}): Promise<R> {
    const { expand, fields, ...rest } = options;
    return this.#client.send(
      `/collections/${encodeURIComponent(this.#collection)}${path}`,
      { ...rest, query: { ...rest.query, expand, fields } },
    );
  }
}
