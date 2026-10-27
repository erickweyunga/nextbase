# nextbasejs

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
