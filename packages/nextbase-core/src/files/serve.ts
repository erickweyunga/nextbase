import type { AuthCollection, Collection, FileField } from "@nextbasejs/client";
import { type DB, hash } from "@nextbasejs/dbx";
import type { Principal } from "../auth/principal.ts";
import { peekToken, signToken, verifyToken } from "../auth/tokens.ts";
import { table } from "../db/system.ts";
import { ApiError } from "../errors.ts";
import { ALPHANUMERIC, randomString } from "../random.ts";
import type { Schema } from "../schema/cache.ts";
import { hasNul } from "../storable.ts";
import {
  fileKey,
  fileNames,
  isStoredName,
  presentation,
  UPLOAD_PREFIX,
  uploadKey,
} from "./files.ts";
import type { Storage } from "./storage.ts";

/** How long a direct upload URL works, and how long its upload waits for a record. */
const UPLOAD_SECONDS = 15 * 60;
/** How long a redirect to a protected file in a bucket works. */
const DOWNLOAD_SECONDS = 5 * 60;
const MAX_ORIGINAL_NAME = 255;

/**
 * Allows one direct upload to the bucket, for a file field of `collection`:
 * returns a URL the browser PUTs the file to, and the token to put in the
 * record's field afterwards. The URL is signed for the exact size and type,
 * and expires after 15 minutes. Whether the caller may create or update the
 * record is decided when the record is written, as for any write.
 */
export async function createUpload(
  db: DB,
  storage: Storage,
  collection: Collection,
  principal: Principal,
  input: Record<string, unknown>,
): Promise<{
  token: string;
  url: string;
  method: "PUT";
  headers: Record<string, string>;
}> {
  if (!storage.uploadUrl) {
    throw new ApiError(400, "Direct uploads need storage in a bucket.", {
      storage: {
        code: "direct_upload_unavailable",
        message: "Send the file with the record instead.",
      },
    });
  }
  if (
    collection.type === "view" ||
    (!principal.superuser &&
      collection.createRule === null &&
      collection.updateRule === null)
  ) {
    throw new ApiError(403, "Files cannot be uploaded to this collection.");
  }
  const field = collection.fields.find(
    (f): f is FileField => f.type === "file" && f.name === input.field,
  );
  const { filename, size, type } = input;
  const issues: Record<string, { code: string; message: string }> = {};
  if (!field) {
    issues.field = {
      code: "validation_invalid_value",
      message: "Must be the name of a file field.",
    };
  }
  if (
    typeof filename !== "string" ||
    filename === "" ||
    filename.length > MAX_ORIGINAL_NAME ||
    hasNul(filename)
  ) {
    issues.filename = {
      code: "validation_invalid_value",
      message: `Must be the file's name, up to ${MAX_ORIGINAL_NAME} characters.`,
    };
  }
  if (
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    (field && size > field.maxSize)
  ) {
    issues.size = {
      code: "validation_file_too_large",
      message: `Must be the file's size in bytes, at most ${field?.maxSize ?? 0}.`,
    };
  }
  if (typeof type !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(type)) {
    issues.type = {
      code: "validation_invalid_value",
      message: "Must be the file's MIME type, such as image/png.",
    };
  }
  if (Object.keys(issues).length > 0 || !field) {
    throw new ApiError(400, "Failed to start the upload.", issues);
  }

  await deleteExpiredUploads(db, storage);
  const id = randomString(32, ALPHANUMERIC);
  await db
    .newQuery(
      `INSERT INTO {{${table("_uploads")}}}
         (id, collection_id, field_id, filename, size, content_type, expires)
       VALUES ({:id}, {:collectionId}, {:fieldId}, {:filename}, {:size}, {:type},
               now() + make_interval(secs => ${UPLOAD_SECONDS}))`,
    )
    .bind({
      id,
      collectionId: collection.id,
      fieldId: field.id,
      filename,
      size,
      type,
    })
    .execute();
  const url = await storage.uploadUrl(
    uploadKey(id),
    { contentType: type as string, size: size as number },
    UPLOAD_SECONDS,
  );
  return {
    token: `${UPLOAD_PREFIX}${id}`,
    url,
    method: "PUT",
    headers: { "content-type": type as string },
  };
}

