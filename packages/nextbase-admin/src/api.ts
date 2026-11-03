import { NextBaseClient } from '@nextbasejs/client';

export function apiBasePath(document: Document, pathname: string): string {
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="nextbase-base-path"]',
  );
  return meta?.content || pathname.replace(/\/_\/?$/, '');
}

const apiRoot = new URL(
  `${apiBasePath(document, window.location.pathname)}/`,
  window.location.origin,
);

export const nb = new NextBaseClient({ baseUrl: apiRoot.href });

export function apiUrl(path: string): URL {
  return new URL(path, apiRoot);
}
