import type { NextBaseClient, SendOptions } from './index.ts';
import type { MigrationsStatus } from './shared/api.ts';

/** The app's migrations. Every method needs a superuser. */
export class MigrationService {
  readonly #client: NextBaseClient;

  constructor(client: NextBaseClient) {
    this.#client = client;
  }

  /** Each migration, applied or pending, and how collection changes are recorded. */
  getStatus(options?: SendOptions): Promise<MigrationsStatus> {
    return this.#client.send('/migrations', options);
  }
}
