---
"@nextbasejs/core": patch
---

Records writes are checked before their transaction starts, and only the rest runs in it. The breached-password check, an HTTP call, no longer holds a database connection and a transaction open while it waits.
