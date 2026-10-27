import { ClientError } from "./client-error.ts";
import type { NextBaseClient, SendOptions } from "./index.ts";
import type { RecordModel } from "./shared/api.ts";

/** Larger files go straight to the bucket: Vercel caps request bodies at 4.5 MB. */
const DIRECT_UPLOAD_BYTES = 4 * 1024 * 1024;

export interface FileUrlOptions {
  /** Ask the browser to save the file rather than show it. */
  download?: boolean;
  /** A file token from `files.getToken()`, for protected files. */
  token?: string;
}

/** Uploaded files: their URLs, and tokens for protected ones. */
export class FileService {
  readonly #client: NextBaseClient;

  constructor(client: NextBaseClient) {
    this.#client = client;
  }

  /** A file's URL. Protected files also need the session cookie, or a `token`. */
  getUrl(
    record: Pick<RecordModel, "id" | "collectionId">,
    filename: string,
    options: FileUrlOptions = {},
  ): string {
    if (!filename) return "";
    return this.#client.buildUrl(
      `/files/${encodeURIComponent(record.collectionId)}/${encodeURIComponent(record.id)}/${encodeURIComponent(filename)}`,
      {
        token: options.token,
        ...(options.download && { download: 1 }),
      },
    );
  }

  /** A short-lived token for protected files, for `getUrl` where no cookie is sent. */
  async getToken(options?: SendOptions): Promise<string> {
    return (
      await this.#client.send<{ token: string }>("/files/token", {
        ...options,
        method: "POST",
      })
    ).token;
  }
}

export function hasFiles(body: Record<string, unknown>): boolean {
  return Object.values(body).some((value) =>
    Array.isArray(value) ? value.some(isFile) : isFile(value),
  );
}

/**
 * Files as parts, other values in `@jsonPayload` to keep their types. Files
 * over 4 MB are uploaded to the bucket first, when there is one.
 */
export async function toFormData(
  client: NextBaseClient,
  collection: string,
  body: Record<string, unknown>,
  options: SendOptions,
): Promise<FormData> {
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
      const token =
        item.size > DIRECT_UPLOAD_BYTES
          ? await uploadDirectly(client, collection, key, item, options)
          : undefined;
      if (token === undefined) form.append(key, item, fileName(item));
      else form.append(key, token);
    }
  }
  form.append("@jsonPayload", JSON.stringify(payload));
  return form;
}

/** The upload's token, or undefined when the server has no bucket. */
async function uploadDirectly(
  client: NextBaseClient,
  collection: string,
  field: string,
  file: Blob,
  options: SendOptions,
): Promise<string | undefined> {
  // `field+`, `+field` and `field-` upload to `field`.
  const name = field.replace(/^\+|[+-]$/g, "");
  let upload: { token: string; url: string; headers: Record<string, string> };
  try {
    upload = await client.send(
      `/collections/${encodeURIComponent(collection)}/upload-url`,
      {
        ...options,
        method: "POST",
        body: {
          field: name,
          filename: fileName(file),
          size: file.size,
          type: file.type || "application/octet-stream",
        },
      },
    );
  } catch (error) {
    if (
      error instanceof ClientError &&
      error.data.storage?.code === "direct_upload_unavailable"
    ) {
      return undefined;
    }
    throw error;
  }
  const response = await fetch(upload.url, {
    method: "PUT",
    headers: upload.headers,
    body: file,
  });
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
  return typeof Blob !== "undefined" && value instanceof Blob;
}

function fileName(file: Blob): string {
  return typeof File !== "undefined" && file instanceof File
    ? file.name
    : "file";
}
