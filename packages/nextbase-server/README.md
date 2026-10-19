# NextBase

**Your backend, built into Next.js.** Database, authentication, file storage and
auto-generated APIs, served from your existing Next.js app at `/api/nextbase`.

> Early development. Not ready for production use.

NextBase is four packages, one per layer, so the server is not tied to Next.js:

| Package | For |
| --- | --- |
| `nextbasejs` | The backend. `nextbase.handle(request)` takes a web-standard `Request` and returns a `Response`, so any framework that speaks the Fetch API can mount it. |
| `@nextbasejs/next` | Next.js: route handlers, and a server client that reads `cookies()`. Needs `next`. |
| `@nextbasejs/react` | React: `NextBaseProvider`, `useSession()`, `useNextBase()`. Needs `react`. |
| `@nextbasejs/client` | The SDK, for browsers and any JavaScript runtime. |

```ts
// lib/nextbase.ts
import "server-only";
import { NextBase } from "nextbasejs";

export const nextbase = new NextBase();
```

```ts
// app/api/nextbase/[...path]/route.ts
import { newNextHandler } from "@nextbasejs/next";
import { nextbase } from "@/lib/nextbase";

export const { GET, POST, PUT, PATCH, DELETE } = newNextHandler(nextbase);
```

```ts
import { NextBaseClient } from "@nextbasejs/client";

const nb = new NextBaseClient();
// Creates the account and signs it in, in one request:
await nb.collection("users").signUp({ email, password, passwordConfirm: password });
await nb.collection("users").signInWithPassword(email, password);
const posts = await nb.collection("posts").getList(1, 20, {
  filter: nb.filter("title ~ {:q}", { q }),
  expand: "author",
});
```

`lib/nextbase.ts` imports `server-only`, so importing it into a client
component fails the build.

In server components, server actions and route handlers, call the same API
in-process. `serverClient` reads the session cookie, so it acts as the
signed-in user:

```ts
import { serverClient } from "@nextbasejs/next";

const nb = await serverClient(nextbase);
const session = await nb.getSession();
```

Outside Next.js, pass any cookie store with `get(name)` (and `set` to sign in
and out): `nextbase.client({ cookies })`.

A page that reads through `nextbase.client()` without reading cookies has
nothing that tells Next.js it depends on the request, so Next.js may render it
at build time. Call `await connection()` from `next/server` first, as the
Next.js docs describe for request-time data. `nextbase.client({ superuser: true })`
is for trusted server code only.

## Email: verification, password reset, email change

```ts
import { after } from "next/server";

export const nextbase = new NextBase({
  mail: {
    from: "app@example.com",
    appUrl: "https://example.com", // links: /verify-email, /reset-password, /confirm-email-change
    send: async (message) => {
      // Any provider: Resend, SES, Postmark, SMTP...
    },
  },
  waitUntil: after, // keeps sending alive after the response
});
```

```ts
const users = nb.collection("users");
await users.requestVerification(email);   // emails a link; answers the same for unknown emails
await users.confirmVerification(token);   // on your /verify-email page
await users.requestPasswordReset(email);
await users.confirmPasswordReset(token, password, passwordConfirm); // ends every session
await users.requestEmailChange(newEmail); // signed in; emails the new address
await users.confirmEmailChange(token, currentPassword);
```

Links are built from `appUrl`, never from the request's Host header. Without
`mail`, these answer 400 in production and log the emails in development.
`mail.templates` replaces any default message.

## CLI

```sh
npx nextbase migrate                           # create or upgrade NextBase's tables
npx nextbase superuser --email you@example.com # asks for the password
npx nextbase typegen --out nextbase-types.ts   # types for every collection
```

Each command reads `DATABASE_URL` from the environment, `.env.local` or
`.env`, or takes `--database`. In scripts, `superuser` reads the password from
`NEXTBASE_SUPERUSER_PASSWORD`.

`typegen` writes a record type per collection and a `Collections` map, which
types the client by collection name:

```ts
import type { Collections } from "./nextbase-types";

const nb = new NextBaseClient<Collections>();
const posts = await nb.collection("posts").getList(); // posts.items: PostsRecord[]
```

Run it again after changing collections.

## React

Seed the provider with the session the server read, so client components
render signed in from the first paint and stay current as users sign in and
out:

```tsx
// app/layout.tsx
import { serverClient } from "@nextbasejs/next";
import { NextBaseProvider } from "@nextbasejs/react";

export default async function RootLayout({ children }) {
  const session = await (await serverClient(nextbase)).getSession();
  return (
    <html lang="en">
      <body>
        <NextBaseProvider session={session}>{children}</NextBaseProvider>
      </body>
    </html>
  );
}
```

```tsx
"use client";
import { useNextBase, useSession } from "@nextbasejs/react";

export function UserMenu() {
  const { data, isPending } = useSession();
  const nb = useNextBase();
  if (isPending) return null;
  return data ? <button onClick={() => nb.signOut()}>{data.email}</button> : null;
}
```

Leave `session` out to load it in the browser after mounting; `isPending` is
true until then.

## Protecting pages

Redirect signed-out visitors in `proxy.ts`, so pages need no checks of their
own:

```ts
// proxy.ts
import { type NextRequest, NextResponse } from "next/server";
import { nextbase } from "@/lib/nextbase";

export async function proxy(request: NextRequest) {
  if (await nextbase.getSession(request)) return NextResponse.next();
  return NextResponse.redirect(new URL("/sign-in", request.url));
}

export const config = { matcher: ["/dashboard/:path*"] };
```

- `nextbase.getSession(request)` checks the session against the database,
  so revoked and made-up cookies are redirected too. Proxy runs for every
  matched request, prefetches included, so match only the routes that need it.
- `hasSessionCookie(request)` only checks that a cookie is there, without the
  database. The Next.js docs recommend this kind of optimistic check in proxy;
  anyone can send a cookie, so it proves nothing.
- Proxy is not what protects your data, as the Next.js docs stress: a matcher
  change or a server action on another route can skip it. NextBase's
  collection rules do, wherever data is read through `nextbase.client()` or the
  API. Server actions that write should still go through NextBase, never
  around it.

## Database

- **Postgres 16 or newer**, with `DateStyle` ISO (the default).
- **Connection string:** `DATABASE_URL`, or the `database` option. NextBase's
  pool releases idle connections after 5 seconds and calls Vercel's
  `attachDatabasePool`, which does nothing elsewhere. A pool you pass in is
  yours: give it the same treatment, as Vercel's connection pooling guide shows.
- **Connection poolers** (PgBouncer in transaction mode, Supavisor, Neon's
  pooler) are supported: NextBase uses no session state.
- **Statement timeout:** records API requests run with a transaction-scoped
  `statement_timeout`, 8 seconds by default (`statementTimeout`, `0` to turn it
  off). It works through transaction poolers. For everything else, set one on
  the database role, for example `ALTER ROLE app SET statement_timeout = '30s'`.

## Cross-site requests

Writes that authenticate with the session cookie must come from this host. A
frontend on another subdomain is allowed with `trustedOrigins`, written as
Next.js's `serverActions.allowedOrigins`. Behind a proxy you run that rewrites
`Host`, set `trustProxy: true` to read `X-Forwarded-Host`; on Vercel, `Host` is
already the domain the client used.

```ts
new NextBase({ trustedOrigins: ["app.example.com"] });
```
- **View collections** need NextBase's database user to have the `CREATEROLE`
  attribute, to create the role views run as.

The admin UI is served at `/api/nextbase/_`.
