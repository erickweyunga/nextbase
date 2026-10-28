import { detectXml } from "@file-type/xml";
import type { Collection, FileField } from "@nextbasejs/client";
import type { Builder } from "@nextbasejs/dbx";
import { FileTypeParser, supportedMimeTypes } from "file-type";
import { table } from "../db/system.ts";
import type { Effects } from "../effects.ts";
import { ApiError, writeFailed } from "../errors.ts";
import { LOWER_ALPHANUMERIC, randomString } from "../random.ts";
import { isMultiple } from "../schema/fields.ts";
import type { Presentation, Storage } from "./storage.ts";

// A file field holds generated file names; the files live in storage at
// `<collection id>/<record id>/<name>`. Files arrive with the record as form
// data, or as `upload:<id>` tokens of direct uploads to the bucket, which
// keep large files out of size-capped serverless requests.

export const UPLOAD_PREFIX = "upload:";

export function fileKey(
  collectionId: string,
  recordId: string,
  name: string,
): string {
  return `${collectionId}/${recordId}/${name}`;
}

export function uploadKey(id: string): string {
  return `_uploads/${id}`;
}

// Only names NextBase generated are ever served.
const STORED_NAME = /^[a-z0-9_-]{1,100}_[a-z0-9]{10}(\.[a-z0-9]{1,10})?$/;

export function isStoredName(name: string): boolean {
  return STORED_NAME.test(name);
}

/**
 * `My Photo.JPG` becomes `my_photo_k3j2h1g9f8.jpg`. Original names could hold
 * path separators or a misleading extension, so they are never used as is.
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

// The XML detector's default sample; more than file-type's 4100 bytes.
const DETECTION_BYTES = 16 * 1024;

const detector = new FileTypeParser({ customDetectors: [detectXml] });

function isDetectable(type: string): boolean {
  return (
    supportedMimeTypes.has(type as never) ||
    type.endsWith("/xml") ||
    type.endsWith("+xml")
  );
}

/**
 * The type from the file's bytes; the browser's label counts only for
 * formats without recognizable bytes (plain text, CSV...), which are served
 * with `nosniff` and, unless safe, as downloads.
 */
async function detectType(
  head: Uint8Array,
  declared: string,
): Promise<{ type: string; ext?: string }> {
  const detected = await detector.fromBuffer(head);
  if (detected) return { type: detected.mime, ext: detected.ext };
  const label = declared.split(";")[0]?.trim().toLowerCase() ?? "";
  if (/^[\w.+-]+\/[\w.+-]+$/.test(label) && !isDetectable(label)) {
    return { type: label };
  }
  return { type: "application/octet-stream" };
}

// Shown inline; anything else, including HTML and SVG, is a download.
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

interface NewFile {
  /** The file field it is for. */
  field: string;
  name: string;
  type: string;
  source: { bytes: Uint8Array } | { upload: string };
}

/** The new files of one write, read and checked before its transaction. */
export interface NewFiles {
  /** Each file, by the input item it came from: a Blob or an upload token. */
  files: Map<unknown, NewFile>;
  /** Problems found while reading them, by field name. */
  problems: Map<string, FileProblem[]>;
}

export interface FileChanges {
  added: NewFile[];
  removed: string[];
}

export interface FileProblem {
  code: string;
  message: string;
}

/**
 * Reads the new files a write brings: form data files, and direct uploads
 * named by `upload:<id>` tokens. Runs before the write's transaction, so
 * reading them holds no lock and no connection.
 */
export async function readNewFiles(
  q: Builder,
  storage: Storage,
  collection: Collection,
  input: Record<string, unknown>,
): Promise<NewFiles> {
  const read: NewFiles = { files: new Map(), problems: new Map() };
  for (const field of collection.fields) {
    if (field.type !== "file") continue;
    const fail = (problem: FileProblem): void => {
      const problems = read.problems.get(field.name) ?? [];
      problems.push(problem);
      read.problems.set(field.name, problems);
    };
    const { replace, prepend, append } = fileKeys(field.name);
    const items = [replace, prepend, append].flatMap((key) =>
      toList(input[key]),
    );
    for (const item of items) {
      let file: NewFile | undefined;
      if (item instanceof Blob) {
        file = await fromBlob(field, item, fail);
      } else if (typeof item === "string" && item.startsWith(UPLOAD_PREFIX)) {
        file = await fromUpload(q, storage, collection, field, item, fail);
      }
      if (!file) continue;
      if (field.mimeTypes.length > 0 && !field.mimeTypes.includes(file.type)) {
        fail({
          code: "validation_invalid_mime_type",
          message: `Must be one of: ${field.mimeTypes.join(", ")}.`,
        });
      }
      read.files.set(item, file);
    }
  }
  return read;
}

