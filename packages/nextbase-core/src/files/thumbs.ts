import { availableParallelism } from 'node:os';
import type { FileField } from '@nextbasejs/client';
import type SharpConstructor from 'sharp';
import { ApiError } from '../errors.ts';
import type { Logger } from '../logs/logger.ts';
import type { Storage } from './storage.ts';

// Thumbnails of an image file live beside it, at
// `<collection id>/<record id>/thumbs_<name>/<size>_<name>`, made on the
// first request for a size and kept until the file is removed.

const SIZE = /^(\d{1,4})x(\d{1,4})(t|b|f)?$/;
const MAX_SIDE = 2500;
export const MAX_THUMBS = 20;
/** Served for every image field, listed or not. */
const DEFAULT_SIZE = '100x100';
/** Decoded images larger than this are not thumbed. */
const MAX_PIXELS = 50_000_000;
/** Files that could not be thumbed, remembered so they are not tried again. */
const MAX_FAILED = 1000;

type Format = 'jpeg' | 'png' | 'gif' | 'webp';

/** The images thumbnails are made of, by stored extension. */
const FORMATS: Readonly<Record<string, Format>> = {
  jpg: 'jpeg',
  jpeg: 'jpeg',
  png: 'png',
  gif: 'gif',
  webp: 'webp',
};

interface ThumbSize {
  width: number;
  height: number;
  /** Cropped to fill both sides, at the centre, top or bottom; or fit inside. */
  mode: 'center' | 'top' | 'bottom' | 'fit';
}

/**
 * `WxH` crops to fill, from the centre; `WxHt` and `WxHb` from the top or
 * bottom; `WxHf` fits inside; `0xH` and `Wx0` scale to one side.
 */
function parseSize(size: string): ThumbSize | undefined {
  const match = SIZE.exec(size);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if ((width === 0 && height === 0) || width > MAX_SIDE || height > MAX_SIDE) {
    return undefined;
  }
  const mode =
    match[3] === 't'
      ? 'top'
      : match[3] === 'b'
        ? 'bottom'
        : match[3] === 'f'
          ? 'fit'
          : 'center';
  return { width, height, mode };
}

/** Why a field's thumb size is invalid, or undefined when it is valid. */
export function thumbSizeProblem(size: string): string | undefined {
  if (parseSize(size)) return undefined;
  return `Must be WIDTHxHEIGHT, such as 100x100, optionally followed by t, b or f, with sides up to ${MAX_SIDE} and not both 0.`;
}

function formatOf(name: string): Format | undefined {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? undefined : FORMATS[name.slice(dot + 1)];
}

/** Where a stored file's thumbnails are. */
export function thumbsPrefix(key: string): string {
  const slash = key.lastIndexOf('/');
  return `${key.slice(0, slash)}/thumbs_${key.slice(slash + 1)}/`;
}

/** Whether a stored file can have thumbnails. */
export function hasThumbs(key: string): boolean {
  return formatOf(key.slice(key.lastIndexOf('/') + 1)) !== undefined;
}

type Sharp = typeof SharpConstructor;

let sharpModule: Promise<Sharp | undefined> | undefined;

// sharp is an optional peer dependency: without it, originals are served.
function loadSharp(): Promise<Sharp | undefined> {
  sharpModule ??= import('sharp').then(
    (module) => module.default,
    () => undefined,
  );
  return sharpModule;
}

/** Runs at most `limit` tasks at once; the rest wait their turn. */
class Semaphore {
  readonly #limit: number;
  readonly #waiting: (() => void)[] = [];
  #running = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#running >= this.#limit) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    } else {
      this.#running++;
    }
    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      // The next task takes this one's place.
      if (next) next();
      else this.#running--;
    }
  }
}

// Shared by every instance: decoding uses the process's CPUs and memory.
const making = new Semaphore(availableParallelism());

/**
 * Makes thumbnails on request. Each size of each file is made once at a
 * time per instance; requests for it meanwhile wait for that one.
 */
