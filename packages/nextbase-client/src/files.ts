import { ClientError } from "./client-error.ts";
import type { NextBaseClient, SendOptions } from "./index.ts";
import type { RecordModel } from "./shared/api.ts";

/**
 * Files larger than this skip the API request and go straight to the
 * bucket, when the server stores files in one: serverless hosts such as
 * Vercel cap request bodies at 4.5 MB.
 */
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

  /**
   * The URL of one of a record's files, for links and `<img>` tags. A
   * protected file also needs the caller's session cookie, or a `token`.
   */
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

  /**
   * A short-lived token for the signed-in record's protected files, to put
   * in `getUrl` where no session cookie is sent.
   */
  async getToken(options?: SendOptions): Promise<string> {
    return (
      await this.#client.send<{ token: string }>("/files/token", {
        ...options,
        method: "POST",
      })
    ).token;
  }
}

/** Whether a record body carries files, which then go as form data. */
export function hasFiles(body: Record<string, unknown>): boolean {
  return Object.values(body).some((value) =>
    Array.isArray(value) ? value.some(isFile) : isFile(value),
  );
}

/**
 * Turns a record body with files into form data: files as parts, and every
 * other value in a `@jsonPayload` part, so numbers and JSON stay as they
 * are. Files over 4 MB are first uploaded straight to the bucket, when the
 * server has one, and replaced by their upload's token.
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
    // In order: names kept from the record, files, and upload tokens.
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

/**
 * Uploads a file straight to the bucket and returns its token, or undefined
 * when the server stores files locally and takes them with the record.
 */
async function uploadDirectly(
  client: NextBaseClient,
  collection: string,
  field: string,
  file: Blob,
  options: SendOptions,
): Promise<string | undefined> {
  // Field names ending in + or - are modifiers of the field itself.
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
