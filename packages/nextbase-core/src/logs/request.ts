import type { Principal } from "../auth/principal.ts";
import type { ApiError } from "../errors.ts";
import { errorMessage, LOG_LEVELS } from "./logger.ts";

/** What a request's entry is made of, besides the request itself. */
export interface RequestOutcome {
  status: number;
  /** Milliseconds the request took, to its response. */
  execTime: number;
  /** Undefined when the request failed before the caller was known. */
  principal?: Principal | undefined;
  /** The error the response reports, if any. */
  failure?: ApiError | undefined;
  /** What was thrown, when it was not an ApiError and the response is a 500. */
  unexpected?: unknown;
  authId: boolean;
  /** Undefined when the IP is unknown or not recorded. */
  ip?: string | undefined;
}

// Query parameters that carry secrets: file tokens and OAuth2's code and state.
const SECRET_PARAMS: ReadonlySet<string> = new Set(["token", "code", "state"]);
const MAX_URL = 3000;
const MAX_USER_AGENT = 2000;
const MAX_REFERER = 2000;
const MAX_ERROR = 2000;
const MAX_STACK = 8000;
// About what one entry's data may take; details, then the stack, go first.
const MAX_DATA = 16 * 1024;

/** The level of a response's status: info, warn for 4xx, error for 5xx. */
function statusLevel(status: number): number {
  if (status >= 500) return LOG_LEVELS.error;
  if (status >= 400) return LOG_LEVELS.warn;
  return LOG_LEVELS.info;
}

/**
 * The entry of a request: never its body, cookies or Authorization header,
 * and the query's secrets are redacted.
 */
export function requestEntry(
  request: Request,
  outcome: RequestOutcome,
): { level: number; message: string; data: Record<string, unknown> } {
  const url = new URL(request.url);
  const { status, principal, failure, unexpected } = outcome;
  const data: Record<string, unknown> = {
    type: "request",
    method: request.method,
    url: redactedUrl(url).slice(0, MAX_URL),
    status,
    execTime: outcome.execTime,
    auth: principal?.collection?.name ?? "",
  };
  const id = principal?.record?.id;
  if (outcome.authId && typeof id === "string") data.authId = id;
  if (outcome.ip !== undefined) data.ip = outcome.ip;
  data.userAgent = (request.headers.get("user-agent") ?? "").slice(
    0,
    MAX_USER_AGENT,
  );
  const referer = refererOf(request.headers.get("referer"));
  if (referer !== undefined) data.referer = referer;
  if (unexpected !== undefined) {
    // The response says only that something went wrong; the log says what.
    data.error = errorMessage(unexpected).slice(0, MAX_ERROR);
    if (unexpected instanceof Error && unexpected.stack !== undefined) {
      data.stack = unexpected.stack.slice(0, MAX_STACK);
    }
  } else if (failure) {
    data.error = failure.message.slice(0, MAX_ERROR);
    if (Object.keys(failure.data).length > 0) data.details = failure.data;
  }
  for (const key of ["details", "stack"]) {
    if (JSON.stringify(data).length <= MAX_DATA) break;
    delete data[key];
  }
  return {
    level: statusLevel(status),
    message: `${request.method} ${url.pathname}`.slice(0, MAX_URL),
    data,
  };
}

/** The path and query, with secret parameters' values replaced. */
function redactedUrl(url: URL): string {
  if (url.search === "") return url.pathname;
  const parts = url.search
    .slice(1)
    .split("&")
    .map((part) => {
      const separator = part.indexOf("=");
      const rawKey = separator === -1 ? part : part.slice(0, separator);
      return SECRET_PARAMS.has(decodeKey(rawKey).toLowerCase())
        ? `${rawKey}=REDACTED`
        : part;
    });
  return `${url.pathname}?${parts.join("&")}`;
}

function decodeKey(key: string): string {
  try {
    return decodeURIComponent(key.replaceAll("+", " "));
  } catch {
    return key;
  }
}

/** Origin and path only: a page's query may hold a token or an email. */
function refererOf(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.origin === "null") return undefined;
    return `${url.origin}${url.pathname}`.slice(0, MAX_REFERER);
  } catch {
    return undefined;
  }
}
