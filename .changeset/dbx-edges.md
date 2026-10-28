---
"@nextbasejs/core": patch
---

Queries with several statements return the last statement's rows and count instead of nothing, and a query with a missing parameter is logged like any other failure. A nested transaction whose callback caught a failed statement is rolled back to its savepoint and rejects with `TxAbortedError`, leaving the outer transaction usable. `isIn()` and `notIn()` accept a sub-query, `ARRAY [[1]]` is no longer read as a column name, and `not()` of a condition that matches every row now matches none instead of every row.
