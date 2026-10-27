import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ApiError } from "../errors.ts";
import { LOWER_ALPHANUMERIC, randomString } from "../random.ts";

/** Where uploaded files are kept: a local directory, or an S3-compatible bucket. */
export interface StorageOptions {
  /**
   * A directory on this machine. Defaults to `.nextbase/storage` in the
   * current working directory. Serverless hosts lose local files between
   * requests, so use `s3` there.
   */
  dir?: string;
  /** An S3-compatible bucket: AWS S3, Cloudflare R2, MinIO and others. */
  s3?: S3StorageOptions;
}

export interface S3StorageOptions {
  bucket: string;
  /** Defaults to `auto`, which Cloudflare R2 expects; AWS needs the bucket's region. */
  region?: string;
  /** The service URL, for providers other than AWS, such as `https://<account>.r2.cloudflarestorage.com`. */
  endpoint?: string;
  /** Without both keys, the AWS SDK's usual credential sources apply. */
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Address buckets as `endpoint/bucket` rather than `bucket.endpoint`, as MinIO needs. */
  forcePathStyle?: boolean;
}

/** How a downloaded file should be presented by the browser. */
export interface Presentation {
  contentType: string;
  /** A `Content-Disposition` value, such as `inline` or `attachment; filename="a.pdf"`. */
  disposition: string;
}

/**
 * Stores files by key, such as `<collection id>/<record id>/<file name>`.
 * Keys are always built by NextBase from ids and generated names, never
 * taken from requests as they are.
 */
export interface Storage {
  readonly kind: "local" | "s3";
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  /**
   * The file's bytes as a stream, or only those from `range.start` to
   * `range.end`, inclusive; undefined when the file does not exist.
   */
  read(
    key: string,
    range?: { start: number; end: number },
  ): Promise<{ body: ReadableStream<Uint8Array>; size: number } | undefined>;
  /** Up to `length` bytes from the start of the file, for detecting its type. */
  readStart(key: string, length: number): Promise<Uint8Array | undefined>;
  /** The file's size in bytes, or undefined when it does not exist. */
  size(key: string): Promise<number | undefined>;
  copy(from: string, to: string): Promise<void>;
  /** Deletes files; missing ones are ignored. */
  delete(keys: readonly string[]): Promise<void>;
  /** Deletes every file whose key starts with `prefix`. */
  deletePrefix(prefix: string): Promise<void>;
  /**
   * A URL the browser can PUT a file to directly, for `seconds`. The size
   * and type are signed in, so the upload must match them. Only buckets
   * support this.
   */
  uploadUrl?(
    key: string,
    upload: { contentType: string; size: number },
    seconds: number,
  ): Promise<string>;
  /** A URL the browser can download a file from directly, for `seconds`. */
  downloadUrl?(
    key: string,
    presentation: Presentation,
    seconds: number,
  ): Promise<string>;
}

export function newStorage(options: StorageOptions = {}): Storage {
  return options.s3
    ? new S3Storage(options.s3)
    : new LocalStorage(resolve(options.dir ?? join(".nextbase", "storage")));
}

