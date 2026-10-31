# nextbasejs

## 0.2.1

### Patch Changes

- 309705f: Sign-in by a code emailed to the account, with no password. Turn it on with the auth collection option `otp: { enabled: true, duration }` (codes work 180 seconds by default). `requestOtp(email)` answers an id whether or not the account exists, and `signInWithOtp(otpId, code)` signs in, counting the email verified. A code works once, five wrong ones end its id, wrong ones are capped per address the same whether or not an account has it, a code sent before the email changed signs in nothing, and proving the email drops providers linked before, as the verification link does. It is the `emailCode` method for multi-factor sign-in, and `auth-methods` lists it as `otp`.
- 309705f: A request that read a provider token as due no longer refreshes it a second time after another request already did: a refresh is claimed only while the stored tokens are still those the request read.
- 7b7db0a: A realtime stream over 50 topics, or over the weight of 100, now refuses only the topics past the limit, so the client ends just those subscriptions and keeps the rest. The client shares one topic between identical subscriptions. `useRecords` reloads during a steady stream of changes instead of waiting for a pause, and no longer patches the wrong item when `fields` leaves out `id`.
- 7b7db0a: Sign-in by email code is off when the collection's `authRule` is `null`, and a code the `authRule` refuses no longer marks the email verified. A password sign-in that `validateSignIn` refuses answers the app's refusal even when the email is not verified, and sends no verification link.
- 309705f: The `validateSignIn` option decides who may sign up, link an OAuth2 provider or sign in, at each one and by every method (password, OAuth2 in the browser or by ID token, phone code, email code). It sees the action, the method, the collection, the account (for a sign-up, its values; never the password), and for OAuth2 the provider's profile as it is at this sign-in, and refuses by answering `{ error, message }`: a 403 with the code in `data.account.code`, or `?error=` for an OAuth2 sign-in in the browser. A sign-up is refused before anything is written. Accounts callers create through the records API or a batch are checked as sign-ups too.
- Updated dependencies [309705f]
- Updated dependencies [7b7db0a]
  - @nextbasejs/client@0.2.1

## 0.2.0

### Minor Changes

- bfebd87: Breaking changes, so this is a minor version:
  
  - `linkOAuth2` is async and needs `{ password }` (plus `mfaCode` with an authenticator app); linking starts with `POST /collections/{collection}/link-oauth2/{provider}`, and `?link=true` on `auth-with-oauth2` answers 400.
  - Changing the phone and unlinking a provider need the current password, and an email change from a verified address must be approved from that inbox first (`approveEmailChange`).
  - Deleting your own account needs the password once the session is older than a day (or `requestAccountDeletion`), plus `mfaCode` with an authenticator app.
  - `signUp` can return `{ mfa: "verify" }`; sessions and auth responses carry `methods`.
  - Rate limits are on by default (since 0.1.10).

### Patch Changes

