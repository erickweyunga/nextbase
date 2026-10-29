---
"@nextbasejs/core": patch
"@nextbasejs/client": patch
---

NextBase keeps a log of HTTP requests and background failures in the database, for 7 days by default. Each request gets one entry with its method, URL (with `token`, `code` and `state` redacted), status, time taken, the caller's collection, user agent, referer and, when it failed, the error, its field errors and, for unexpected errors, the stack. Bodies, cookies, the Authorization header and Postgres error details are never recorded. After hooks, file deletes, emails, texts and realtime cleanup that fail in the background are logged at error too. Entries are written in the background, a burst at a time, and never fail a request. Superusers read them through `GET /logs`, `GET /logs/{id}` and `GET /logs/stats` with filters over `level`, `message` and `data.*`, or `nb.logs` in the client, and clear them with `DELETE /logs`. The new `logs` option sets `maxDays`, `minLevel`, `authId` and `ip`, or turns logs off with `false`. The new `clientIp` option says where the client's IP comes from: Vercel's headers on Vercel by default, a header your proxy sets with `trustedHops`, or a function.
