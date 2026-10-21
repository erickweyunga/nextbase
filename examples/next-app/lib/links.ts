import { NextBaseClient } from "@nextbasejs/client";

/**
 * Builds links to the NextBase route handler, such as OAuth2 sign-ins, which
 * the browser opens itself. Never sends a request.
 */
export const links = new NextBaseClient();

/** `next` from the query when it is a path on this app, so it is safe to return to. */
export function returnPath(next: string | string[] | undefined): string {
  return typeof next === "string" &&
    next.startsWith("/") &&
    !next.startsWith("//") &&
    !next.startsWith("/\\")
    ? next
    : "/dashboard";
}
