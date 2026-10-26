import type { Collection, FileField } from "@nextbasejs/client";
import type { Builder } from "@nextbasejs/dbx";
import { fileTypeFromBuffer, supportedMimeTypes } from "file-type";
import { table } from "../db/system.ts";
import type { Effects } from "../effects.ts";
import { LOWER_ALPHANUMERIC, randomString } from "../random.ts";
import { isMultiple } from "../schema/fields.ts";
import type { Presentation, Storage } from "./storage.ts";

// Uploaded files of records. A file field holds file names, which NextBase
// generates; the file itself is in storage at `<collection id>/<record id>/<name>`.
//
// A file reaches a record in one of two ways:
// - sent with the record as multipart form data, for small files;
// - uploaded straight to the bucket with a signed URL (see `upload-url`),
//   then named in the record by the upload's token, `upload:<id>`. This keeps
//   large files out of the API request, which serverless hosts cap in size.

/** Marks a direct upload's token in a file field's value. */
export const UPLOAD_PREFIX = "upload:";

/** Where a record's file is stored. */
export function fileKey(
  collectionId: string,
  recordId: string,
  name: string,
): string {
  return `${collectionId}/${recordId}/${name}`;
}

/** Where a direct upload waits until a record takes it. */
export function uploadKey(id: string): string {
  return `_uploads/${id}`;
}

// Names NextBase generates: a cleaned-up version of the original name, a
// random part, and an extension. Nothing else is ever served.
const STORED_NAME = /^[a-z0-9_-]{1,100}_[a-z0-9]{10}(\.[a-z0-9]{1,10})?$/;

export function isStoredName(name: string): boolean {
  return STORED_NAME.test(name);
}

/**
 * A stored name for an uploaded file, such as `my_photo_k3j2h1g9f8.jpg` for
 * `My Photo.JPG`. The original name is never used as is: it could contain
 * path separators, control characters or a misleading extension. The
 * extension comes from the detected type when there is one.
 */
function storedName(original: string, ext: string | undefined): string {
  const base = original.replace(/^.*[\\/]/, "");
  const dot = base.lastIndexOf(".");
  const stem = (dot > 0 ? base.slice(0, dot) : base)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, 100);
  const suffix =
    ext ?? (dot > 0 ? base.slice(dot + 1).toLowerCase() : "").slice(0, 10);
  const extension = /^[a-z0-9]{1,10}$/.test(suffix) ? `.${suffix}` : "";
  return `${stem || "file"}_${randomString(10, LOWER_ALPHANUMERIC)}${extension}`;
}

/** How many bytes from the start of a file type detection needs, per file-type's docs. */
const DETECTION_BYTES = 4100;

/**
 * A file's type, read from its first bytes rather than trusting the label
 * the browser sent, which anyone can set. For types that can be recognized
 * from their bytes (images, PDFs, archives...), the label counts only if the
 * bytes confirm it. Text formats have no recognizable bytes, so their label
 * is kept; serving them with `nosniff` and, unless known to be safe, as a
 * download keeps that harmless.
 */
async function detectType(
  head: Uint8Array,
  declared: string,
): Promise<{ type: string; ext?: string }> {
  const detected = await fileTypeFromBuffer(head);
  if (detected) return { type: detected.mime, ext: detected.ext };
  const label = declared.split(";")[0]?.trim().toLowerCase() ?? "";
  if (/^[\w.+-]+\/[\w.+-]+$/.test(label) && !supportedMimeTypes.has(label)) {
    return { type: label };
  }
  return { type: "application/octet-stream" };
}

// Types browsers show safely inside the page. Anything else, including HTML
// and SVG, which can run scripts, is served as a download.
const INLINE: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  wav: "audio/wav",
  txt: "text/plain; charset=utf-8",
};

/** The Content-Type and Content-Disposition a file is served with. */
export function presentation(name: string, download: boolean): Presentation {
  const ext = name.slice(name.lastIndexOf(".") + 1);
  const inline = name.includes(".") ? INLINE[ext] : undefined;
  if (inline && !download)
    return { contentType: inline, disposition: "inline" };
  return {
    contentType: inline ?? "application/octet-stream",
    // Stored names are plain ASCII, so they need no escaping.
    disposition: `attachment; filename="${name}"`,
  };
}

/** A file a write adds to a record, stored once the write is allowed. */
interface NewFile {
  name: string;
  type: string;
  /** The bytes sent with the record, or the id of a direct upload to take. */
  source: { bytes: Uint8Array } | { upload: string };
}

/** What a write changes in a record's files. */
export interface FileChanges {
  added: NewFile[];
  /** Names the record no longer has. */
  removed: string[];
}

export interface FileProblem {
  code: string;
  message: string;
}

/**
 * Works out the new value of a file field from a write's input: `field`
 * replaces the files, `field+` adds and `field-` removes names. New files
 * are files sent with the record or `upload:<id>` tokens; names already on
 * the record may be listed to keep them. Returns undefined when the input
 * does not touch the field.
 */