/**
 * Puts a write's new files in storage under the record, before its
 * transaction starts. Each goes in `effects.newFiles`, so it is deleted
 * again if the write fails.
 */
export async function storeNewFiles(
  storage: Storage,
  effects: Effects,
  collection: Collection,
  recordId: string,
  { files }: NewFiles,
): Promise<void> {
  for (const file of files.values()) {
    const key = fileKey(collection.id, recordId, file.name);
    effects.newFiles.push(key);
    if ("bytes" in file.source) {
      await storage.put(key, file.source.bytes, file.type);
    } else {
      await storage.copy(uploadKey(file.source.upload), key);
    }
  }
}

/** The input keys that change a file field. */
export function fileKeys(name: string): {
  replace: string;
  append: string;
  prepend: string;
  remove: string;
} {
  return {
    replace: name,
    append: `${name}+`,
    prepend: `+${name}`,
    remove: `${name}-`,
  };
}

/**
 * The field's new value from `field` (replace, listing names to keep),
 * `+field`/`field+` (prepend/append) and `field-` (remove names), with the
 * new files `readNewFiles` read. Undefined when the input does not touch the
 * field.
 */
export function prepareFileField(
  field: FileField,
  input: Record<string, unknown>,
  current: readonly string[],
  read: NewFiles,
  fail: (problem: FileProblem) => void,
): { value: string[]; changes: FileChanges } | undefined {
  const { name } = field;
  const keys = fileKeys(name);
  const replace = input[keys.replace];
  const append = input[keys.append];
  const prepend = input[keys.prepend];
  const remove = input[keys.remove];
  if (
    replace === undefined &&
    append === undefined &&
    prepend === undefined &&
    remove === undefined
  ) {
    return undefined;
  }
  for (const problem of read.problems.get(name) ?? []) fail(problem);

  const kept: string[] = [];
  const added: NewFile[] = [];
  const take = (item: unknown, keeping: boolean): void => {
    if (item === null || item === "") return;
    if (
      item instanceof Blob ||
      (typeof item === "string" && item.startsWith(UPLOAD_PREFIX))
    ) {
      // A file that could not be read is already among the problems.
      const file = read.files.get(item);
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
    for (const item of toList(replace)) take(item, true);
  } else {
    kept.push(...current);
  }
  const removing = new Set(toList(remove).filter((n) => typeof n === "string"));
  const remaining = kept.filter((n) => !removing.has(n));
  // New files of a replacing value come after the names it keeps.
  const replacing = added.length;
  for (const item of toList(prepend)) take(item, false);
  const prepended = added.length;
  for (const item of toList(append)) take(item, false);

  const names = added.map((f) => f.name);
  const value = [
    ...names.slice(replacing, prepended),
    ...remaining,
    ...names.slice(0, replacing),
    ...names.slice(prepended),
  ];
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

export function fileNames(field: FileField, value: unknown): string[] {
  if (isMultiple(field)) return Array.isArray(value) ? value : [];
  return typeof value === "string" && value !== "" ? [value] : [];
}

/**
 * Called in the write's transaction once the write is allowed, after
 * `storeNewFiles` stored the new files. Each direct upload is claimed, so it
 * makes one file only. Removed files are deleted once the write succeeds.
 */
export async function claimFiles(
  q: Builder,
  effects: Effects,
  collection: Collection,
  recordId: string,
  { added, removed }: FileChanges,
  creating: boolean,
): Promise<void> {
  for (const file of added) {
    if ("bytes" in file.source) continue;
    const claimed = await q
      .newQuery(
        `DELETE FROM {{${table("_uploads")}}} WHERE id = {:id} RETURNING id`,
      )
      .bind({ id: file.source.upload })
      .column();
    // Another write claimed it after this one read it.
    if (claimed.length === 0) {
      throw new ApiError(400, writeFailed(creating), {
        [file.field]: {
          code: "validation_invalid_upload",
          message: "The upload is unknown, unfinished or has expired.",
        },
      });
    }
    effects.obsoleteFiles.push(uploadKey(file.source.upload));
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
  return {
    field: field.name,
    name: storedName(original, ext),
    type,
    source: { bytes },
  };
}

/** The upload must be for this field, finished, and of its signed size. */
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
    field: field.name,
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
