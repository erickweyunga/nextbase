import type { ApiErrorBody, ErrorData } from '@nextbasejs/client';

/** Returned to the client as an ApiErrorBody. */
export class ApiError extends Error {
  readonly status: number;
  readonly data: ErrorData;
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    status: number,
    message: string,
    data: ErrorData = {},
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    this.headers = headers;
  }

  toResponse(): Response {
    const body: ApiErrorBody = {
      status: this.status,
      message: this.message,
      data: this.data,
    };
    const headers = new Headers(this.headers);
    if (this.status === 401) headers.set('www-authenticate', 'Bearer');
    return Response.json(body, { status: this.status, headers });
  }
}

/**
 * When Postgres refused an index entry too large for a page, the index it names.
 * Only one of its two "index row ..." messages names the index.
 */
export function indexRowTooLarge(
  error: unknown,
): { index: string | undefined } | undefined {
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (
    code !== '54000' ||
    typeof message !== 'string' ||
    !message.startsWith('index row ')
  )
    return undefined;
  return { index: /for index "(.+)"$/.exec(message)?.[1] };
}

export function writeFailed(creating: boolean): string {
  return creating
    ? 'Failed to create the record.'
    : 'Failed to update the record.';
}
