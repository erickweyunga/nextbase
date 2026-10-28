---
"@nextbasejs/core": patch
---

Faster queries and expands:

- Expanding back-relations and multi-value relations matches records to their parents in one pass. Before, it went through every related record once per parent, which took seconds on large pages.
- Signing in or resetting a password by email, or finding an account by phone, uses the unique index instead of reading the whole table.
- `?=` on multi-value fields, such as `tags ?= "news"`, uses the field's GIN index instead of reading the whole table.
- New indexes on the expiry columns of sign-in attempts, OAuth2 states and texted codes, so removing expired rows no longer reads the whole table.

Fixed: a date and time with no zone, such as `2026-01-02 10:00:00`, is now read as UTC everywhere: in filters, record values and date field bounds. Before, it was read in the server's local time zone.
