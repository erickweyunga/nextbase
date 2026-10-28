---
"@nextbasejs/core": patch
---

A batch does consecutive creates in one collection together, with a few queries for all of them instead of a few per record. A batch of 50 creates with two relation fields went from 253 queries to 10. Errors are reported as before: the first failing create, with the same message and details.
