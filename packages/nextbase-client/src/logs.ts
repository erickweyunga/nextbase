import type { NextBaseClient, SendOptions } from "./index.ts";
import type { ListResult, LogModel, LogStat } from "./shared/api.ts";

export interface LogListOptions extends SendOptions {
  /** A filter over `id`, `created`, `level`, `message` and `data.*`. */
  filter?: string;
  /** Comma-separated fields, `-` for descending. Defaults to `-created`. */
  sort?: string;
  /** Skip counting matches: faster, but `totalItems` and `totalPages` are -1. */
  skipTotal?: boolean;
}

export interface LogStatsOptions extends SendOptions {
  /** Count only the entries matching this filter. */
  filter?: string;
}

/** The server's request and error log. Every method needs a superuser. */
export class LogService {
  readonly #client: NextBaseClient;

  constructor(client: NextBaseClient) {
    this.#client = client;
  }

  /** A page of entries, newest first by default. */
  getList(
    page = 1,
    perPage = 30,
    options: LogListOptions = {},
  ): Promise<ListResult<LogModel>> {
    const { filter, sort, skipTotal, ...rest } = options;
    return this.#client.send("/logs", {
      ...rest,
      query: { ...rest.query, page, perPage, filter, sort, skipTotal },
    });
  }

  getOne(id: string, options?: SendOptions): Promise<LogModel> {
    return this.#client.send(`/logs/${encodeURIComponent(id)}`, options);
  }

  /** Matching entries per hour, oldest first. */
  getStats(options: LogStatsOptions = {}): Promise<LogStat[]> {
    const { filter, ...rest } = options;
    return this.#client.send("/logs/stats", {
      ...rest,
      query: { ...rest.query, filter },
    });
  }
}