export class Thumbs {
  readonly #storage: Storage;
  readonly #logger: Logger;
  /** Thumbnails being made, by key: whether they were stored. */
  readonly #making = new Map<string, Promise<boolean>>();
  readonly #failed = new Set<string>();
  #warnedMissing = false;

  constructor(storage: Storage, logger: Logger) {
    this.#storage = storage;
    this.#logger = logger;
  }

  /**
   * The key to serve for `size` of the file at `key`: its thumbnail, made
   * if missing, or the file itself when the size is not one of the field's,
   * the file is not an image NextBase thumbs, or making it failed.
   */
  async keyOf(field: FileField, key: string, size: string): Promise<string> {
    if (size !== DEFAULT_SIZE && !field.thumbs.includes(size)) return key;
    const thumb = parseSize(size);
    const name = key.slice(key.lastIndexOf('/') + 1);
    const format = formatOf(name);
    if (!thumb || !format) return key;
    const target = `${thumbsPrefix(key)}${size}_${name}`;
    if (this.#failed.has(key)) return key;
    if ((await this.#storage.size(target)) !== undefined) return target;
    let made = this.#making.get(target);
    if (!made) {
      made = making
        .run(() => this.#make(key, target, thumb, format))
        .finally(() => this.#making.delete(target));
      this.#making.set(target, made);
    }
    return (await made) ? target : key;
  }

  async #make(
    key: string,
    target: string,
    size: ThumbSize,
    format: Format,
  ): Promise<boolean> {
    const sharp = await loadSharp();
    if (!sharp) {
      if (!this.#warnedMissing) {
        this.#warnedMissing = true;
        this.#logger.failure(
          'thumbs',
          'making thumbnails needs sharp, so originals are served',
          new Error("Cannot import 'sharp'. Install it to make thumbnails."),
          'warn',
        );
      }
      return false;
    }
    const file = await this.#storage.read(key);
    if (!file) throw new ApiError(404, 'File not found.');
    const input = new Uint8Array(await new Response(file.body).arrayBuffer());
    let output: Uint8Array;
    try {
      output = await resize(sharp, input, size, format);
    } catch (error) {
      // Stored files never change, so other sizes would fail too.
      this.#remember(key);
      this.#logger.failure(
        'thumbs',
        `making the ${target} thumbnail failed, so the original is served`,
        error,
        'warn',
      );
      return false;
    }
    try {
      await this.#storage.put(target, output, `image/${format}`);
    } catch (error) {
      this.#logger.failure('storage', 'storing a thumbnail failed', error);
      return false;
    }
    // Made while the file was being removed: the removal may have missed it.
    if ((await this.#storage.size(key)) === undefined) {
      await this.#storage.deletePrefix(thumbsPrefix(key));
      throw new ApiError(404, 'File not found.');
    }
    return true;
  }

  #remember(key: string): void {
    if (this.#failed.size >= MAX_FAILED) {
      const oldest = this.#failed.values().next().value;
      if (oldest !== undefined) this.#failed.delete(oldest);
    }
    this.#failed.add(key);
  }
}

async function resize(
  sharp: Sharp,
  input: Uint8Array,
  { width, height, mode }: ThumbSize,
  format: Format,
): Promise<Uint8Array> {
  const image = sharp(input, {
    limitInputPixels: MAX_PIXELS,
    failOn: 'error',
    autoOrient: true,
    // The first frame of an animation.
    pages: 1,
  });
  // The bytes must be the image the extension says, never SVG, PDF or
  // another format a decoder could read.
  const { format: actual } = await image.metadata();
  if (actual !== format) {
    throw new Error(
      `The file holds ${actual ?? 'unknown'} data, not ${format}.`,
    );
  }
  // Without `keepMetadata()`, EXIF, XMP and the like are left out.
  const buffer = await image
    .resize({
      ...(width > 0 && { width }),
      ...(height > 0 && { height }),
      fit: mode === 'fit' ? 'inside' : 'cover',
      position:
        mode === 'top' ? 'top' : mode === 'bottom' ? 'bottom' : 'centre',
      withoutEnlargement: true,
    })
    .toFormat(format)
    .toBuffer();
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
