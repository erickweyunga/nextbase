import type { ApiErrorBody } from "./shared/api.ts";

/** An error response, or a request that never got one (`status` 0). */
export class ClientError extends Error {
  readonly status: number;
  readonly data: ApiErrorBody["data"];
  /** Whether the request was aborted through its `signal`, for a reason other than a timeout. */
  readonly isAbort: boolean;
  /** Whether the request's `signal` timed out, as with `AbortSignal.timeout()`. */
  readonly isTimeout: boolean;

  constructor(
    body: ApiErrorBody,
    options?: { cause?: unknown; signal?: AbortSignal | null },
  ) {
    super(body.message, options);
    this.name = "ClientError";
    this.status = body.status;
    this.data = body.data;
    // An aborted signal says why in its reason, which fetch rejects with. A
    // custom fetch may reject with an AbortError of its own.
    const signal = options?.signal;
    const reason = signal?.aborted ? signal.reason : options?.cause;
    const name = (reason as { name?: unknown } | undefined)?.name;
    this.isTimeout = name === "TimeoutError";
    this.isAbort =
      !this.isTimeout && (!!signal?.aborted || name === "AbortError");
  }
}
