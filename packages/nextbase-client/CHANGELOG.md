# @nextbasejs/client

## 0.2.2

### Patch Changes

- 0554207: Passkeys. With the collection's new `passkeySignIn` option and the `appUrl` option, `signInWithPasskey()` signs in with a passkey in the browser, with the dialog or, with `autofill: true`, the browser's autofill. `addPasskey`, `listPasskeys`, `renamePasskey` and `deletePasskey` manage the signed-in record's passkeys. Adding one needs a verified email or phone. Adding or removing one needs the password unless the session signed in within the last day, plus a code with an authenticator app, and emails an owner with an email (`passkeyAdded`, `passkeyRemoved`). A passkey the device unlocked, by fingerprint, face or PIN, signs in without a second step; one that did not is a first step, and a passkey can also be the second step. Verification uses SimpleWebAuthn; challenges are kept server-side, work once and expire after 5 minutes. `auth-methods` reports `passkey`, and `validateSignIn` sees the method `passkey`.

## 0.2.1

### Patch Changes

- 309705f: Sign-in by a code emailed to the account, with no password. Turn it on with the auth collection option `otp: { enabled: true, duration }` (codes work 180 seconds by default). `requestOtp(email)` answers an id whether or not the account exists, and `signInWithOtp(otpId, code)` signs in, counting the email verified. A code works once, five wrong ones end its id, wrong ones are capped per address the same whether or not an account has it, a code sent before the email changed signs in nothing, and proving the email drops providers linked before, as the verification link does. It is the `emailCode` method for multi-factor sign-in, and `auth-methods` lists it as `otp`.
- 7b7db0a: A realtime stream over 50 topics, or over the weight of 100, now refuses only the topics past the limit, so the client ends just those subscriptions and keeps the rest. The client shares one topic between identical subscriptions. `useRecords` reloads during a steady stream of changes instead of waiting for a pause, and no longer patches the wrong item when `fields` leaves out `id`.

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
