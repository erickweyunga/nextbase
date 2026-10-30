import { availableParallelism } from 'node:os';
import type { FileField } from '@nextbasejs/client';
import type SharpConstructor from 'sharp';
import { ApiError } from '../errors.ts';
import type { Logger } from '../logs/logger.ts';
import type { Storage } from './storage.ts';

// Thumbnails of an image file live beside it, at
// `<collection id>/<record id>/thumbs_<name>/<size>_<name>`, made on the
// first request for a size and kept until the file is removed. A file that
// can never be thumbed gets a `.failed` marker there instead, so no instance
// decodes it again.

const SIZE = /^(0|[1-9]\d{0,3})x(0|[1-9]\d{0,3})(t|b|f)?$/;
const MAX_SIDE = 2500;
export const MAX_THUMBS = 20;
/** Served for every image field, listed or not. */
const DEFAULT_SIZE = '100x100';
/** Decoded images larger than this are not thumbed. */
const MAX_PIXELS = 50_000_000;
/** Images with a longer side, or a more extreme aspect ratio, are not thumbed. */
const MAX_SOURCE_SIDE = 16_384;
const MAX_ASPECT = 50;
/** How long sharp may work on one thumbnail. */
const TIMEOUT_SECONDS = 10;
const FAILED_MARKER = '.failed';
/** Thumbnails known to be stored, so repeat views skip the existence check. */
const MAX_KNOWN = 10_000;
/** Files known to fail, in front of their markers. */
const MAX_FAILED = 1000;

interface ThumbLimits {
  slots: number;
  waitMs: number;
  queued: number;
  maxBytes: number;
}

/**
 * How many thumbnails are made at once in the process, how long a request
 * waits for its turn and how many may wait, and the largest file read.
 * Tests lower them; apps have no reason to.
 */
export const thumbLimits: ThumbLimits = {
  slots: availableParallelism(),
  waitMs: 10_000,
  queued: 100,
  maxBytes: 50 * 1024 * 1024,
};

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
  const suffix = match[3];
  if (width === 0 && height === 0) return undefined;
  if (width > MAX_SIDE || height > MAX_SIDE) return undefined;
  // One side scales the other: nothing is cropped or fit.
  if (suffix !== undefined && (width === 0 || height === 0)) return undefined;
  const mode =
    suffix === 't'
      ? 'top'
      : suffix === 'b'
        ? 'bottom'
        : suffix === 'f'
          ? 'fit'
          : 'center';
  return { width, height, mode };
}

/** Why a field's thumb size is invalid, or undefined when it is valid. */
export function thumbSizeProblem(size: string): string | undefined {
  if (parseSize(size)) return undefined;
  return `Must be WIDTHxHEIGHT without leading zeros, such as 100x100, with sides up to ${MAX_SIDE}. One side may be 0, not both; t, b or f may follow only when neither is.`;
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

let sharpModule: Promise<{ sharp: Sharp } | { error: unknown }> | undefined;

// sharp is an optional peer dependency: without it, originals are served.
function loadSharp(): Promise<{ sharp: Sharp } | { error: unknown }> {
  sharpModule ??= (async () => {
    try {
      return { sharp: (await import('sharp')).default };
    } catch (error) {
      return { error };
    }
  })();
  return sharpModule;
}

/** Whether `error` says sharp itself is not installed. */
function isSharpMissing(error: unknown): boolean {
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') &&
    typeof message === 'string' &&
    /Cannot find (package|module) 'sharp'/.test(message)
  );
}

/** Bounded, least recently used first out. */
class Recent {
  readonly #max: number;
  readonly #keys = new Set<string>();

  constructor(max: number) {
    this.#max = max;
  }

