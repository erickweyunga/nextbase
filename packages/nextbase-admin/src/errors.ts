import { ClientError } from '@nextbasejs/client';

export function errorAt(error: unknown, path: readonly (string | number)[]) {
  if (!(error instanceof ClientError)) return undefined;
  let node: unknown = error.data;
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[String(key)];
  }
  const message = (node as { message?: unknown } | undefined)?.message;
  return typeof message === 'string' ? message : undefined;
}
