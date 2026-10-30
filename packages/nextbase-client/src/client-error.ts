import type { ApiErrorBody, MfaRequired } from './shared/api.ts';

/** An error response, or a request that never got one (`status` 0). */
export class ClientError extends Error {
  readonly status: number;
  readonly data: ApiErrorBody['data'];
  /** Whether the request was aborted through its `signal`, for a reason other than a timeout. */
  readonly isAbort: boolean;
  /** Whether the request's `signal` timed out, as with `AbortSignal.timeout()`. */
  readonly isTimeout: boolean;
  /** Set when a first sign-in step needs a second one; see {@link isMfaRequired}. */
  readonly mfa: MfaRequired | undefined;

  constructor(
    body: ApiErrorBody,
    options?: { cause?: unknown; signal?: AbortSignal | null },
  ) {
    super(body.message, options);
    this.name = 'ClientError';
    this.status = body.status;
    this.data = body.data;
    this.mfa =
      body.status === 401 &&
      typeof body.mfaId === 'string' &&
      Array.isArray(body.methods)
        ? { mfaId: body.mfaId, methods: [...body.methods] }
        : undefined;
    // An aborted signal says why in its reason, which fetch rejects with. A
    // custom fetch may reject with an AbortError of its own.
    const signal = options?.signal;
    const reason = signal?.aborted ? signal.reason : options?.cause;
    const name = (reason as { name?: unknown } | undefined)?.name;
    this.isTimeout = name === 'TimeoutError';
    this.isAbort =
      !this.isTimeout && (!!signal?.aborted || name === 'AbortError');
  }
}

/**
 * The second step a sign-in needs, from the error of its first step, or
 * undefined for any other error.
 */
export function isMfaRequired(error: unknown): MfaRequired | undefined {
  return error instanceof ClientError ? error.mfa : undefined;
}
