import type { NextBaseClient, SendOptions } from './index.ts';
import type { ListResult } from './shared/api.ts';
import type {
  AuthCollection,
  Collection,
  Field,
  Index,
  TokenConfig,
  TokenType,
} from './shared/schema.ts';

/**
 * A collection to create or update. Omitted settings keep their value or get a
 * default; fields without an `id` are new.
 */
export type CollectionInput = Partial<
  Omit<AuthCollection, 'type' | 'fields' | 'indexes' | 'tokens'>
> & {
  type?: Collection['type'];
  fields?: Partial<Field>[];
  indexes?: Partial<Index>[];
  /** View collections only: the SELECT their records come from. */
  viewQuery?: string;
  tokens?: Partial<Record<TokenType, Partial<TokenConfig>>>;
};

/** Collection definitions. Every method needs a superuser. */
export class CollectionService {
  readonly #client: NextBaseClient;

  constructor(client: NextBaseClient) {
    this.#client = client;
  }

  async getFullList(options?: SendOptions): Promise<Collection[]> {
    const list = await this.#client.send<ListResult<Collection>>(
      '/collections',
      options,
    );
    return list.items;
  }

  getOne(idOrName: string, options?: SendOptions): Promise<Collection> {
    return this.#client.send(path(idOrName), options);
  }

  create(body: CollectionInput, options?: SendOptions): Promise<Collection> {
    return this.#client.send('/collections', {
      ...options,
      method: 'POST',
      body,
    });
  }

  update(
    idOrName: string,
    body: CollectionInput,
    options?: SendOptions,
  ): Promise<Collection> {
    return this.#client.send(path(idOrName), {
      ...options,
      method: 'PATCH',
      body,
    });
  }

  /** Deletes a collection and its records. */
  async delete(idOrName: string, options?: SendOptions): Promise<void> {
    await this.#client.send(path(idOrName), { ...options, method: 'DELETE' });
  }
}

function path(idOrName: string): string {
  return `/collections/${encodeURIComponent(idOrName)}`;
}
