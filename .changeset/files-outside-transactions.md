---
"@nextbasejs/core": patch
---

Writes with files read and store them before the write's transaction starts, so a slow upload to storage no longer holds the record locked and a database connection busy. Inside the transaction, each direct upload is claimed, so one upload makes one file even when two writes use it at once. A caller the update rule refuses stores no files, unless the rule reads `@request.body`; then its files are deleted again when the write is refused.
