import { NextBaseClient } from '@nextbasejs/client';

const apiRoot = new URL(
  `${window.location.pathname.replace(/\/_\/?$/, '')}/`,
  window.location.origin,
);

export const nb = new NextBaseClient({ baseUrl: apiRoot.href });

export function apiUrl(path: string): URL {
  return new URL(path, apiRoot);
}
