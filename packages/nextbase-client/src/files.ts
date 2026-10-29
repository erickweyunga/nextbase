import { ClientError } from './client-error.ts';
import type { NextBaseClient, SendOptions } from './index.ts';
import type { RecordModel } from './shared/api.ts';

// Larger files go straight to the bucket: Vercel caps request bodies at 4.5 MB.
const DIRECT_UPLOAD_BYTES = 4 * 1024 * 1024;

export interface FileUrlOptions {
  /** Download the file instead of showing it. */
  download?: boolean;
  /** A token from `files.getToken()`, for protected files. */
  token?: string;
}

/** File URLs and tokens for protected files. */
export class FileService {
  readonly #client: NextBaseClient;

  constructor(client: NextBaseClient) {
    this.#client = client;
  }

  /** A file's URL. Protected files also need the session cookie or a `token`. */
  getUrl(
    record: Pick<RecordModel, 'id' | 'collectionId'>,
    filename: string,
    options: FileUrlOptions = {},
  ): string {
    if (!filename) return '';
    return this.#client.buildUrl(
      `/files/${encodeURIComponent(record.collectionId)}/${encodeURIComponent(record.id)}/${encodeURIComponent(filename)}`,
      {
        token: options.token,
        ...(options.download && { download: 1 }),
      },
    );
  }

  /** A short-lived token for protected files, for `getUrl` when no cookie is sent. */
  async getToken(options?: SendOptions): Promise<string> {
    return (
      await this.#client.send<{ token: string }>('/files/token', {
        ...options,
        method: 'POST',
      })
    ).token;
  }
}

export function hasFiles(body: Record<string, unknown>): boolean {
  return Object.values(body).some((value) =>
    Array.isArray(value) ? value.some(isFile) : isFile(value),
  );
}

// Non-file values go in `@jsonPayload` to keep their types. When the files
// add up to more than 4 MB, the largest go to the bucket, when there is one,
// until the rest fit.
export async function toFormData(
  client: NextBaseClient,
  collection: string,
  body: Record<string, unknown>,
  options: SendOptions,
): Promise<FormData> {
  const files = Object.values(body).flatMap((value) =>
    (Array.isArray(value) ? value : [value]).filter(isFile),
  );
  const direct = new Set<Blob>();
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of [...files].sort((a, b) => b.size - a.size)) {
    if (total <= DIRECT_UPLOAD_BYTES) break;
    direct.add(file);
    total -= file.size;
  }
  const form = new FormData();
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    const items = Array.isArray(value) ? value : [value];
    if (!items.some(isFile)) {
      payload[key] = value;
      continue;
    }
    for (const item of items) {
      if (!isFile(item)) {
        form.append(key, String(item));
        continue;
      }
      const token = direct.has(item)
        ? await uploadDirectly(client, collection, key, item, options)
        : undefined;
      if (token === undefined) form.append(key, item, fileName(item));
      else form.append(key, token);
    }
  }
  form.append('@jsonPayload', JSON.stringify(payload));
  return form;
}

/**
 * `body` with each file uploaded to the bucket and replaced by its upload
 * token, for requests that are sent as JSON, such as batches.
 */
export async function withUploadedFiles(
  client: NextBaseClient,
  collection: string,
  body: Record<string, unknown>,
  options: SendOptions,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    const items = Array.isArray(value) ? value : [value];
    if (!items.some(isFile)) {
      out[key] = value;
      continue;
    }
    const sent: unknown[] = [];
    for (const item of items) {
      if (!isFile(item)) {
        sent.push(item);
        continue;
      }
      const token = await uploadDirectly(
        client,
        collection,
        key,
        item,
        options,
      );
      if (token === undefined) {
        throw new ClientError({
          status: 400,
          message: 'Files in a batch need storage in a bucket.',
          data: {},
        });
      }
      sent.push(token);
    }
    out[key] = Array.isArray(value) ? sent : sent[0];
  }
  return out;
}

// Returns undefined when the server has no bucket.
async function uploadDirectly(
  client: NextBaseClient,
  collection: string,
  field: string,
  file: Blob,
  options: SendOptions,
): Promise<string | undefined> {
  // `field+`, `+field` and `field-` upload to `field`.
  const name = field.replace(/^\+|[+-]$/g, '');
  let upload: { token: string; url: string; headers: Record<string, string> };
  try {
    upload = await client.send(
      `/collections/${encodeURIComponent(collection)}/upload-url`,
      {
        ...options,
        method: 'POST',
        body: {
          field: name,
          filename: fileName(file),
          size: file.size,
          type: file.type || 'application/octet-stream',
        },
      },
    );
  } catch (error) {
    if (
      error instanceof ClientError &&
      error.data.storage?.code === 'direct_upload_unavailable'
    ) {
      return undefined;
    }
    throw error;
  }
  // The global fetch: the client's own may only reach the NextBase handler,
  // as an in-process client's does.
  let response: Response;
  try {
    response = await fetch(upload.url, {
      method: 'PUT',
      headers: upload.headers,
      body: file,
      signal: options.signal ?? null,
    });
  } catch (cause) {
    throw new ClientError(
      {
        status: 0,
        message: cause instanceof Error ? cause.message : 'The upload failed.',
        data: {},
      },
      { cause, signal: options.signal },
    );
  }
  if (!response.ok) {
    throw new ClientError({
      status: response.status,
      message: `Uploading ${fileName(file)} failed with status ${response.status}.`,
      data: {},
    });
  }
  return upload.token;
}

function isFile(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

function fileName(file: Blob): string {
  return typeof File !== 'undefined' && file instanceof File
    ? file.name
    : 'file';
}
