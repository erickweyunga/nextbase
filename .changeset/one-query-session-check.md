---
"@nextbasejs/core": patch
---

Session checks take one query instead of three: the schema version, the session and its user's record are read together, so a signed-in page waits for one database round trip. Renewing a session still takes a second query, at most once a day. Revocations, password changes and schema changes still apply on the next request.
