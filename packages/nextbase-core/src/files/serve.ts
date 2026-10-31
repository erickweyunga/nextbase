import type { AuthCollection, Collection, FileField } from '@nextbasejs/client';
import { type DB, hash } from '@nextbasejs/dbx';
import parseRange from 'range-parser';
import type { Principal } from '../auth/principal.ts';
import { type Session, sessionById } from '../auth/sessions.ts';
import { countAttempt, type Limit, uploaderKey } from '../auth/throttle.ts';
import { peekToken, signToken, verifyToken } from '../auth/tokens.ts';
import { table } from '../db/system.ts';
import { ApiError } from '../errors.ts';
import type { Logger } from '../logs/logger.ts';
import { ALPHANUMERIC, isId, randomString } from '../random.ts';
import type { Schema } from '../schema/cache.ts';
import { unstorableText } from '../storable.ts';
import {
  fileKey,
  fileNames,
  isStoredName,
  presentation,
  UPLOAD_PREFIX,
  uploadKey,
} from './files.ts';
import type { Storage } from './storage.ts';

/** How long an upload URL works, and its upload waits for a record. */
const UPLOAD_SECONDS = 15 * 60;
/** How long a signed download URL works. */
const DOWNLOAD_SECONDS = 5 * 60;
const MAX_ORIGINAL_NAME = 255;
/** How many direct uploads an account may start. */
const UPLOAD_LIMIT: Limit = { max: 100, window: '1 hour' };

/**
 * Starts a direct upload: a signed PUT URL plus the token the field takes later. Rules cannot
 * check it yet, so guests may start one only where anyone may write, and accounts are capped.
 */
