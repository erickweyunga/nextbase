# nextbasejs

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