- 1f741f6: Deleting your own account needs more than a session: the current `password`, or a session signed in within the last day, plus `mfaCode` with an authenticator app. `delete(id, { password, mfaCode })` sends them in the body of `DELETE`, and rules never see them. Accounts that can do neither, such as ones that signed up through a provider, confirm by email: `requestAccountDeletion()` sends a link to `/delete-account`, and `confirmAccountDeletion(token)` deletes the account as its owner, so the delete rule still decides. After a day without the password, the 400 asks for it or to sign in again. A cascade from another record that reaches the caller's own account asks the same, the delete rule is checked before any password, and a link is never sent when the delete rule is `null`. Superusers and other deleters are unchanged, and an impersonation session cannot delete the account it acts as. A `DELETE` with an empty body is still accepted whatever its Content-Type. The new `implicitLinking` collection option (default `true`) turns off linking a provider to an existing account by email; such a sign-in answers `account_exists`. An account that takes a second sign-in step is never linked by email, since whoever holds its inbox could otherwise add a provider as a second step. How each password was set is now recorded while MFA is off too, and `nextbase.verifyPassword(collection, id, password)` checks a password from server code.
- 2d6d573: Auth collections have an `emailVerification` option, `{ required, sendOnSignUp, sendOnSignIn }`, each off by default. `required` refuses sign-ins and refreshes of accounts with an unverified email (403, "Verify your email to sign in."; accounts without an email are not affected), ends their sessions from before (not a superuser's impersonation), and answers a sign-up with an already registered email with the same 202 as a new one, and the same errors for its other fields, while emailing the owner (`signUpAttempt`). `_superusers` keeps every option off. `sendOnSignUp` sends the verification link when an account signs up, and `sendOnSignIn` sends it again when an unverified account signs in with the right password. A link that cannot be sent never fails the request.
- 1f741f6: Sign-ins can take a second step. Each auth collection, `_superusers` included, has an `mfa` setting: `enabled`, a `rule` saying which accounts must take it (`null` for accounts with an authenticator app, `""` for all, or a filter), and a `duration` from 60 to 3600 seconds. A first step that needs a second answers `401` with an `mfaId` and the `methods` left, and starts no session. The second step is an authenticator app code (TOTP), a recovery code, a code sent to the verified email or phone, a password, or a linked OAuth2 provider. It is never the first method again, only the app or a recovery code once an app is set up, and only the app or a recovery code for superusers, who add their first app with `nextbase superuser mfa-setup <email>`. A password reset by email or text does not pair with a code sent to the same place for 24 hours, and the owner is told; a password made up at an OAuth2 or phone sign-up is never a step. After an OAuth2 sign-in, the `mfaId` is kept in an `HttpOnly` cookie, the app's redirect gets `mfa=required`, and `GET /collections/{c}/mfa` reads the methods. Records manage their app at `records/{id}/mfa`, `totp`, `totp/confirm` and `recovery-codes`; setting one up always needs the current password, and its secret is encrypted with the new `secretKey` option (`NEXTBASE_SECRET_KEY`). Superusers clear another record's app with `DELETE records/{id}/mfa`, and `nextbase superuser mfa-reset <email>` removes a superuser's. Once an app is set up, removing it, regenerating recovery codes, confirming an email change and changing the password with `oldPassword` need a code as `mfaCode`. Setting or changing the phone and linking or unlinking a provider now need the current password, plus `mfaCode` with an app; a link starts with `POST /collections/{c}/link-oauth2/{provider}` instead of `?link=true`. A verified email's inbox must approve an email change, at `/approve-email-change`, before the new address gets its link. Sessions record how they signed in as `methods`, returned in auth responses and session lists and read by rules as `@request.mfa`; impersonation sessions record `impersonation` and skip the second step. A sign-up that has no second step to take yet answers `202` with `{ "mfa": "verify" }`. The SDK keeps its auth store on a `401` that asks for a second step, and adds `isMfaRequired()`, `signInWithTotp()`, `signInWithRecoveryCode()`, `requestEmailCode()`, `signInWithEmailCode()`, `requestMfaPhoneCode()`, `signInWithMfaPhoneCode()`, `getPendingMfa()`, `approveEmailChange()`, `oauth2LinkUrl()`, an `mfaId` option on `signInWithPassword()` and `signInWithOAuth2()`, and `getMfa()`, `startTotp()`, `confirmTotp()`, `removeTotp()`, `regenerateRecoveryCodes()` and `clearMfa()`.
- a26be60: Native apps sign in with an ID token from a provider's own SDK, such as Google Sign-In or Sign in with Apple: `signInWithIdToken(provider, token, { nonce })`, or `POST /collections/{collection}/auth-with-id-token/{provider}`. The token must be signed by the provider's OpenID Connect keys, issued to one of its client ids, unexpired, carry the nonce (as is or hashed) when one is given, and is accepted once. A provider's `clientId` can be a list, such as the web, iOS and Android apps' ids; the browser sign-in uses the first.
- a26be60: OAuth2 providers take `scopes` (asked for besides the ones NextBase needs), `prompt`, `params` for the provider's authorization page (NextBase's own parameters are refused), `disableSignUp` (existing accounts only; new ones fail with `sign_up_disabled`), and `mapProfile(profile, { data })`, which fills a new account's fields from the ID token's claims or GitHub's user. Sign-in fields are never taken from it, and the create rule and field checks still apply. A sign-in can pass its own `params` and untrusted `data` (a JSON object of at most 2 KB) for `mapProfile`: `signInWithOAuth2(provider, { params, data })`.
- a26be60: OAuth2 providers with `storeTokens` keep each linked account's access and refresh tokens, encrypted with `secretKey`. `getAccessToken(recordId, provider)` in the SDK, `GET /collections/{collection}/records/{id}/linked-accounts/{provider}/token`, or `nextbase.getAccessToken(collection, id, provider)` in server code answers a token, refreshed first when it expires within a minute, or with `refresh` unless it was refreshed in the last 10 seconds. Concurrent requests refresh it once, and no database connection is held while the provider answers. Refresh failures are logged without the provider's response, a rotated refresh token is kept even when the rest of the response is refused, and tokens sealed with a removed key, or kept by a provider whose `storeTokens` was turned off, are deleted. Only the account itself or a superuser gets it, never an impersonation session. Sign-ins and links take `scopes` to ask for more of the provider's API, and the stored scopes follow what was granted.
- Updated dependencies [1f741f6]
- Updated dependencies [bfebd87]
- Updated dependencies [2d6d573]
- Updated dependencies [1f741f6]
- Updated dependencies [a26be60]
- Updated dependencies [a26be60]
- Updated dependencies [a26be60]
  - @nextbasejs/client@0.2.0