export async function createUpload(
  db: DB,
  storage: Storage,
  collection: Collection,
  principal: Principal,
  input: Record<string, unknown>,
  logger: Logger,
): Promise<{
  token: string;
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
}> {
  if (!storage.uploadUrl) {
    throw new ApiError(400, 'Direct uploads need storage in a bucket.', {
      storage: {
        code: 'direct_upload_unavailable',
        message: 'Send the file with the record instead.',
      },
    });
  }
  if (
    collection.type === 'view' ||
    (!principal.superuser &&
      collection.createRule === null &&
      collection.updateRule === null)
  ) {
    throw new ApiError(403, 'Files cannot be uploaded to this collection.');
  }
  if (!principal.superuser) {
    if (!principal.record || !principal.collection) {
      if (collection.createRule !== '' && collection.updateRule !== '') {
        throw new ApiError(401, 'Sign in to upload files to this collection.');
      }
    } else {
      await countAttempt(
        db,
        [uploaderKey(principal.collection.id, principal.record.id as string)],
        UPLOAD_LIMIT,
      );
    }
  }
  const field = collection.fields.find(
    (f): f is FileField => f.type === 'file' && f.name === input.field,
  );
  const { filename, size, type } = input;
  const issues: Record<string, { code: string; message: string }> = {};
  if (!field) {
    issues.field = {
      code: 'validation_invalid_value',
      message: 'Must be the name of a file field.',
    };
  }
  if (
    typeof filename !== 'string' ||
    filename === '' ||
    filename.length > MAX_ORIGINAL_NAME ||
    unstorableText(filename) !== undefined
  ) {
    issues.filename = {
      code: 'validation_invalid_value',
      message: `Must be the file's name, up to ${MAX_ORIGINAL_NAME} characters.`,
    };
  }
  if (
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    (field && size > field.maxSize)
  ) {
    issues.size = {
      code: 'validation_file_too_large',
      message: `Must be the file's size in bytes, at most ${field?.maxSize ?? 0}.`,
    };
  }
  if (typeof type !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(type)) {
    issues.type = {
      code: 'validation_invalid_value',
      message: "Must be the file's MIME type, such as image/png.",
    };
  }
  if (Object.keys(issues).length > 0 || !field) {
    throw new ApiError(400, 'Failed to start the upload.', issues);
  }

  await deleteExpiredUploads(db, storage, logger);
  const id = randomString(32, ALPHANUMERIC);
  await db
    .newQuery(
      `INSERT INTO {{${table('_uploads')}}}
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
    method: 'PUT',
    headers: { 'content-type': type as string },
  };
}

/** Removes uploads no record took in time; run where uploads start. */
async function deleteExpiredUploads(
  db: DB,
  storage: Storage,
  logger: Logger,
): Promise<void> {
  const expired = await db
    .newQuery(
      `DELETE FROM {{${table('_uploads')}}} WHERE expires <= now() RETURNING id`,
    )
    .column();
  if (expired.length === 0) return;
  await storage
    .delete(expired.map((id) => uploadKey(id as string)))
    .catch((error: unknown) => {
      logger.failure('storage', 'deleting expired uploads failed', error);
    });
}

/**
 * A short-lived token for protected files, for links that cannot send an Authorization header.
 * Bound to the record's tokenKey; minted on an impersonation session, it ends with that session.
 */
export function fileToken(
  collection: AuthCollection,
  record: Record<string, unknown>,
  session?: Session,
): Promise<string> {
  const { secret, duration } = collection.tokens.file;
  const left = session
    ? Math.floor((session.expires.getTime() - Date.now()) / 1000)
    : duration;
  return signToken(
    `${record.tokenKey as string}${secret}`,
    {
      type: 'file',
      id: record.id,
      collectionId: collection.id,
      ...(session && { sid: session.id }),
    },
    Math.max(1, Math.min(duration, left)),
  );
}

export async function principalOfFileToken(
  db: DB,
  schema: Schema,
  token: string,
): Promise<Principal | undefined> {
  const claims = peekToken(token);
  if (!claims) return undefined;
  let collection: Collection;
  try {
    collection = schema.get(claims.collectionId);
  } catch {
    return undefined;
  }
  if (collection.type !== 'auth') return undefined;
  const [record] = await db
    .select()
    .from(table(collection.name))
    .where(hash({ id: claims.id }))
    .all();
  if (!record) return undefined;
  const verified = await verifyToken(
    token,
    `${record.tokenKey as string}${collection.tokens.file.secret}`,
    'file',
  );
  if (!verified) return undefined;
  // Only impersonation tokens name a session; others take no extra query.
  if (typeof verified.sid === 'string') {
    const active = await sessionById(db, schema, verified.sid);
    if (
      active === undefined ||
      active.session.impersonatedBy === null ||
      active.collection.id !== collection.id ||
      active.record.id !== record.id
    ) {
      return undefined;
    }
    return {
      collection: active.collection,
      record: active.record,
      superuser: false,
      impersonatedBy: active.session.impersonatedBy,
      session: active.session,
    };
  }
  return {
    collection,
    record,
    superuser: collection.id === '_superusers',
  };
}

export async function findFile(
  db: DB,
  schema: Schema,
  [collectionId, recordId, name]: string[],
): Promise<{ collection: Collection; field: FileField; key: string }> {
  const notFound = new ApiError(404, 'File not found.');
  let collection: Collection;
  try {
    collection = schema.get(collectionId as string);
  } catch {
    throw notFound;
  }
  if (
    collection.type === 'view' ||
    !isId(recordId) ||
    !isStoredName(name as string)
  ) {
    throw notFound;
  }
  const fields = collection.fields.filter((f) => f.type === 'file');
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
 * Streams the file from disk, or redirects to a signed bucket URL, which
 * keeps large downloads out of the function.
 */
export async function fileResponse(
  storage: Storage,
  key: string,
  request: Request,
  { download, protectedFile }: { download: boolean; protectedFile: boolean },
): Promise<Response> {
  const name = key.slice(key.lastIndexOf('/') + 1);
  const shown = presentation(name, download);
  const cache = protectedFile ? 'private, no-store' : 'public, max-age=604800';
  if (storage.downloadUrl) {
    const url = await storage.downloadUrl(key, shown, DOWNLOAD_SECONDS);
    return new Response(null, {
      status: 302,
      headers: { location: url, 'cache-control': 'private, no-store' },
    });
  }
  const size = await storage.size(key);
  if (size === undefined) throw new ApiError(404, 'File not found.');
  const headers: Record<string, string> = {
    'content-type': shown.contentType,
    'content-disposition': shown.disposition,
    // Runs nothing, but lets the browser's media viewer play audio and video.
    'content-security-policy':
      "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    'cache-control': cache,
    'accept-ranges': 'bytes',
  };
  const range = byteRange(request, size);
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'content-range': `bytes */${size}` },
    });
  }
  const file = await storage.read(key, range);
  if (!file) throw new ApiError(404, 'File not found.');
  if (range) {
    return new Response(file.body, {
      status: 206,
      headers: {
        ...headers,
        'content-range': `bytes ${range.start}-${range.end}/${size}`,
        'content-length': String(range.end - range.start + 1),
      },
    });
  }
  return new Response(file.body, {
    headers: { ...headers, 'content-length': String(size) },
  });
}

/**
 * The requested byte range, as Express's `send` handles it: one range is 206, past the end 416;
 * multiple ranges, malformed headers or `If-Range` (no validator is issued) get the whole file.
 */
function byteRange(
  request: Request,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | undefined {
  const header = request.headers.get('range');
  if (!header || !/^ *bytes=/.test(header) || request.headers.has('if-range')) {
    return undefined;
  }
  const ranges = parseRange(size, header, { combine: true });
  if (ranges === -1) return 'unsatisfiable';
  if (ranges === -2 || ranges.type !== 'bytes' || ranges.length !== 1) {
    return undefined;
  }
  return ranges[0];
}
