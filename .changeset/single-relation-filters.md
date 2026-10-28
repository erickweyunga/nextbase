---
"@nextbasejs/core": patch
---

Filters and rules through single relations, such as `author.name = "Ann"` or `post.status = "public"`, are a plain lookup that Postgres can serve with indexes. Before, they checked every row of the collection. Results are the same.
