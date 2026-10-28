---
"@nextbasejs/core": patch
---

Transactions report an error when Postgres rolls back a commit because a statement in them failed, instead of reporting success. Multi-row inserts accept rows that set different columns.
