---
"@nextbasejs/core": patch
"@nextbasejs/client": patch
---

`GET /migrations` lists the app's migrations for superusers, newest first: when each ran on this database, or `null` while pending, whether its file is still there, and whether it can be reverted, along with the migrations folder and whether automigrate and API collection changes are on. The client reads it with `nb.migrations.getStatus()`, and the admin shows it under Settings, Migrations.
