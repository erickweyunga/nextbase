---
"@nextbasejs/core": patch
---

Deleting a record on a cycle of cascading relations, such as records that point at each other, no longer fails with a 500. Next.js builds no longer trace the whole project into the server bundle because of where local file storage lives. Core depends on a compatible range of `@nextbasejs/client` instead of one exact version, so apps install one copy. A failed file claim says "Failed to create the record." or "Failed to update the record." like other write errors.
