---
"@nextbasejs/client": patch
"@nextbasejs/core": patch
---

Auth requests that overlap no longer save an older state over a newer one: of sign-ins and sign-outs, the one started last wins, and `getSession()` and `refreshSession()` leave the auth store alone if it changed while they were in flight, so a late answer no longer signs a user back in or mixes one account's token with another's record. Deleting a record signs out only if it is still the signed-in one. Direct uploads to the bucket stop when the request's `signal` aborts, and fail with a `ClientError`. `ClientError` has `isTimeout` for a signal that timed out, and `isAbort` is now true for any other abort reason, also when aborted while the response body arrived. Sign-up, sign-in and refresh apply `expand` and `fields` to the returned record, under the same rules as record routes.
