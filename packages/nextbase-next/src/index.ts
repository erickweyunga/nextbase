import type { NextBaseClient, RecordModel } from '@nextbasejs/client';
import type {
  NextBase,
  RouteHandler,
  ServerClientOptions,
} from '@nextbasejs/core';
import { cookies, headers } from 'next/headers';

/** Exports of `app/api/nextbase/[...path]/route.ts`. */
export interface NextRouteHandlers {
  GET: RouteHandler;
  POST: RouteHandler;
  PUT: RouteHandler;
  PATCH: RouteHandler;
  DELETE: RouteHandler;
}

/**
 * App Router handlers for `nextbase`. HEAD and OPTIONS are handled by Next.js.
 *
 * ```ts
 * export const { GET, POST, PUT, PATCH, DELETE } = newNextHandler(nextbase);
 * ```
 */
export function newNextHandler<C extends Record<string, RecordModel>>(
  nextbase: NextBase<C>,
): NextRouteHandlers {
  const { handle } = nextbase;
  return {
    GET: handle,
    POST: handle,
    PUT: handle,
    PATCH: handle,
    DELETE: handle,
  };
}

/**
 * A client acting as the session cookie's user. Call it per request; in server
 * actions and route handlers, sign-in with `{ cookie: true }`, sign-out and
 * session renewal update the cookie. Server components cannot set cookies.
 * It is typed like `nextbase`, as by `new NextBase<Collections>()`.
 */
export async function serverClient<C extends Record<string, RecordModel>>(
  nextbase: NextBase<C>,
  options: Omit<ServerClientOptions, 'cookies'> = {},
): Promise<NextBaseClient<C>> {
  // Next.js sets it from the connection when no proxy did.
  const proto = (await headers()).get('x-forwarded-proto');
  return nextbase.client({
    ...(proto !== null && { secure: proto.split(',')[0]?.trim() === 'https' }),
    ...options,
    cookies: await cookies(),
  });
}
