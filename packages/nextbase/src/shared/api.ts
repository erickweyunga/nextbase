/** Default mount point of the NextBase route handler. */
export const DEFAULT_BASE_PATH = "/api/nextbase";

/** One validation failure. `code` is stable; `message` is for humans. */
export interface FieldError {
  code: string;
  message: string;
}

/**
 * Validation errors keyed by field, nested for nested input. For example a bad
 * name on the third field of a collection is `{ fields: { 2: { name: ... } } }`.
 */
export interface ErrorData {
  [key: string]: FieldError | ErrorData;
}

/** Body of every non-2xx JSON response. */
export interface ApiErrorBody {
  status: number;
  message: string;
  data: ErrorData;
}

export interface HealthResponse {
  status: "ok";
}

/** A page of a list. With `skipTotal`, `totalItems` and `totalPages` are -1. */
export interface ListResult<T> {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  items: T[];
}

/** A record as the records API returns it. Other keys are the collection's fields. */
export interface RecordModel {
  id: string;
  collectionId: string;
  collectionName: string;
  /** Related records loaded with the `expand` parameter. */
  expand?: Record<string, RecordModel | RecordModel[]>;
  [field: string]: unknown;
}

/** Response of a successful sign-in or token refresh. */
export interface AuthResponse<T extends RecordModel = RecordModel> {
  token: string;
  record: T;
}

export interface SetupStatus {
  /** True until the first superuser exists. */
  required: boolean;
}
