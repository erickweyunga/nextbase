# @nextbasejs/next

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
