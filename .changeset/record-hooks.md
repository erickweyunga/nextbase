---
"@nextbasejs/core": patch
"@nextbasejs/next": patch
---

Record hooks: the new `hooks` option of `new NextBase()` runs your code when records are created, updated or deleted, by collection or for every collection. Before hooks can change or refuse a write before it is checked, on hooks write other records in the write's transaction through `e.nextbase`, and after hooks run in the background once it is committed. They run for every write, including NextBase's own, such as an OAuth2 sign-up, and cascading deletes. `new NextBase<Collections>()`, with the types from `nextbase typegen`, types the hooks and every client it makes, `serverClient()` included. `ApiError` is now exported, for hooks to refuse a write with.
