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

export interface StorageOptions {
  /** Defaults to `.nextbase/storage`. Serverless hosts lose local files: use `s3` there. */
  dir?: string;
  /** AWS S3, Cloudflare R2, MinIO or another S3-compatible bucket. */
  s3?: S3StorageOptions;
}

export interface S3StorageOptions {
  bucket: string;
  /** Defaults to `auto` (Cloudflare R2); AWS needs the bucket's region. */
  region?: string;
  /** For providers other than AWS, such as `https://<account>.r2.cloudflarestorage.com`. */
  endpoint?: string;
  /** Without both keys, the AWS SDK's usual credential sources apply. */
  accessKeyId?: string;
  secretAccessKey?: string;
  /** `endpoint/bucket` addressing, as MinIO needs. */
  forcePathStyle?: boolean;
}

export interface Presentation {
  contentType: string;
  /** `inline`, or `attachment; filename="..."`. */
  disposition: string;
}

/** Files by key. Keys are built from ids and generated names, never taken from requests. */
export interface Storage {
  readonly kind: "local" | "s3";
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  /** The whole file, or `range` (inclusive); undefined when missing. */
  read(
    key: string,
    range?: { start: number; end: number },
  ): Promise<{ body: ReadableStream<Uint8Array>; size: number } | undefined>;
  /** Up to `length` bytes from the start, for type detection. */
  readStart(key: string, length: number): Promise<Uint8Array | undefined>;
  size(key: string): Promise<number | undefined>;
  copy(from: string, to: string): Promise<void>;
  /** Missing files are ignored. */
  delete(keys: readonly string[]): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  /** Buckets only: a URL to PUT the file to, signed for its exact size and type. */
  uploadUrl?(
    key: string,
    upload: { contentType: string; size: number },
    seconds: number,
  ): Promise<string>;
  /** Buckets only: a signed URL to download the file from. */
  downloadUrl?(
    key: string,
    presentation: Presentation,
    seconds: number,
  ): Promise<string>;
}

export function newStorage(options: StorageOptions = {}): Storage {
  if (options.s3) return new S3Storage(options.s3);
  // Only known at runtime, so Next.js must not trace the files under it into
  // the build, which would include the whole project.
  const dir = options.dir ?? join(".nextbase", "storage");
  return new LocalStorage(resolve(/* turbopackIgnore: true */ dir));
}

class LocalStorage implements Storage {
  readonly kind = "local";
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  // Defense in depth: a key resolving outside the root is refused.
  #path(key: string): string {
    const path = resolve(this.#root, key);
    if (!path.startsWith(this.#root + sep)) {
      throw new Error(`Storage key outside the storage directory: ${key}`);
    }
    return path;
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    // Vercel keeps no files between requests: the upload would be lost.
    if (process.env.VERCEL) {
      throw new ApiError(
        400,
        "Uploads on Vercel need a bucket: pass the storage.s3 option to new NextBase().",
      );
    }
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    // Renamed into place, so readers never see half a file.
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
        // Removes the record's directory once empty.
        await rmdir(dirname(path)).catch(() => {});
      }),
    );
  }

  async deletePrefix(prefix: string): Promise<void> {
    await rm(this.#path(prefix.replace(/\/+$/, "")), {
      recursive: true,
      force: true,
    });
  }
}

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
