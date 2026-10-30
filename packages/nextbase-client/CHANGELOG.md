# @nextbasejs/client

## 0.1.10

### Patch Changes

- 92aea2b: Superusers can impersonate a record of an auth collection with `POST /collections/{collection}/impersonate/{id}`, or `nb.collection("users").impersonate(id)` in the SDK, which returns a new client signed in as the record and leaves the superuser's own auth store alone. The session lasts 60 to 3600 seconds, an hour by default, skips the collection's `authRule`, is never extended, and ends when its superuser is deleted or changes their password. With `cookie: true`, which needs the superuser on a cookie session, the browser's cookie session becomes the record's, and signing out restores the superuser's, answering 200 with their record so the SDK's store holds it again. An impersonation session cannot change the password, email, phone, verification or identity fields of any account, use the email, password reset or phone flows, link or unlink an OAuth2 provider, be refreshed, revoke other sessions or impersonate, and its file tokens act as it and stop working when it ends. It shows in the record's sessions with `impersonatedBy`, which `GET /session`, hooks and rules (`@request.impersonatedBy`) see too. Each impersonation is logged with `data.type` `impersonate`, whatever `minLevel` is, and request log entries name the superuser in `impersonatedBy`. `nb.withAuthStore(store)` returns a client of the same server with another auth store.
- 0c15929: Clients can subscribe to records as they are created, updated and deleted. List the collections in the new `realtime` option of `new NextBase()`, or pass `true`, then call `collection(name).subscribe("*" or an id, callback, { filter, expand, fields, onReset, onError })` in the client. Each subscriber gets only the records its list or view rule and filter allow, shaped as a list request would return them, once and in commit order; writes that roll back send nothing. Events are logged in the write's transaction and take their position in the log as it commits. All subscriptions of a client share one streamed request that resumes after the last event it received, ends on its own before Vercel's limit (`streamSeconds`, 240 by default), and starts over when the session changes; `onReset` is called once a subscription is live and whenever events may have been missed. Event ids are signed for the caller, so they cannot be used to replay events under someone else's session or after the signed-in record changed. Each instance reads new events once for all its streams and serves at most 1000 of them. Behind a transaction pooler, set `realtime.listenUrl` to a direct connection string.
- 1425a28: NextBase keeps a log of HTTP requests and background failures in the database, for 7 days by default. Each request gets one entry with its method, URL (with `token`, `code` and `state` redacted), status, time taken, the caller's collection, user agent, referer and, when it failed, the error, its field errors and, for unexpected errors, the stack. Bodies, cookies, the Authorization header and Postgres error details are never recorded. After hooks, file deletes, emails, texts, realtime cleanup and unexpected OAuth2 sign-in errors are logged at error too, and an OAuth2 sign-in that fails and redirects back is logged at warn with its error code. Entries are written in the background, a burst at a time with one insert at a time per instance, and never fail a request; `nextbase.flush()` writes those still waiting, for use before ending a pool or exiting. Superusers read them through `GET /logs`, `GET /logs/{id}` and `GET /logs/stats` with filters over `level`, `message` and `data.*`, or `nb.logs` in the client, and clear them with `DELETE /logs`. The new `logs` option sets `maxDays`, `minLevel`, `authId` and `ip`, or turns logs off with `false`. The new `clientIp` option says where the client's IP comes from: Vercel's headers on Vercel by default, a header your proxy sets with `trustedHops`, or a function. The OAuth2 callback answers 404 for a provider that is not set up, instead of failing with a 500.
- 320fe04: File fields take `thumbs`, up to 20 thumbnail sizes such as `300x200` (crop from the centre), `300x200t` and `300x200b` (from the top or bottom), `300x200f` (fit inside), `0x200` and `300x0` (one side), with sides up to 2500; `100x100` is always allowed. `GET /files/...?thumb=300x200`, or `nb.files.getUrl(record, name, { thumb })`, serves a JPEG, PNG, GIF or WebP image in that size, made with sharp on the first request, once per instance at a time, and stored beside the file under `thumbs_<name>/`, with the same access checks, cache headers and bucket redirects as the file. Thumbnails keep the image's format, are never enlarged, follow its EXIF orientation, leave out its metadata, and show the first frame of an animated GIF. Sizes are canonical: no leading zeros, and `t`, `b` or `f` only when neither side is 0. Other sizes, other types of file, files over 50 MB, images that cannot be read, have more than 50 megapixels, a side over 16384 or an aspect ratio over 50:1, requests that would wait too long for a free slot, and servers without sharp get a 302 to the file's own URL without `thumb`, with `Cache-Control: no-store`. Images whose header shows they can never be thumbed get a `.failed` marker beside the file so no instance reads them again; a size whose resize fails is tried again after 5 minutes. Both are logged as warnings with `data.type` `thumbs`; other errors loading sharp than its absence are logged as errors. Thumbnails are deleted with their file, record or collection. sharp is an optional peer dependency of `@nextbasejs/core`: install it to make thumbnails.

