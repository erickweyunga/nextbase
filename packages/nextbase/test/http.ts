import type { NextBase } from "../src/server/index.ts";

export const origin = "http://localhost:3000";

export interface Reply {
  status: number;
  body: Record<string, unknown> & { data?: unknown };
}

export interface CallOptions {
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
}

/** Sends a request to `nextbase` in-process and parses the JSON reply. */
export async function call(
  nextbase: NextBase,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<Reply> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined)
    headers["content-type"] ??= "application/json";
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const body =
    options.body === undefined
      ? undefined
      : typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body);
  const response = await nextbase.handle(
    new Request(`${origin}/api/nextbase${path}`, { method, headers, body }),
  );
  const text = await response.text();
  return { status: response.status, body: text === "" ? {} : JSON.parse(text) };
}