## 0.1.10

### Patch Changes

- 92aea2b: Superusers can impersonate a record of an auth collection with `POST /collections/{collection}/impersonate/{id}`, or `nb.collection("users").impersonate(id)` in the SDK, which returns a new client signed in as the record and leaves the superuser's own auth store alone. The session lasts 60 to 3600 seconds, an hour by default, skips the collection's `authRule`, is never extended, and ends when its superuser is deleted or changes their password. With `cookie: true`, which needs the superuser on a cookie session, the browser's cookie session becomes the record's, and signing out restores the superuser's, answering 200 with their record so the SDK's store holds it again. An impersonation session cannot change the password, email, phone, verification or identity fields of any account, use the email, password reset or phone flows, link or unlink an OAuth2 provider, be refreshed, revoke other sessions or impersonate, and its file tokens act as it and stop working when it ends. It shows in the record's sessions with `impersonatedBy`, which `GET /session`, hooks and rules (`@request.impersonatedBy`) see too. Each impersonation is logged with `data.type` `impersonate`, whatever `minLevel` is, and request log entries name the superuser in `impersonatedBy`. `nb.withAuthStore(store)` returns a client of the same server with another auth store.
- 73ff796: NextBase rate limits HTTP requests, on by default: sign-ins, sign-ups, refreshes and email and phone flows 2 every 3 seconds, record creates 20 every 5 seconds, batches 3 a second, and every other route 300 every 10 seconds. Signed-in callers are counted per account, guests per IP from `clientIp` (IPv6 by its /56); guests whose IP is unknown are not limited, with one warning per instance, and requests with an invalid token count as a guest's. Each write of a batch counts as if sent on its own, and a batch with any write over its limit is refused whole. Creates in auth collections count as sign-ups, unless a rule limits creates in that collection. Counts are fixed windows kept in an unlogged table, `nextbase._rate_limits`, one upsert per request before any transaction, so limits hold across instances and parallel requests cannot all pass; a count over its limit is not rewritten, and each instance answers further refusals in its window from memory. A refused request gets a 429 with `Retry-After`, `RateLimit-Policy` and `RateLimit` headers, and is logged at warn; a refused OAuth2 sign-in start redirects back with `error=too_many_requests` instead. The new `rateLimits` option replaces the rules, each a label (`users:auth`, `*:create`, `POST /batch`, `/path` or `/prefix/`, but no path below one collection), an optional audience, `max` and `window`, sets `excludedIps` (IPs or CIDR ranges), or turns limits off with `false`. Superusers, `nextbase.client()` requests, health checks and the admin page are never limited. The limit on failed sign-ins per account still applies.
- 0c15929: Clients can subscribe to records as they are created, updated and deleted. List the collections in the new `realtime` option of `new NextBase()`, or pass `true`, then call `collection(name).subscribe("*" or an id, callback, { filter, expand, fields, onReset, onError })` in the client. Each subscriber gets only the records its list or view rule and filter allow, shaped as a list request would return them, once and in commit order; writes that roll back send nothing. Events are logged in the write's transaction and take their position in the log as it commits. All subscriptions of a client share one streamed request that resumes after the last event it received, ends on its own before Vercel's limit (`streamSeconds`, 240 by default), and starts over when the session changes; `onReset` is called once a subscription is live and whenever events may have been missed. Event ids are signed for the caller, so they cannot be used to replay events under someone else's session or after the signed-in record changed. Each instance reads new events once for all its streams and serves at most 1000 of them. Behind a transaction pooler, set `realtime.listenUrl` to a direct connection string.
- 1425a28: NextBase keeps a log of HTTP requests and background failures in the database, for 7 days by default. Each request gets one entry with its method, URL (with `token`, `code` and `state` redacted), status, time taken, the caller's collection, user agent, referer and, when it failed, the error, its field errors and, for unexpected errors, the stack. Bodies, cookies, the Authorization header and Postgres error details are never recorded. After hooks, file deletes, emails, texts, realtime cleanup and unexpected OAuth2 sign-in errors are logged at error too, and an OAuth2 sign-in that fails and redirects back is logged at warn with its error code. Entries are written in the background, a burst at a time with one insert at a time per instance, and never fail a request; `nextbase.flush()` writes those still waiting, for use before ending a pool or exiting. Superusers read them through `GET /logs`, `GET /logs/{id}` and `GET /logs/stats` with filters over `level`, `message` and `data.*`, or `nb.logs` in the client, and clear them with `DELETE /logs`. The new `logs` option sets `maxDays`, `minLevel`, `authId` and `ip`, or turns logs off with `false`. The new `clientIp` option says where the client's IP comes from: Vercel's headers on Vercel by default, a header your proxy sets with `trustedHops`, or a function. The OAuth2 callback answers 404 for a provider that is not set up, instead of failing with a 500.
- 320fe04: File fields take `thumbs`, up to 20 thumbnail sizes such as `300x200` (crop from the centre), `300x200t` and `300x200b` (from the top or bottom), `300x200f` (fit inside), `0x200` and `300x0` (one side), with sides up to 2500; `100x100` is always allowed. `GET /files/...?thumb=300x200`, or `nb.files.getUrl(record, name, { thumb })`, serves a JPEG, PNG, GIF or WebP image in that size, made with sharp on the first request, once per instance at a time, and stored beside the file under `thumbs_<name>/`, with the same access checks, cache headers and bucket redirects as the file. Thumbnails keep the image's format, are never enlarged, follow its EXIF orientation, leave out its metadata, and show the first frame of an animated GIF. Sizes are canonical: no leading zeros, and `t`, `b` or `f` only when neither side is 0. Other sizes, other types of file, files over 50 MB, images that cannot be read, have more than 50 megapixels, a side over 16384 or an aspect ratio over 50:1, requests that would wait too long for a free slot, and servers without sharp get a 302 to the file's own URL without `thumb`, with `Cache-Control: no-store`. Images whose header shows they can never be thumbed get a `.failed` marker beside the file so no instance reads them again; a size whose resize fails is tried again after 5 minutes. Both are logged as warnings with `data.type` `thumbs`; other errors loading sharp than its absence are logged as errors. Thumbnails are deleted with their file, record or collection. sharp is an optional peer dependency of `@nextbasejs/core`: install it to make thumbnails.
- Updated dependencies [92aea2b]
- Updated dependencies [0c15929]
- Updated dependencies [1425a28]
- Updated dependencies [320fe04]
  - @nextbasejs/client@0.1.10