  has(key: string): boolean {
    if (!this.#keys.delete(key)) return false;
    this.#keys.add(key);
    return true;
  }

  add(key: string): void {
    this.#keys.delete(key);
    this.#keys.add(key);
    if (this.#keys.size > this.#max) {
      const oldest = this.#keys.values().next().value;
      if (oldest !== undefined) this.#keys.delete(oldest);
    }
  }
}

/**
 * Runs at most `thumbLimits.slots` tasks at once. The rest wait their turn,
 * up to `queued` of them for at most `waitMs`; past either, a task is not run.
 */
class Semaphore {
  readonly #waiting: ((run: boolean) => void)[] = [];
  #running = 0;

  async run<T>(task: () => Promise<T>): Promise<{ done: T } | undefined> {
    if (this.#running >= thumbLimits.slots) {
      if (this.#waiting.length >= thumbLimits.queued) return undefined;
      const turn = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          const at = this.#waiting.indexOf(wake);
          if (at !== -1) this.#waiting.splice(at, 1);
          resolve(false);
        }, thumbLimits.waitMs);
        const wake = (run: boolean): void => {
          clearTimeout(timer);
          resolve(run);
        };
        this.#waiting.push(wake);
      });
      if (!turn) return undefined;
    } else {
      this.#running++;
    }
    try {
      return { done: await task() };
    } finally {
      const next = this.#waiting.shift();
      // The next task takes this one's place.
      if (next) next(true);
      else this.#running--;
    }
  }
}

// Shared by every instance: decoding uses the process's CPUs and memory.
const making = new Semaphore();

/** A file that will never give a thumbnail, whatever the size. */
class Unthumbable extends Error {}

/** sharp's errors that may not happen on another try. */
function isTemporary(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|out of memory/i.test(message);
}

/**
 * Makes thumbnails on request. Each size of each file is made once at a
 * time per instance; requests for it meanwhile wait for that one.
 */
export class Thumbs {
  readonly #storage: Storage;
  readonly #logger: Logger;
  /** Thumbnails being made, by key: whether they were stored. */
  readonly #making = new Map<string, Promise<boolean>>();
  readonly #known = new Recent(MAX_KNOWN);
  readonly #failed = new Recent(MAX_FAILED);
  #loggedLoad = false;

  constructor(storage: Storage, logger: Logger) {
    this.#storage = storage;
    this.#logger = logger;
  }

