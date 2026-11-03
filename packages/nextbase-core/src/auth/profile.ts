import type { AuthCollection, Field, FileField } from '@nextbasejs/client';
import { fileProblem } from '../files/files.ts';
import type { Logger } from '../logs/logger.ts';
import type { OAuth2ProviderOptions } from './oauth2.ts';

const REMOTE_FILE: unique symbol = Symbol('nextbase.remoteFile');

export interface RemoteFile {
  readonly [REMOTE_FILE]: true;
  readonly url: string;
}

export function remoteFile(url: string): RemoteFile {
  return { [REMOTE_FILE]: true, url };
}

function isRemoteFile(value: unknown): value is RemoteFile {
  return typeof value === 'object' && value !== null && REMOTE_FILE in value;
}

const SIGN_IN_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'email',
  'emailVerified',
  'password',
  'passwordConfirm',
  'oldPassword',
  'tokenKey',
  'phone',
  'phoneVerified',
]);

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const photoTimings: { timeoutMs: number } = { timeoutMs: 5000 };
const MAX_REDIRECTS = 3;

export interface ProfilePolicy {
  name: string;
  mapProfile: OAuth2ProviderOptions['mapProfile'];
  profileFields: Record<string, string> | undefined;
  photoHosts: string[];
  data: Record<string, unknown> | null;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

function claim(
  profile: Record<string, unknown>,
  name: string,
): string | undefined {
  if (name === 'name') {
    return (
      text(profile.name) ??
      text(
        [text(profile.given_name), text(profile.family_name)]
          .filter(Boolean)
          .join(' '),
      )
    );
  }
  if (name === 'picture') {
    return text(profile.picture) ?? text(profile.avatar_url);
  }
  return text(profile[name]);
}

function writable(collection: AuthCollection, name: string): Field | undefined {
  return SIGN_IN_FIELDS.has(name)
    ? undefined
    : collection.fields.find((f) => f.name === name && !f.system);
}

function standardValues(
  collection: AuthCollection,
  policy: ProfilePolicy,
  profile: Record<string, unknown>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [name, claimName] of Object.entries(policy.profileFields ?? {})) {
    const field = writable(collection, name);
    const value = claim(profile, claimName);
    if (!field || value === undefined) continue;
    values[name] = field.type === 'file' ? remoteFile(value) : value;
  }
  return values;
}

export async function profileValues(
  collection: AuthCollection,
  policy: ProfilePolicy,
  profile: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const mapped = policy.mapProfile
    ? await policy.mapProfile(profile, { data: policy.data ?? undefined })
    : {};
  const values = standardValues(collection, policy, profile);
  for (const [name, value] of Object.entries(mapped ?? {})) {
    if (value !== undefined && !SIGN_IN_FIELDS.has(name)) values[name] = value;
  }
  return values;
}

function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const name = host.toLowerCase();
  return allowed.some((pattern) => {
    const p = pattern.toLowerCase();
    return p.startsWith('*.')
      ? name.endsWith(p.slice(1)) && name.length > p.length - 1
      : name === p;
  });
}

async function download(
  url: string,
  hosts: readonly string[],
): Promise<Response> {
  let next = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (next.protocol !== 'https:' || !hostAllowed(next.hostname, hosts)) {
      throw new Error(
        `${next.origin} is not one of the provider's photo hosts.`,
      );
    }
    const response = await fetch(next, {
      redirect: 'manual',
      signal: AbortSignal.timeout(photoTimings.timeoutMs),
    });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      next = new URL(location, next);
      continue;
    }
    if (!response.ok) throw new Error(`The photo answered ${response.status}.`);
    return response;
  }
  throw new Error('The photo redirected too many times.');
}

async function readCapped(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  const length = Number(response.headers.get('content-length'));
  if (length > limit)
    throw new Error(`The photo is larger than ${limit} bytes.`);
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error(`The photo is larger than ${limit} bytes.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

async function fetchPhoto(
  field: FileField,
  url: string,
  hosts: readonly string[],
): Promise<File> {
  const response = await download(url, hosts);
  const bytes = await readCapped(
    response,
    Math.min(MAX_PHOTO_BYTES, field.maxSize),
  );
  const type = response.headers.get('content-type') ?? '';
  const problem = await fileProblem(field, bytes, type);
  if (problem) throw new Error(problem);
  return new File([bytes], field.name, { type });
}

export async function resolveFiles(
  collection: AuthCollection,
  policy: ProfilePolicy,
  values: Record<string, unknown>,
  logger: Logger,
): Promise<Record<string, unknown>> {
  const resolved: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values)) {
    if (!isRemoteFile(value)) {
      resolved[name] = value;
      continue;
    }
    const field = collection.fields.find((f) => f.name === name);
    try {
      if (field?.type !== 'file') {
        throw new Error('A remote file goes in a file field only.');
      }
      resolved[name] = await fetchPhoto(field, value.url, policy.photoHosts);
    } catch (error) {
      logger.failure(
        'oauth2',
        `the ${policy.name} profile photo for ${collection.name}.${name} was not saved`,
        error,
        'warn',
      );
    }
  }
  return resolved;
}
