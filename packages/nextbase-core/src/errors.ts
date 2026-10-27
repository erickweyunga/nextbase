import type { ApiErrorBody, ErrorData } from "@nextbasejs/client";

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
    if (this.status === 401) headers.set("www-authenticate", "Bearer");
    return Response.json(body, { status: this.status, headers });
  }
}
