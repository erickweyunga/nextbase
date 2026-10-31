---
"@nextbasejs/core": patch
---

Migrations for the app's collections. Pass the generated index of `nextbase/migrations` as the new `migrations` option. In development, each collection create, update or delete writes a migration file and counts it as applied; updates are diffs, with fields matched by id. Token secrets never go into a file. `nextbase.migrate()` and the first request run the migrations a database has not run, each in its own transaction under the schema lock, and `nextbase.revertMigrations(count)` runs their `down`. A migration gets `app.collections` (`get`, `create`, `change`, `delete`, `import`), a superuser client in its transaction as `app.nextbase`, and the transaction as `app.db`. The CLI adds `migrate create NAME`, `migrate collections` (a snapshot, imported with `app.collections.import`) and `migrate history-sync`.