/** Files in a directory on this machine. */
class LocalStorage implements Storage {
  readonly kind = "local";
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  // Keys never contain `..` (see checkName), but a key that somehow resolves
  // outside the root is refused rather than read or written.
  #path(key: string): string {
    const path = resolve(this.#root, key);
    if (!path.startsWith(this.#root + sep)) {
      throw new Error(`Storage key outside the storage directory: ${key}`);
    }
    return path;
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    // Vercel functions keep no files between requests, so an upload saved
    // here would quietly disappear.
    if (process.env.VERCEL) {
      throw new ApiError(
        400,
        "Uploads on Vercel need a bucket: pass the storage.s3 option to new NextBase().",
      );
    }
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    // Written beside the target and renamed into place, so a reader never
    // sees half a file.
    const temp = `${path}.${randomString(8, LOWER_ALPHANUMERIC)}.tmp`;
    await writeFile(temp, data);
    await rename(temp, path);
  }

  async read(key: string, range?: { start: number; end: number }) {
    const path = this.#path(key);
    const size = await this.size(key);
    if (size === undefined) return undefined;
    const body = Readable.toWeb(
      createReadStream(path, range),
    ) as ReadableStream<Uint8Array>;
    return { body, size };
  }

  async readStart(key: string, length: number) {
    let file: Awaited<ReturnType<typeof open>>;
    try {
      file = await open(this.#path(key), "r");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    try {
      const buffer = new Uint8Array(length);
      const { bytesRead } = await file.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
  }

  async size(key: string) {
    try {
      const info = await stat(this.#path(key));
      return info.isFile() ? info.size : undefined;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async copy(from: string, to: string): Promise<void> {
    const target = this.#path(to);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(this.#path(from), target);
  }

  async delete(keys: readonly string[]): Promise<void> {
    await Promise.all(
      keys.map(async (key) => {
        const path = this.#path(key);
        await rm(path, { force: true });
        // A record's directory goes with its last file; one still holding
        // files, or already gone, is left as it is.
        await rmdir(dirname(path)).catch(() => {});
      }),
    );
  }

  async deletePrefix(prefix: string): Promise<void> {
    // Prefixes are whole directories, such as `<collection id>/`.
    await rm(this.#path(prefix.replace(/\/+$/, "")), {
      recursive: true,
      force: true,
    });
  }
}

/** Files in an S3-compatible bucket. */
class S3Storage implements Storage {
  readonly kind = "s3";
  readonly #client: S3Client;
  readonly #bucket: string;

  constructor(options: S3StorageOptions) {
    if (!options.bucket) throw new TypeError("storage.s3 needs a bucket.");
    this.#bucket = options.bucket;
    this.#client = new S3Client({
      region: options.region ?? "auto",
      ...(options.endpoint && { endpoint: options.endpoint }),
      ...(options.forcePathStyle && { forcePathStyle: true }),
      ...(options.accessKeyId &&
        options.secretAccessKey && {
          credentials: {
            accessKeyId: options.accessKeyId,
            secretAccessKey: options.secretAccessKey,
          },
        }),
    });
  }

  async put(key: string, data: Uint8Array, contentType: string) {
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
      }),
    );
  }

  async read(key: string, range?: { start: number; end: number }) {
    try {
      const object = await this.#client.send(
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          ...(range && { Range: `bytes=${range.start}-${range.end}` }),
        }),
      );
      if (!object.Body) return undefined;
      return {
        body: object.Body.transformToWebStream() as ReadableStream<Uint8Array>,
        size: object.ContentLength ?? 0,
      };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async readStart(key: string, length: number) {
    try {
      const object = await this.#client.send(
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Range: `bytes=0-${length - 1}`,
        }),
      );
      return object.Body ? await object.Body.transformToByteArray() : undefined;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async size(key: string) {
    try {
      const head = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
      return head.ContentLength;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async copy(from: string, to: string): Promise<void> {
    await this.#client.send(
      new CopyObjectCommand({
        Bucket: this.#bucket,
        Key: to,
        CopySource: `${this.#bucket}/${from.split("/").map(encodeURIComponent).join("/")}`,
      }),
    );
  }

  async delete(keys: readonly string[]): Promise<void> {
    // DeleteObjects takes at most 1000 keys per request.
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      await this.#client.send(
        new DeleteObjectsCommand({
          Bucket: this.#bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    let token: string | undefined;
    do {
      const page = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [o.Key] : []));
      if (keys.length > 0) await this.delete(keys);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }

  uploadUrl(
    key: string,
    { contentType, size }: { contentType: string; size: number },
    seconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.#client,
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: size,
      }),
      {
        expiresIn: seconds,
        // Signed, so the browser must send exactly this size and type.
        signableHeaders: new Set(["content-type", "content-length"]),
      },
    );
  }

  downloadUrl(
    key: string,
    { contentType, disposition }: Presentation,
    seconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.#client,
      new GetObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        ResponseContentType: contentType,
        ResponseContentDisposition: disposition,
      }),
      { expiresIn: seconds },
    );
  }
}

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown }).code === "ENOENT";
}

function isNotFound(error: unknown): boolean {
  const { name, $metadata } = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    name === "NoSuchKey" ||
    name === "NotFound" ||
    $metadata?.httpStatusCode === 404
  );
}