  /**
   * The thumbnail's key to serve for `size` of the file at `key`, made if
   * missing, or undefined when the original is to be served instead: the
   * size is not one of the field's, the file is not an image NextBase
   * thumbs, or making it failed.
   */
  async keyOf(
    field: FileField,
    key: string,
    size: string,
  ): Promise<string | undefined> {
    if (size !== DEFAULT_SIZE && !field.thumbs.includes(size)) return undefined;
    const thumb = parseSize(size);
    const name = key.slice(key.lastIndexOf('/') + 1);
    const format = formatOf(name);
    if (!thumb || !format) return undefined;
    const target = `${thumbsPrefix(key)}${size}_${name}`;
    if (this.#known.has(target)) return target;
    if (this.#failed.has(key)) return undefined;
    try {
      if ((await this.#storage.size(target)) !== undefined) {
        this.#known.add(target);
        return target;
      }
    } catch (error) {
      this.#logger.failure('storage', 'checking for a thumbnail failed', error);
      return undefined;
    }
    let made = this.#making.get(target);
    if (!made) {
      made = this.#make(key, target, thumb, format).finally(() =>
        this.#making.delete(target),
      );
      this.#making.set(target, made);
    }
    if (!(await made)) return undefined;
    this.#known.add(target);
    return target;
  }

  async #make(
    key: string,
    target: string,
    size: ThumbSize,
    format: Format,
  ): Promise<boolean> {
    const marker = `${thumbsPrefix(key)}${FAILED_MARKER}`;
    const sharp = await this.#sharp();
    if (!sharp) return false;
    let bytes: number | undefined;
    try {
      if ((await this.#storage.size(marker)) !== undefined) {
        this.#failed.add(key);
        return false;
      }
      bytes = await this.#storage.size(key);
    } catch (error) {
      this.#logger.failure('storage', 'reading a file to thumb failed', error);
      return false;
    }
    if (bytes === undefined) throw new ApiError(404, 'File not found.');
    if (bytes > thumbLimits.maxBytes) {
      return this.#fail(
        key,
        marker,
        new Unthumbable(
          `The file has more than ${thumbLimits.maxBytes} bytes.`,
        ),
      );
    }
    const ran = await making.run(async () => {
      let input: Uint8Array | undefined;
      try {
        const file = await this.#storage.read(key);
        if (file) {
          input = new Uint8Array(await new Response(file.body).arrayBuffer());
        }
      } catch (error) {
        this.#logger.failure(
          'storage',
          'reading a file to thumb failed',
          error,
        );
        return false;
      }
      if (!input) throw new ApiError(404, 'File not found.');
      try {
        return await resize(sharp, input, size, format);
      } catch (error) {
        if (isTemporary(error)) {
          this.#logger.failure(
            'thumbs',
            `making the ${target} thumbnail failed, so the original is served`,
            error,
            'warn',
          );
          return false;
        }
        return this.#fail(key, marker, error);
      }
    });
    // Too busy: the original serves this request, and a later one tries again.
    if (ran === undefined || typeof ran.done === 'boolean') return false;
    try {
      await this.#storage.put(target, ran.done, `image/${format}`);
    } catch (error) {
      this.#logger.failure('storage', 'storing a thumbnail failed', error);
      return false;
    }
    await this.#checkOriginal(key);
    return true;
  }

  /** Remembers a file that will never give a thumbnail. */
  async #fail(key: string, marker: string, error: unknown): Promise<false> {
    this.#logger.failure(
      'thumbs',
      `making a thumbnail of ${key} failed, so the original is served`,
      error,
      'warn',
    );
    this.#failed.add(key);
    try {
      await this.#storage.put(marker, new Uint8Array(), 'text/plain');
    } catch (cause) {
      this.#logger.failure(
        'storage',
        'storing a thumbnail marker failed',
        cause,
      );
      return false;
    }
    await this.#checkOriginal(key);
    return false;
  }

  /**
   * Written while the file was being removed, after the removal deleted its
   * thumbnails: deletes what was written, and the file is gone.
   */
  async #checkOriginal(key: string): Promise<void> {
    if ((await this.#storage.size(key)) !== undefined) return;
    await this.#storage.deletePrefix(thumbsPrefix(key));
    throw new ApiError(404, 'File not found.');
  }

  /** sharp, or undefined when it cannot be imported, logged once. */
  async #sharp(): Promise<Sharp | undefined> {
    const loaded = await loadSharp();
    if ('sharp' in loaded) return loaded.sharp;
    if (!this.#loggedLoad) {
      this.#loggedLoad = true;
      if (isSharpMissing(loaded.error)) {
        this.#logger.failure(
          'thumbs',
          'making thumbnails needs sharp, so originals are served. Install it',
          loaded.error,
          'warn',
        );
      } else {
        this.#logger.failure(
          'thumbs',
          'loading sharp failed, so originals are served',
          loaded.error,
        );
      }
    }
    return undefined;
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
  const info = await image.metadata();
  // The bytes must be the image the extension says, never SVG, PDF or
  // another format a decoder could read.
  if (info.format !== format) {
    throw new Unthumbable(
      `The file holds ${info.format ?? 'unknown'} data, not ${format}.`,
    );
  }
  // Under the pixel limit, a thin strip can still take seconds to decode.
  const sourceWidth = info.width ?? 0;
  const sourceHeight = info.pageHeight ?? info.height ?? 0;
  const long = Math.max(sourceWidth, sourceHeight);
  const short = Math.min(sourceWidth, sourceHeight);
  if (long > MAX_SOURCE_SIDE || short === 0 || long / short > MAX_ASPECT) {
    throw new Unthumbable(
      `The image is ${sourceWidth}x${sourceHeight}: sides must be at most ${MAX_SOURCE_SIDE}, at most ${MAX_ASPECT} times the other.`,
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
    .timeout({ seconds: TIMEOUT_SECONDS })
    .toBuffer();
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
