---
"@nextbasejs/core": patch
"@nextbasejs/client": patch
"@nextbasejs/next": patch
"@nextbasejs/react": patch
---

File uploads for `file` fields: send files with a record as form data, or, with storage in an S3-compatible bucket (the new `storage.s3` option), straight to the bucket for large files, which the SDK does automatically above 4 MB. Types are checked from the file's bytes, names are generated, and files are deleted with their record, field or collection. Download with `nb.files.getUrl()`; protected fields follow the view rule, with `nb.files.getToken()` for links.

**Breaking:** NextBase now needs Node.js 22 or later, as Node.js 20 reached end of life.