export async function prepareFileField(
  q: Builder,
  storage: Storage,
  collection: Collection,
  field: FileField,
  input: Record<string, unknown>,
  current: readonly string[],
  fail: (problem: FileProblem) => void,
): Promise<{ value: string[]; changes: FileChanges } | undefined> {
  const { name } = field;
  const replace = input[name];
  const add = input[`${name}+`] ?? input[`+${name}`];
  const remove = input[`${name}-`];
  if (replace === undefined && add === undefined && remove === undefined) {
    return undefined;
  }

  const kept: string[] = [];
  const added: NewFile[] = [];
  const take = async (item: unknown, keeping: boolean): Promise<void> => {
    if (item === null || item === "") return;
    if (item instanceof Blob) {
      added.push(await fromBlob(field, item, fail));
    } else if (typeof item === "string" && item.startsWith(UPLOAD_PREFIX)) {
      const file = await fromUpload(q, storage, collection, field, item, fail);
      if (file) added.push(file);
    } else if (keeping && typeof item === "string" && current.includes(item)) {
      kept.push(item);
    } else {
      fail({
        code: "validation_invalid_value",
        message: keeping
          ? "Must be a file, an upload token, or a name of a file the record has."
          : "Must be a file or an upload token.",
      });
    }
  };

  if (replace !== undefined) {
    for (const item of toList(replace)) await take(item, true);
  } else {
    kept.push(...current);
  }
  const removing = new Set(toList(remove).filter((n) => typeof n === "string"));
  const remaining = kept.filter((n) => !removing.has(n));
  for (const item of toList(add)) await take(item, false);

  for (const file of added) {
    if (field.mimeTypes.length > 0 && !field.mimeTypes.includes(file.type)) {
      fail({
        code: "validation_invalid_mime_type",
        message: `Must be one of: ${field.mimeTypes.join(", ")}.`,
      });
    }
  }
  const value = [...remaining, ...added.map((f) => f.name)];
  if (value.length > field.maxSelect) {
    fail({
      code: "validation_too_many",
      message: `Select at most ${field.maxSelect}.`,
    });
  }
  return {
    value,
    changes: {
      added,
      removed: current.filter((n) => !remaining.includes(n)),
    },
  };
}

/** A file field's names from a stored value, single or multiple. */
export function fileNames(field: FileField, value: unknown): string[] {
  if (isMultiple(field)) return Array.isArray(value) ? value : [];
  return typeof value === "string" && value !== "" ? [value] : [];
}

/**
 * Stores the files a write adds and marks the ones it removes, once the
 * write is known to be allowed. A stored file is deleted again if the request
 * fails; removed ones only once it succeeds, so a failed write loses nothing.
 */
export async function storeFiles(
  q: Builder,
  storage: Storage,
  effects: Effects,
  collection: Collection,
  recordId: string,
  { added, removed }: FileChanges,
): Promise<void> {
  for (const file of added) {
    const key = fileKey(collection.id, recordId, file.name);
    effects.newFiles.push(key);
    if ("bytes" in file.source) {
      await storage.put(key, file.source.bytes, file.type);
    } else {
      await storage.copy(uploadKey(file.source.upload), key);
      await q
        .newQuery(`DELETE FROM {{${table("_uploads")}}} WHERE id = {:id}`)
        .bind({ id: file.source.upload })
        .execute();
      effects.obsoleteFiles.push(uploadKey(file.source.upload));
    }
  }
  for (const name of removed) {
    effects.obsoleteFiles.push(fileKey(collection.id, recordId, name));
  }
}

function toList(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

async function fromBlob(
  field: FileField,
  blob: Blob,
  fail: (problem: FileProblem) => void,
): Promise<NewFile> {
  if (blob.size > field.maxSize) tooLarge(field, fail);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const { type, ext } = await detectType(
    bytes.subarray(0, DETECTION_BYTES),
    blob.type,
  );
  const original = blob instanceof File ? blob.name : "file";
  return { name: storedName(original, ext), type, source: { bytes } };
}

/**
 * A direct upload named by its token: it must belong to this collection and
 * field, be complete, and match the size it was signed for.
 */
async function fromUpload(
  q: Builder,
  storage: Storage,
  collection: Collection,
  field: FileField,
  token: string,
  fail: (problem: FileProblem) => void,
): Promise<NewFile | undefined> {
  const id = token.slice(UPLOAD_PREFIX.length);
  const [upload] = await q
    .newQuery(
      `SELECT filename, size, content_type AS "contentType" FROM {{${table("_uploads")}}}
       WHERE id = {:id} AND collection_id = {:collectionId} AND field_id = {:fieldId}
         AND expires > now()`,
    )
    .bind({ id, collectionId: collection.id, fieldId: field.id })
    .all<{ filename: string; size: string | number; contentType: string }>();
  const unknown = (): undefined => {
    fail({
      code: "validation_invalid_upload",
      message: "The upload is unknown, unfinished or has expired.",
    });
    return undefined;
  };
  if (!upload) return unknown();
  const size = await storage.size(uploadKey(id));
  if (size === undefined || size !== Number(upload.size)) return unknown();
  if (size > field.maxSize) tooLarge(field, fail);
  const head = await storage.readStart(uploadKey(id), DETECTION_BYTES);
  const { type, ext } = await detectType(
    head ?? new Uint8Array(),
    upload.contentType,
  );
  return {
    name: storedName(upload.filename, ext),
    type,
    source: { upload: id },
  };
}

function tooLarge(field: FileField, fail: (problem: FileProblem) => void) {
  fail({
    code: "validation_file_too_large",
    message: `Must be at most ${field.maxSize} bytes.`,
  });
}
