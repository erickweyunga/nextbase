import type { ApiErrorBody, ErrorData } from "@nextbase/client";

/** An error with an HTTP status, returned to the client as an ApiErrorBody. */
export class ApiError extends Error {
  readonly status: number;
  readonly data: ErrorData;
  /** Extra response headers, such as Retry-After. */
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    status: number,
    message: string,
    data: ErrorData = {},
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ApiError";
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
    // RFC 9110 15.5.2: a 401 must name the scheme that would be accepted.
    if (this.status === 401) headers.set("www-authenticate", "Bearer");
    return Response.json(body, { status: this.status, headers });
  }
}