/**
 * Forgets uploads no record took in time, and their files. Done here, where
 * uploads start, so abandoned ones do not pile up.
 */
async function deleteExpiredUploads(db: DB, storage: Storage): Promise<void> {
  const expired = await db
    .newQuery(
      `DELETE FROM {{${table("_uploads")}}} WHERE expires <= now() RETURNING id`,
    )
    .column();
  if (expired.length === 0) return;
  await storage
    .delete(expired.map((id) => uploadKey(id as string)))
    .catch((error: unknown) => {
      console.error("[nextbase] deleting expired uploads failed:", error);
    });
}

/**
 * A short-lived token that lets the signed-in record download protected
 * files, for links and `<img>` tags, which cannot send an Authorization
 * header. Signed with the record's tokenKey, so a password change ends it.
 */
export function fileToken(
  collection: AuthCollection,
  record: Record<string, unknown>,
): Promise<string> {
  const { secret, duration } = collection.tokens.file;
  return signToken(
    `${record.tokenKey as string}${secret}`,
    { type: "file", id: record.id, collectionId: collection.id },
    duration,
  );
}

/** The caller a file token stands for, or undefined for an invalid one. */
export async function principalOfFileToken(
  db: DB,
  schema: Schema,
  token: string,
): Promise<Principal | undefined> {
  const claims = peekToken(token);
  if (typeof claims?.collectionId !== "string" || typeof claims.id !== "string")
    return undefined;
  let collection: Collection;
  try {
    collection = schema.get(claims.collectionId);
  } catch {
    return undefined;
  }
  if (collection.type !== "auth") return undefined;
  const [record] = await db
    .select()
    .from(table(collection.name))
    .where(hash({ id: claims.id }))
    .all();
  if (!record) return undefined;
  const verified = await verifyToken(
    token,
    `${record.tokenKey as string}${collection.tokens.file.secret}`,
    "file",
  );
  if (!verified) return undefined;
  return {
    collection,
    record,
    superuser: collection.id === "_superusers",
  };
}

/** A record's file, found by collection, record id and stored name. */
export async function findFile(
  db: DB,
  schema: Schema,
  [collectionId, recordId, name]: string[],
): Promise<{ collection: Collection; field: FileField; key: string }> {
  const notFound = new ApiError(404, "File not found.");
  let collection: Collection;
  try {
    collection = schema.get(collectionId as string);
  } catch {
    throw notFound;
  }
  // Only names NextBase generated, and only record ids, are ever looked up.
  if (
    collection.type === "view" ||
    !/^[a-z0-9]{15}$/.test(recordId as string) ||
    !isStoredName(name as string)
  ) {
    throw notFound;
  }
  const fields = collection.fields.filter((f) => f.type === "file");
  if (fields.length === 0) throw notFound;
  const [row] = await db
    .select(...fields.map((f) => f.name))
    .from(table(collection.name))
    .where(hash({ id: recordId }))
    .all();
  const field = fields.find((f) =>
    fileNames(f, row?.[f.name]).includes(name as string),
  );
  if (!row || !field) throw notFound;
  return {
    collection,
    field,
    key: fileKey(collection.id, recordId as string, name as string),
  };
}

/**
 * Answers with a file: streamed from local storage, or as a redirect to a
 * short-lived signed URL in the bucket, which keeps large downloads out of
 * the function. Public files may be cached; protected ones never are.
 */
export async function fileResponse(
  storage: Storage,
  key: string,
  { download, protectedFile }: { download: boolean; protectedFile: boolean },
): Promise<Response> {
  const name = key.slice(key.lastIndexOf("/") + 1);
  const shown = presentation(name, download);
  const cache = protectedFile ? "private, no-store" : "public, max-age=604800";
  if (storage.downloadUrl) {
    const url = await storage.downloadUrl(key, shown, DOWNLOAD_SECONDS);
    return new Response(null, {
      status: 302,
      headers: { location: url, "cache-control": "private, no-store" },
    });
  }
  const file = await storage.read(key);
  if (!file) throw new ApiError(404, "File not found.");
  return new Response(file.body, {
    headers: {
      "content-type": shown.contentType,
      "content-length": String(file.size),
      "content-disposition": shown.disposition,
      // Even if a browser rendered a file as a page, it could run nothing.
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": cache,
    },
  });
}
