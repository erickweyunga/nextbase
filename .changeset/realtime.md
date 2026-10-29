---
"@nextbasejs/core": patch
"@nextbasejs/client": patch
---

Clients can subscribe to records as they are created, updated and deleted. List the collections in the new `realtime` option of `new NextBase()`, or pass `true`, then call `collection(name).subscribe("*" or an id, callback, { filter, expand, fields })` in the client. Each subscriber gets only the records its list or view rule and filter allow, shaped as a list request would return them, once and in commit order; writes that roll back send nothing. Events are logged in the write's transaction and read only once every earlier transaction has finished, so none is lost or skipped. All subscriptions of a client share one streamed request that resumes after the last event it received, ends on its own before Vercel's limit (`streamSeconds`, 240 by default), and starts over when the session changes. Behind a transaction pooler, set `realtime.listenUrl` to a direct connection string.
