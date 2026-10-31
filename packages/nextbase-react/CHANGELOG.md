# @nextbasejs/react

## 0.2.0

### Patch Changes

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

- Updated dependencies [92aea2b]
- Updated dependencies [0c15929]
- Updated dependencies [1425a28]
- Updated dependencies [320fe04]
  - @nextbasejs/client@0.1.10

## 0.1.9

### Patch Changes

- Updated dependencies [defa6f0]
  - @nextbasejs/client@0.1.9

## 0.1.8

### Patch Changes

- 4490925: `NextBaseProvider` follows a new `session` from the server, so signing in or out in a server action shows without a reload, and `useSession` subscribes once instead of on every render. A session signed in to another collection than a request needs now gets a 403 instead of a 401, so the client no longer signs it out. Responses to requests with no session carry `NextBase-Session: none`, and the client signs out a cookie session that ended. In-process clients use the cookie of the page's scheme, so server components see the session under `next dev --experimental-https`. An update with `fields` keeps the signed-in record current, a batch uploads its files to the bucket instead of sending them as `{}`, the SDK decides on direct uploads by a write's total size, and auth stores no longer leak a storage listener.
- Updated dependencies [4490925]
  - @nextbasejs/client@0.1.8

## 0.1.7

### Patch Changes

- @nextbasejs/client@0.1.7

## 0.1.6

### Patch Changes

- @nextbasejs/client@0.1.6

## 0.1.5

### Patch Changes

- @nextbasejs/client@0.1.5

## 0.1.4

### Patch Changes

- 3df2d46: File uploads for `file` fields: send files with a record as form data, or, with storage in an S3-compatible bucket (the new `storage.s3` option), straight to the bucket for large files, which the SDK does automatically above 4 MB. Types are checked from the file's bytes, names are generated, and files are deleted with their record, field or collection. Download with `nb.files.getUrl()`; protected fields follow the view rule, with `nb.files.getToken()` for links.
  
  **Breaking:** NextBase now needs Node.js 22 or later, as Node.js 20 reached end of life.
- Updated dependencies [3df2d46]
  - @nextbasejs/client@0.1.4

## 0.1.3

### Patch Changes

- 5e05113: Point the documentation links to nextbase.goomzo.com.
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
