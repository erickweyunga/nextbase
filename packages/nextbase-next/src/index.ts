import type { NextBaseClient } from "@nextbase/client";
import type {
  NextBase,
  RouteHandler,
  ServerClientOptions,
} from "@nextbase/server";
import { cookies } from "next/headers";

/** The route handler exports of `app/api/nextbase/[...path]/route.ts`. */
export interface NextRouteHandlers {
  GET: RouteHandler;
  POST: RouteHandler;
  PUT: RouteHandler;
  PATCH: RouteHandler;
  DELETE: RouteHandler;
}

/**
 * Route handlers that mount `nextbase` in the App Router:
 *
 * ```ts
 * export const { GET, POST, PUT, PATCH, DELETE } = newNextHandler(nextbase);
 * ```
 *
 * Next.js runs HEAD through GET and answers OPTIONS itself. No route takes
 * PUT, but routing it to NextBase answers 405 with an Allow header.
 */
export function newNextHandler(nextbase: NextBase): NextRouteHandlers {
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
 * A client for server components, server actions and route handlers that
 * acts as the user of the session cookie, read with Next.js's `cookies()`.
 * In server actions and route handlers, signing in with `{ cookie: true }`
 * and signing out update the cookie. Call it per request.
 */
export async function serverClient(
  nextbase: NextBase,
  options: Omit<ServerClientOptions, "cookies"> = {},
): Promise<NextBaseClient> {
  return nextbase.client({ ...options, cookies: await cookies() });
}
