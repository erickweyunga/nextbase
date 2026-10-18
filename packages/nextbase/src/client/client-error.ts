import type { ApiErrorBody } from "../shared/api.ts";

/** An error response, or a request that never got one (`status` 0). */
export class ClientError extends Error {
  readonly status: number;
  readonly data: ApiErrorBody["data"];
  /** Whether the request was aborted through its `signal`. */
  readonly isAbort: boolean;

  constructor(body: ApiErrorBody, options?: { cause?: unknown }) {
    super(body.message, options);
    this.name = "ClientError";
    this.status = body.status;
    this.data = body.data;
    this.isAbort =
      (options?.cause as { name?: unknown } | undefined)?.name === "AbortError";
  }
}
