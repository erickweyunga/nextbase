import type { ApiErrorBody, ErrorData } from "../shared/api.ts";

/** An error with an HTTP status, returned to the client as an ApiErrorBody. */
export class ApiError extends Error {
  readonly status: number;
  readonly data: ErrorData;

  constructor(status: number, message: string, data: ErrorData = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }

  toResponse(): Response {
    const body: ApiErrorBody = {
      status: this.status,
      message: this.message,
      data: this.data,
    };
    return Response.json(body, { status: this.status });
  }
}
