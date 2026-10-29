import { NextBaseClient } from '@nextbasejs/client';

/** Builds links to the NextBase route handler, such as OAuth2 sign-ins, for the browser to open. */
export const links = new NextBaseClient();

/** `next` from the query, only when it is a path on this app. */
export function returnPath(next: string | string[] | undefined): string {
  return typeof next === 'string' &&
    next.startsWith('/') &&
    !next.startsWith('//') &&
    !next.startsWith('/\\')
    ? next
    : '/dashboard';
}