## 0.1.9

### Patch Changes

- defa6f0: Auth requests that overlap no longer save an older state over a newer one: of sign-ins and sign-outs, the one started last wins, and `getSession()` and `refreshSession()` leave the auth store alone if it changed while they were in flight, so a late answer no longer signs a user back in or mixes one account's token with another's record. Deleting a record signs out only if it is still the signed-in one. Direct uploads to the bucket stop when the request's `signal` aborts, and fail with a `ClientError`. `ClientError` has `isTimeout` for a signal that timed out, and `isAbort` is now true for any other abort reason, also when aborted while the response body arrived. Sign-up, sign-in and refresh apply `expand` and `fields` to the returned record, under the same rules as record routes.

## 0.1.8

### Patch Changes

- 4490925: `NextBaseProvider` follows a new `session` from the server, so signing in or out in a server action shows without a reload, and `useSession` subscribes once instead of on every render. A session signed in to another collection than a request needs now gets a 403 instead of a 401, so the client no longer signs it out. Responses to requests with no session carry `NextBase-Session: none`, and the client signs out a cookie session that ended. In-process clients use the cookie of the page's scheme, so server components see the session under `next dev --experimental-https`. An update with `fields` keeps the signed-in record current, a batch uploads its files to the bucket instead of sending them as `{}`, the SDK decides on direct uploads by a write's total size, and auth stores no longer leak a storage listener.

## 0.1.7

No changes in this release.

## 0.1.6

No changes in this release.

## 0.1.5

No changes in this release.

## 0.1.4

### Patch Changes

- 3df2d46: File uploads for `file` fields: send files with a record as form data, or, with storage in an S3-compatible bucket (the new `storage.s3` option), straight to the bucket for large files, which the SDK does automatically above 4 MB. Types are checked from the file's bytes, names are generated, and files are deleted with their record, field or collection. Download with `nb.files.getUrl()`; protected fields follow the view rule, with `nb.files.getToken()` for links.
  
  **Breaking:** NextBase now needs Node.js 22 or later, as Node.js 20 reached end of life.

## 0.1.3

### Patch Changes

- 419e109: OAuth2 providers now call back to `{basePath}/callback/{provider}`, and a sign-in must return from the provider it started with. Changing a password while signed in, and unlinking a provider, email the owner, once the change is saved. `revokeOtherSessions()` signs out every other device. Deleting an account or collection deletes its sessions.
- 127629b: **Breaking:** auth names are clearer now that records have both an email and a phone.
  
  - The auth record field `verified` is now `emailVerified`. A migration renames the column and rewrites rules that use it, such as `authRule: "verified = true"` or `@request.auth.verified`. Update your own code that reads or writes `verified`, and the SQL of any view collection that selects it.
  - `requestVerification()` and `confirmVerification()` are now `requestEmailVerification()` and `confirmEmailVerification()`, at `/request-email-verification` and `/confirm-email-verification`.
  
  Unreleased features were also renamed before their first release: `phoneSignIn` (collection option), `rejectBreachedPasswords` (option), `listLinkedAccounts()`, `unlinkAccount()` and `/linked-accounts`, and new `linkOAuth2()` and `requestPasswordResetByPhone()` methods.
- 5e05113: Point the documentation links to nextbase.goomzo.com.
- b8180be: Sign in with OAuth2: Google, GitHub and any OpenID Connect provider, through the new `appUrl` and `oauth2` options. Sign-in failures can return to their own `errorRedirect` page. Users can link and unlink providers, and `listAuthMethods()` lists the providers. `mail.appUrl` now defaults to `appUrl`.
- ccb21ce: Phone sign-in: a `phone` field type and `phone`/`phoneVerified` system fields on auth collections, and, for collections with `phoneSignIn`, sign-in and sign-up with codes texted through the new `sms` option, phone and password sign-in, password reset by SMS, and phone verification and change. Codes are six digits, expire after 10 minutes and work once; texts are limited per phone and optionally to a list of countries.

## 0.1.2

### Patch Changes

- c654eaf: Publish from GitHub Actions with npm trusted publishing, so each release carries provenance.

## 0.1.1

### Patch Changes

- ccbf0ea: The server package is now `@nextbasejs/core`, replacing `nextbasejs`, so every package lives under the `@nextbasejs` scope. Install `@nextbasejs/core` and import `NextBase` from it; `@nextbasejs/next` now takes it as its peer dependency.

## 0.1.0

### Minor Changes

- First release: a backend for your app on Postgres, with collections, access rules, auth and sessions, served from any framework that speaks web-standard Request and Response, plus the SDK, Next.js route handlers and React hooks.
