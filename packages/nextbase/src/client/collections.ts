import type { ListResult } from "../shared/api.ts";
import type {
  AuthCollection,
  Collection,
  Field,
  TokenConfig,
  TokenType,
} from "../shared/schema.ts";
import type { NextBaseClient, SendOptions } from "./index.ts";

/**
 * A collection definition to create or a change to apply. Omitted settings
 * keep their current value, or get a default; fields without an `id` are new.
 */
export type CollectionInput = Partial<
  Omit<AuthCollection, "type" | "fields" | "tokens">
> & {
  type?: Collection["type"];
  fields?: Partial<Field>[];
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
      "/collections",
      options,
    );
    return list.items;
  }

  getOne(idOrName: string, options?: SendOptions): Promise<Collection> {
    return this.#client.send(path(idOrName), options);
  }

  create(body: CollectionInput, options?: SendOptions): Promise<Collection> {
    return this.#client.send("/collections", {
      ...options,
      method: "POST",
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
      method: "PATCH",
      body,
    });
  }

  /** Deletes a collection and its records. */
  async delete(idOrName: string, options?: SendOptions): Promise<void> {
    await this.#client.send(path(idOrName), { ...options, method: "DELETE" });
  }
}

function path(idOrName: string): string {
  return `/collections/${encodeURIComponent(idOrName)}`;
}
