---
"@nextbasejs/core": patch
---

`:lower` works on fields with several values, lowering each value, where it failed or never matched. A value too long for its field's index is a 400, not a 500. Dates must be ISO 8601: other forms, such as `1/2/2024`, were read in the server's local time. `~` can compare two values, such as `@request.auth.name ~ "a"`, and `ARRAY[[1]]` in raw SQL is no longer read as a column name.
