import { type NextRequest, NextResponse } from "next/server";
import { nextbase } from "@/lib/nextbase";

// Redirects signed-out visitors before protected pages render, so the pages
// need no checks of their own. This is not what protects the data: every
// read through NextBase is filtered by its collection's rules.
export async function proxy(request: NextRequest) {
  if (await nextbase.getSession(request)) return NextResponse.next();
  const signIn = new URL("/sign-in", request.url);
  signIn.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(signIn);
}

// Only the routes that need a session: proxy runs for every matched request,
// prefetches included, and this check reads the database.
export const config = {
  matcher: ["/dashboard/:path*"],
};