## 0.1.9

### Patch Changes

- 0d7963b: Accounts can no longer be taken over in advance through OAuth2. A provider that did not verify the email it shares creates no account, a record whose email is not verified cannot link a provider, both failing with `email_not_verified`, and confirming a password reset or an email verification for an email that was not verified before unlinks the providers linked to the record. A password reset or email change link works once even when several requests use it at the same time. A forged token with claims that cannot be stored is refused as an invalid link instead of failing with a 500, for emailed links and file tokens alike. Signing in with a very long identity fails with the usual 400 and is counted against the limit, instead of failing with a 500.
- defa6f0: Auth requests that overlap no longer save an older state over a newer one: of sign-ins and sign-outs, the one started last wins, and `getSession()` and `refreshSession()` leave the auth store alone if it changed while they were in flight, so a late answer no longer signs a user back in or mixes one account's token with another's record. Deleting a record signs out only if it is still the signed-in one. Direct uploads to the bucket stop when the request's `signal` aborts, and fail with a `ClientError`. `ClientError` has `isTimeout` for a signal that timed out, and `isAbort` is now true for any other abort reason, also when aborted while the response body arrived. Sign-up, sign-in and refresh apply `expand` and `fields` to the returned record, under the same rules as record routes.
- 446744b: Queries with several statements return the last statement's rows and count instead of nothing, and a query with a missing parameter is logged like any other failure. A nested transaction whose callback caught a failed statement is rolled back to its savepoint and rejects with `TxAbortedError`, leaving the outer transaction usable. `isIn()` and `notIn()` accept a sub-query, `ARRAY [[1]]` is no longer read as a column name, and `not()` of a condition that matches every row now matches none instead of every row.
- d409d18: Record hooks: the new `hooks` option of `new NextBase()` runs your code when records are created, updated or deleted, by collection or for every collection. Before hooks can change or refuse a write before it is checked, on hooks write other records in the write's transaction through `e.nextbase`, and after hooks run in the background once it is committed. They run for every write, including NextBase's own, such as an OAuth2 sign-up, and cascading deletes. `new NextBase<Collections>()`, with the types from `nextbase typegen`, types the hooks and every client it makes, `serverClient()` included. `ApiError` is now exported, for hooks to refuse a write with.
- 047675a: Strings with an unpaired UTF-16 surrogate, in any field, inside JSON or in a collection's schema, are a validation error instead of a 500 or a value silently stored with U+FFFD in its place. A `number+` or `number-` modifier that overflows to infinity is a validation error instead of a value served as null. Date fields compare their `min` and `max` by time, so years past 9999 or before 1 AD no longer pass or fail the wrong way. A cascading delete no longer fails because a record it also deletes requires one of the others, whatever the cycles or the order of the fields. Changing the password of an account with no email no longer sends an email to an empty address.
- c40ca39: Rules check `@request.auth.<field>` when they are saved: a name no auth collection has is an error instead of an empty value, so renaming or deleting an auth field a rule reads is refused like other changes that break a rule. Hidden fields of the signed-in record can be read, and a field with several values compares like one of the record's own, so `@request.auth.roles ?= "admin"` works instead of failing every signed-in request. A modifier a `@request` value does not support, such as `@request.query.q:lower`, is an error instead of being ignored. Deleting a collection that another rule reads with `@collection` is refused instead of blocking every later schema change. A `~` pattern ending in a lone backslash and an index over values too large to index are 400 errors instead of 500s. A collection cannot be named another collection's id, or take another's name as its id, and `true`, `false` and `null` are reserved field names. Upgrading a database whose auth collections have their own `phone`, `phoneVerified` or `emailVerified` field renames that field to `user_<name>`, with the rules that use it, instead of failing at every startup.
- 5bc733f: A response that sets a cookie, such as a public file sent while renewing a session, is now `private, no-store`, so a CDN cannot store it and hand one user's session to others. Server actions and route handlers using the server-side client now renew the session cookie, so users of apps without browser API calls are no longer signed out after 7 days; server components, which cannot set cookies, never extend a session. Form data requests are limited to 1000 parts, counted before parsing, and repeated keys no longer take quadratic time. `nextbase superuser` reads both password lines from piped input instead of hanging. A `basePath` that is not an absolute URL path, such as `api/nextbase`, throws a TypeError instead of answering 404 to every request. The server-side client honours `signal`: an aborted request rejects as with `fetch`.
- e55d79b: Sign-in identities, emails for the email flows and superusers, redirect paths, upload file names and filter values refuse lone UTF-16 surrogates as they refuse NUL characters, instead of Postgres quietly storing or matching them as U+FFFD.
- Updated dependencies [defa6f0]
  - @nextbasejs/client@0.1.9

