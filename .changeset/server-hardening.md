---
"@nextbasejs/core": patch
"@nextbasejs/next": patch
---

A response that sets a cookie, such as a public file sent while renewing a session, is now `private, no-store`, so a CDN cannot store it and hand one user's session to others. Server actions and route handlers using the server-side client now renew the session cookie, so users of apps without browser API calls are no longer signed out after 7 days; server components, which cannot set cookies, never extend a session. Form data requests are limited to 1000 parts, counted before parsing, and repeated keys no longer take quadratic time. `nextbase superuser` reads both password lines from piped input instead of hanging. A `basePath` that is not an absolute URL path, such as `api/nextbase`, throws a TypeError instead of answering 404 to every request. The server-side client honours `signal`: an aborted request rejects as with `fetch`.
