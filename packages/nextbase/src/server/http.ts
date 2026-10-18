import { ApiError } from "./errors.ts";
import { isRecord } from "./schema/input.ts";

const MAX_JSON_BODY = 1024 * 1024;

/**
 * Reads a JSON object body of at most 1 MiB. The size is enforced while
 * streaming, so an oversized body is rejected without being buffered whole.
 */
export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    throw new ApiError(
      415,
      "The request body must be JSON (Content-Type: application/json).",
    );
  }
  const tooLarge = new ApiError(413, "The request body is too large.");
  if (Number(request.headers.get("content-length") ?? 0) > MAX_JSON_BODY)
    throw tooLarge;

  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BODY) {
        await reader.cancel();
        throw tooLarge;
      }
      chunks.push(value);
    }
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
  } catch {
    throw new ApiError(400, "The request body is not valid JSON.");
  }
  if (!isRecord(body))
    throw new ApiError(400, "The request body must be a JSON object.");
  return body;
}