## 0.1.8

### Patch Changes

- c10f01f: Batches of creates whose rows set different fields no longer fail with a 500. A batch now reports the first failing write in order even when an earlier create duplicates a unique value, and a write that follows earlier writes of the batch is checked against them, so a record can have its password changed twice in one batch. A manager who sends an old password no longer counts a failed attempt against the account. The setup command in the server log takes its URL from `appUrl`, never from the request's Host header.
- b7abc9b: Deleting a record on a cycle of cascading relations, such as records that point at each other, no longer fails with a 500. Next.js builds no longer trace the whole project into the server bundle because of where local file storage lives. Core depends on a compatible range of `@nextbasejs/client` instead of one exact version, so apps install one copy. A failed file claim says "Failed to create the record." or "Failed to update the record." like other write errors.
- 4490925: `NextBaseProvider` follows a new `session` from the server, so signing in or out in a server action shows without a reload, and `useSession` subscribes once instead of on every render. A session signed in to another collection than a request needs now gets a 403 instead of a 401, so the client no longer signs it out. Responses to requests with no session carry `NextBase-Session: none`, and the client signs out a cookie session that ended. In-process clients use the cookie of the page's scheme, so server components see the session under `next dev --experimental-https`. An update with `fields` keeps the signed-in record current, a batch uploads its files to the bucket instead of sending them as `{}`, the SDK decides on direct uploads by a write's total size, and auth stores no longer leak a storage listener.
- c10f01f: Transactions report an error when Postgres rolls back a commit because a statement in them failed, instead of reporting success. Multi-row inserts accept rows that set different columns.
- 42312bf: `:lower` works on fields with several values, lowering each value, where it failed or never matched. A value too long for its field's index is a 400, not a 500. Dates must be ISO 8601: other forms, such as `1/2/2024`, were read in the server's local time. `~` can compare two values, such as `@request.auth.name ~ "a"`, and `ARRAY[[1]]` in raw SQL is no longer read as a column name.
- 51d669a: A create or update the rules refuse no longer stores its files, hashes its password or asks the breached-password service first, including updates whose rule reads `@request.body`. A create the rule refuses no longer reports whether its related records exist. Signed-out callers can start direct uploads only where the create or update rule is `""`, and each account can start 100 an hour.
- Updated dependencies [4490925]
  - @nextbasejs/client@0.1.8

