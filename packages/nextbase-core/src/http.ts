import { ApiError } from './errors.ts';
import { isRecord } from './schema/input.ts';

const MAX_JSON_BODY = 1024 * 1024;

// At most 1 MiB, enforced while streaming so an oversized body is never buffered whole.
export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  checkJson(request);
  return parseJsonObject(await readJsonBytes(request));
}

/**
 * A JSON object, or `{}` for a request with no body, whatever its
 * Content-Type: clients often send one on every request.
 */
export async function readOptionalJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const bytes = await readJsonBytes(request);
  if (bytes.byteLength === 0) return {};
  checkJson(request);
  return parseJsonObject(bytes);
}

function checkJson(request: Request): void {
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    throw new ApiError(
      415,
      'The request body must be JSON (Content-Type: application/json).',
    );
  }
}

async function readJsonBytes(request: Request): Promise<Buffer> {
  const tooLarge = new ApiError(413, 'The request body is too large.');
  if (Number(request.headers.get('content-length') ?? 0) > MAX_JSON_BODY)
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
  return Buffer.concat(chunks);
}

function parseJsonObject(bytes: Buffer): Record<string, unknown> {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, 'The request body is not valid JSON.');
  }
  if (!isRecord(body))
    throw new ApiError(400, 'The request body must be a JSON object.');
  return body;
}

/** Larger files use direct uploads to the bucket. */
const MAX_MULTIPART_BODY = 32 * 1024 * 1024;
/**
 * As in Django, PHP (max_input_vars) and formidable. Without a limit, 32 MiB
 * of tiny parts takes the parser seconds; long lists can go in `@jsonPayload`.
 */
const MAX_MULTIPART_PARTS = 1000;

// JSON, or form data where repeated parts become a list and `@jsonPayload`
// holds typed values. The size and part limits are enforced while streaming,
// before anything is parsed.
export async function readRecordBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data\s*;/i.test(type)) return readJsonObject(request);
  const tooLarge = new ApiError(413, 'The request body is too large.');
  if (Number(request.headers.get('content-length') ?? 0) > MAX_MULTIPART_BODY)
    throw tooLarge;
  const tooManyParts = new ApiError(
    400,
    `The request body has more than ${MAX_MULTIPART_PARTS} parts.`,
  );

  let size = 0;
  let refused: ApiError | undefined;
  const countParts = partCounter(type);
  const limited = request.body?.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > MAX_MULTIPART_BODY) refused = tooLarge;
        // The closing delimiter counts as one more.
        else if (countParts(chunk) > MAX_MULTIPART_PARTS + 1)
          refused = tooManyParts;
        if (refused) controller.error(refused);
        else controller.enqueue(chunk);
      },
    }),
  );
  let form: FormData;
  try {
    form = await new Request(request.url, {
      method: 'POST',
      headers: { 'content-type': type },
      body: limited ?? null,
      duplex: 'half',
    } as RequestInit).formData();
  } catch {
    throw (
      refused ?? new ApiError(400, 'The request body is not valid form data.')
    );
  }

  const fields = new Map<string, unknown>();
  for (const [key, value] of form) {
    if (key === '@jsonPayload') {
      let payload: unknown;
      try {
        payload = JSON.parse(typeof value === 'string' ? value : '');
      } catch {
        throw new ApiError(400, '@jsonPayload is not valid JSON.');
      }
      if (!isRecord(payload))
        throw new ApiError(400, '@jsonPayload must be a JSON object.');
      for (const [name, typed] of Object.entries(payload))
        fields.set(name, typed);
      continue;
    }
    // Pushed to, not copied, so repeated keys take linear time.
    const previous = fields.get(key);
    if (previous === undefined) fields.set(key, value);
    else if (Array.isArray(previous)) previous.push(value);
    else fields.set(key, [previous, value]);
  }
  // As with JSON.parse, a `__proto__` field is an own property, never the prototype.
  return Object.fromEntries(fields);
}

/**
 * Counts a multipart body's delimiters (RFC 2046, section 5.1.1: CRLF, two
 * hyphens and the boundary) across the chunks it is given, so far. The body
 * may begin with a delimiter without the CRLF, so one is assumed before it.
 * Without a boundary, it counts nothing, and parsing fails anyway.
 */
function partCounter(type: string): (chunk: Uint8Array) => number {
  const boundary = /;\s*boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(type);
  const delimiter = Buffer.from(`\r\n--${boundary?.[1] ?? boundary?.[2]}`);
  let tail = Buffer.from('\r\n');
  let count = 0;
  return (chunk) => {
    if (!boundary) return 0;
    const text = Buffer.concat([tail, chunk]);
    for (
      let at = text.indexOf(delimiter);
      at !== -1;
      at = text.indexOf(delimiter, at + delimiter.length)
    ) {
      count++;
    }
    // A delimiter split across chunks is found with the next one; the
    // tail is shorter than a delimiter, so none is counted twice.
    tail = text.subarray(Math.max(0, text.length - delimiter.length + 1));
    return count;
  };
}
