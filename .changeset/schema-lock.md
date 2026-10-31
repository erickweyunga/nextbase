---
"@nextbasejs/core": patch
---

With the `migrations` option set, the API refuses to create, change or delete collections where automigrate is off, such as in production, with a 409 (`schema_managed_by_migrations`), so the schema cannot drift from the migrations. Migrations, reads and records are not affected; `schemaChanges: true` in the option allows API changes anyway.