## 0.1.7

### Patch Changes

- 4a78537: Batch creates whose rules read other collections, such as a membership check with `@collection`, now run together too. Only creates whose create or view rule reads the collection being created run one at a time, since only those rules could see records created earlier in the same batch.
- @nextbasejs/client@0.1.7

## 0.1.6

### Patch Changes

- fa6d1b0: A batch does consecutive creates in one collection together, with a few queries for all of them instead of a few per record. A batch of 50 creates with two relation fields went from 253 queries to 10. Errors are reported as before: the first failing create, with the same message and details.
- a57e76d: Faster queries and expands:
  
  - Expanding back-relations and multi-value relations matches records to their parents in one pass. Before, it went through every related record once per parent, which took seconds on large pages.
  - Signing in or resetting a password by email, or finding an account by phone, uses the unique index instead of reading the whole table.
  - `?=` on multi-value fields, such as `tags ?= "news"`, uses the field's GIN index instead of reading the whole table.
  - New indexes on the expiry columns of sign-in attempts, OAuth2 states and texted codes, so removing expired rows no longer reads the whole table.
  
  Fixed: a date and time with no zone, such as `2026-01-02 10:00:00`, is now read as UTC everywhere: in filters, record values and date field bounds. Before, it was read in the server's local time zone.
- 00f0d7c: Requests take fewer database round trips:
  
  - Reading a list or a record takes three: one starts the transaction, sets the statement timeout and checks the schema version, one reads the page together with its total, and one commits. A signed-in request adds one to check the session.
  - Creating or updating a record takes two fewer, and so does deleting one. Writes no longer make a savepoint inside the request's transaction, and they send the timeout with `BEGIN`.
  - Signing in with a password takes six instead of nine. Counting attempts and removing expired ones is one statement, and so is removing expired sessions and creating the new one.
  
  Timeouts, transactions, rate limits and schema freshness work as before.
- bf0a40e: Writes with files read and store them before the write's transaction starts, so a slow upload to storage no longer holds the record locked and a database connection busy. Inside the transaction, each direct upload is claimed, so one upload makes one file even when two writes use it at once. A caller the update rule refuses stores no files, unless the rule reads `@request.body`; then its files are deleted again when the write is refused.
- ae563cb: Password changes no longer hash the new password or check the old one while the record is locked. Both now happen before the write's transaction starts. Under load, concurrent password changes could stall until the connection timeout, each holding one database connection while waiting for another; they no longer do. A caller the update rule refuses is still turned away before any password is checked or attempt counted.
- fef7c81: - Deleting a record with cascades takes a few queries per level of related records, however many records there are. Deleting a thread with 30 replies and 60 likes went from 158 queries to 11.
  - Updating a record no longer blocks requests that create or change records referencing it, such as adding a comment to a post being edited.
- 94af258: Filters and rules through single relations, such as `author.name = "Ann"` or `post.status = "public"`, are a plain lookup that Postgres can serve with indexes. Before, they checked every row of the collection. Results are the same.
- 0a871fb: Records writes are checked before their transaction starts, and only the rest runs in it. The breached-password check, an HTTP call, no longer holds a database connection and a transaction open while it waits.
- @nextbasejs/client@0.1.6

