import { ApiError } from "./errors.ts";
import { isRecord } from "./schema/input.ts";

const MAX_JSON_BODY = 1024 * 1024;

// At most 1 MiB, enforced while streaming so an oversized body is never buffered whole.
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

/** Larger files use direct uploads to the bucket. */
const MAX_MULTIPART_BODY = 32 * 1024 * 1024;

// JSON, or form data where repeated parts become a list and `@jsonPayload`
// holds typed values. The size limit is enforced while streaming.
export async function readRecordBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(type)) return readJsonObject(request);
  const tooLarge = new ApiError(413, "The request body is too large.");
  if (Number(request.headers.get("content-length") ?? 0) > MAX_MULTIPART_BODY)
    throw tooLarge;

  let size = 0;
  const limited = request.body?.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > MAX_MULTIPART_BODY) controller.error(tooLarge);
        else controller.enqueue(chunk);
      },
    }),
  );
  let form: FormData;
  try {
    form = await new Request(request.url, {
      method: "POST",
      headers: { "content-type": type },
      body: limited ?? null,
      duplex: "half",
    } as RequestInit).formData();
  } catch {
    if (size > MAX_MULTIPART_BODY) throw tooLarge;
    throw new ApiError(400, "The request body is not valid form data.");
  }

  const body: Record<string, unknown> = {};
  for (const [key, value] of form) {
    if (key === "@jsonPayload") {
      let payload: unknown;
      try {
        payload = JSON.parse(typeof value === "string" ? value : "");
      } catch {
        throw new ApiError(400, "@jsonPayload is not valid JSON.");
      }
      if (!isRecord(payload))
        throw new ApiError(400, "@jsonPayload must be a JSON object.");
      Object.assign(body, payload);
      continue;
    }
    const previous = body[key];
    body[key] =
      previous === undefined
        ? value
        : Array.isArray(previous)
          ? [...previous, value]
          : [previous, value];
  }
  return body;
}
