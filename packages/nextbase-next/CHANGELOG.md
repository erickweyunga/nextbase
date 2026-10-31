# @nextbasejs/next

## 0.2.3

### Patch Changes

- Updated dependencies [4f9f269]
- Updated dependencies [dd39247]
  - @nextbasejs/core@0.2.3
  - @nextbasejs/client@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies [0554207]
  - @nextbasejs/core@0.2.2
  - @nextbasejs/client@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [309705f]
- Updated dependencies [309705f]
- Updated dependencies [7b7db0a]
- Updated dependencies [7b7db0a]
- Updated dependencies [309705f]
  - @nextbasejs/core@0.2.1
  - @nextbasejs/client@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies [1f741f6]
- Updated dependencies [bfebd87]
- Updated dependencies [2d6d573]
- Updated dependencies [1f741f6]
- Updated dependencies [a26be60]
- Updated dependencies [a26be60]
- Updated dependencies [a26be60]
  - @nextbasejs/core@0.2.0
  - @nextbasejs/client@0.2.0

## 0.1.10

### Patch Changes

- Updated dependencies [92aea2b]
- Updated dependencies [73ff796]
- Updated dependencies [0c15929]
- Updated dependencies [1425a28]
- Updated dependencies [320fe04]
  - @nextbasejs/core@0.1.10
  - @nextbasejs/client@0.1.10

## 0.1.9

### Patch Changes

- d409d18: Record hooks: the new `hooks` option of `new NextBase()` runs your code when records are created, updated or deleted, by collection or for every collection. Before hooks can change or refuse a write before it is checked, on hooks write other records in the write's transaction through `e.nextbase`, and after hooks run in the background once it is committed. They run for every write, including NextBase's own, such as an OAuth2 sign-up, and cascading deletes. `new NextBase<Collections>()`, with the types from `nextbase typegen`, types the hooks and every client it makes, `serverClient()` included. `ApiError` is now exported, for hooks to refuse a write with.
- 5bc733f: A response that sets a cookie, such as a public file sent while renewing a session, is now `private, no-store`, so a CDN cannot store it and hand one user's session to others. Server actions and route handlers using the server-side client now renew the session cookie, so users of apps without browser API calls are no longer signed out after 7 days; server components, which cannot set cookies, never extend a session. Form data requests are limited to 1000 parts, counted before parsing, and repeated keys no longer take quadratic time. `nextbase superuser` reads both password lines from piped input instead of hanging. A `basePath` that is not an absolute URL path, such as `api/nextbase`, throws a TypeError instead of answering 404 to every request. The server-side client honours `signal`: an aborted request rejects as with `fetch`.
- Updated dependencies [0d7963b]
- Updated dependencies [defa6f0]
- Updated dependencies [446744b]
- Updated dependencies [d409d18]
- Updated dependencies [047675a]
- Updated dependencies [c40ca39]
- Updated dependencies [5bc733f]
- Updated dependencies [e55d79b]
  - @nextbasejs/core@0.1.9
  - @nextbasejs/client@0.1.9

## 0.1.8

### Patch Changes

- 4490925: `NextBaseProvider` follows a new `session` from the server, so signing in or out in a server action shows without a reload, and `useSession` subscribes once instead of on every render. A session signed in to another collection than a request needs now gets a 403 instead of a 401, so the client no longer signs it out. Responses to requests with no session carry `NextBase-Session: none`, and the client signs out a cookie session that ended. In-process clients use the cookie of the page's scheme, so server components see the session under `next dev --experimental-https`. An update with `fields` keeps the signed-in record current, a batch uploads its files to the bucket instead of sending them as `{}`, the SDK decides on direct uploads by a write's total size, and auth stores no longer leak a storage listener.
- Updated dependencies [c10f01f]
- Updated dependencies [b7abc9b]
- Updated dependencies [4490925]
- Updated dependencies [c10f01f]
- Updated dependencies [42312bf]
- Updated dependencies [51d669a]
  - @nextbasejs/core@0.1.8
  - @nextbasejs/client@0.1.8

## 0.1.7

### Patch Changes

- Updated dependencies [4a78537]
  - @nextbasejs/core@0.1.7
  - @nextbasejs/client@0.1.7

## 0.1.6

### Patch Changes

- Updated dependencies [fa6d1b0]
- Updated dependencies [a57e76d]
- Updated dependencies [00f0d7c]
- Updated dependencies [bf0a40e]
- Updated dependencies [ae563cb]
- Updated dependencies [fef7c81]
- Updated dependencies [94af258]
- Updated dependencies [0a871fb]
  - @nextbasejs/core@0.1.6
  - @nextbasejs/client@0.1.6

## 0.1.5

### Patch Changes

- Updated dependencies [7476f6f]
  - @nextbasejs/core@0.1.5
  - @nextbasejs/client@0.1.5

## 0.1.4

### Patch Changes

- 3df2d46: File uploads for `file` fields: send files with a record as form data, or, with storage in an S3-compatible bucket (the new `storage.s3` option), straight to the bucket for large files, which the SDK does automatically above 4 MB. Types are checked from the file's bytes, names are generated, and files are deleted with their record, field or collection. Download with `nb.files.getUrl()`; protected fields follow the view rule, with `nb.files.getToken()` for links.
  
  **Breaking:** NextBase now needs Node.js 22 or later, as Node.js 20 reached end of life.
- Updated dependencies [3df2d46]
  - @nextbasejs/core@0.1.4
  - @nextbasejs/client@0.1.4

## 0.1.3

### Patch Changes

- 5e05113: Point the documentation links to nextbase.goomzo.com.
- Updated dependencies [419e109]
- Updated dependencies [127629b]
- Updated dependencies [7b4662e]
- Updated dependencies [5e05113]
- Updated dependencies [b8180be]
- Updated dependencies [ccb21ce]
- Updated dependencies [a10ffcf]
  - @nextbasejs/core@0.1.3
  - @nextbasejs/client@0.1.3

## 0.1.2

### Patch Changes

- c654eaf: Publish from GitHub Actions with npm trusted publishing, so each release carries provenance.
- Updated dependencies [c654eaf]
  - @nextbasejs/core@0.1.2
  - @nextbasejs/client@0.1.2

## 0.1.1

### Patch Changes

- ccbf0ea: The server package is now `@nextbasejs/core`, replacing `nextbasejs`, so every package lives under the `@nextbasejs` scope. Install `@nextbasejs/core` and import `NextBase` from it; `@nextbasejs/next` now takes it as its peer dependency.
- Updated dependencies [ccbf0ea]
  - @nextbasejs/core@0.1.1
  - @nextbasejs/client@0.1.1

## 0.1.0

### Minor Changes

- First release: a backend for your app on Postgres, with collections, access rules, auth and sessions, served from any framework that speaks web-standard Request and Response, plus the SDK, Next.js route handlers and React hooks.

### Patch Changes

- Updated dependencies
  - nextbasejs@0.1.0
  - @nextbasejs/client@0.1.0