## 0.1.5

### Patch Changes

- 7476f6f: Session checks take one query instead of three: the schema version, the session and its user's record are read together, so a signed-in page waits for one database round trip. Renewing a session still takes a second query, at most once a day. Revocations, password changes and schema changes still apply on the next request.
- @nextbasejs/client@0.1.5

## 0.1.4

### Patch Changes

- 3df2d46: File uploads for `file` fields: send files with a record as form data, or, with storage in an S3-compatible bucket (the new `storage.s3` option), straight to the bucket for large files, which the SDK does automatically above 4 MB. Types are checked from the file's bytes, names are generated, and files are deleted with their record, field or collection. Download with `nb.files.getUrl()`; protected fields follow the view rule, with `nb.files.getToken()` for links.
  
  **Breaking:** NextBase now needs Node.js 22 or later, as Node.js 20 reached end of life.
- Updated dependencies [3df2d46]
  - @nextbasejs/client@0.1.4

## 0.1.3

### Patch Changes

- 419e109: OAuth2 providers now call back to `{basePath}/callback/{provider}`, and a sign-in must return from the provider it started with. Changing a password while signed in, and unlinking a provider, email the owner, once the change is saved. `revokeOtherSessions()` signs out every other device. Deleting an account or collection deletes its sessions.
- 127629b: **Breaking:** auth names are clearer now that records have both an email and a phone.
  
  - The auth record field `verified` is now `emailVerified`. A migration renames the column and rewrites rules that use it, such as `authRule: "verified = true"` or `@request.auth.verified`. Update your own code that reads or writes `verified`, and the SQL of any view collection that selects it.
  - `requestVerification()` and `confirmVerification()` are now `requestEmailVerification()` and `confirmEmailVerification()`, at `/request-email-verification` and `/confirm-email-verification`.
  
  Unreleased features were also renamed before their first release: `phoneSignIn` (collection option), `rejectBreachedPasswords` (option), `listLinkedAccounts()`, `unlinkAccount()` and `/linked-accounts`, and new `linkOAuth2()` and `requestPasswordResetByPhone()` methods.
- 7b4662e: The `rejectBreachedPasswords` option refuses passwords found in known data breaches, checked with the Have I Been Pwned password service, which only receives the first 5 characters of the password's hash, on sign-up, password changes and resets. Off by default.
- 5e05113: Point the documentation links to nextbase.goomzo.com.
- b8180be: Sign in with OAuth2: Google, GitHub and any OpenID Connect provider, through the new `appUrl` and `oauth2` options. Sign-in failures can return to their own `errorRedirect` page. Users can link and unlink providers, and `listAuthMethods()` lists the providers. `mail.appUrl` now defaults to `appUrl`.
- ccb21ce: Phone sign-in: a `phone` field type and `phone`/`phoneVerified` system fields on auth collections, and, for collections with `phoneSignIn`, sign-in and sign-up with codes texted through the new `sms` option, phone and password sign-in, password reset by SMS, and phone verification and change. Codes are six digits, expire after 10 minutes and work once; texts are limited per phone and optionally to a list of countries.
- a10ffcf: Build the server for Node and add the "use client" directive to the React package as a banner, so the builds run without warnings.
- Updated dependencies [419e109]
- Updated dependencies [127629b]
- Updated dependencies [5e05113]
- Updated dependencies [b8180be]
- Updated dependencies [ccb21ce]
  - @nextbasejs/client@0.1.3

## 0.1.2

### Patch Changes

- c654eaf: Publish from GitHub Actions with npm trusted publishing, so each release carries provenance.
- Updated dependencies [c654eaf]
  - @nextbasejs/client@0.1.2

## 0.1.1

### Patch Changes

- ccbf0ea: The server package is now `@nextbasejs/core`, replacing `nextbasejs`, so every package lives under the `@nextbasejs` scope. Install `@nextbasejs/core` and import `NextBase` from it; `@nextbasejs/next` now takes it as its peer dependency.
- Updated dependencies [ccbf0ea]
  - @nextbasejs/client@0.1.1

## 0.1.0

### Minor Changes

- First release: a backend for your app on Postgres, with collections, access rules, auth and sessions, served from any framework that speaks web-standard Request and Response, plus the SDK, Next.js route handlers and React hooks.

### Patch Changes

- Updated dependencies
  - @nextbasejs/client@0.1.0
