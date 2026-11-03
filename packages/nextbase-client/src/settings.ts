import type { NextBaseClient, SendOptions } from './index.ts';
import type { SettingsModel } from './shared/api.ts';

/** The settings in effect, set in code. Every method needs a superuser. */
export class SettingsService {
  readonly #client: NextBaseClient;

  constructor(client: NextBaseClient) {
    this.#client = client;
  }

  /** The settings the server runs with, from the options passed to `nextbase()`. */
  get(options?: SendOptions): Promise<SettingsModel> {
    return this.#client.send('/settings', options);
  }
}
