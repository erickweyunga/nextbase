import { type NextRequest, NextResponse } from "next/server";
import { nextbase } from "@/lib/nextbase";

// Redirects signed-out visitors early. It does not protect data: collection rules do.
export async function proxy(request: NextRequest) {
  if (await nextbase.getSession(request)) return NextResponse.next();
  const signIn = new URL("/sign-in", request.url);
  signIn.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(signIn);
}

// Match only routes that need a session: this check reads the database on every
// matched request, prefetches included.
export const config = {
  matcher: ["/dashboard/:path*"],
};
