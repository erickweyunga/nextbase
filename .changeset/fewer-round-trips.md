---
"@nextbasejs/core": patch
---

Requests take fewer database round trips:

- Reading a list or a record takes three: one starts the transaction, sets the statement timeout and checks the schema version, one reads the page together with its total, and one commits. A signed-in request adds one to check the session.
- Creating or updating a record takes two fewer, and so does deleting one. Writes no longer make a savepoint inside the request's transaction, and they send the timeout with `BEGIN`.
- Signing in with a password takes six instead of nine. Counting attempts and removing expired ones is one statement, and so is removing expired sessions and creating the new one.

Timeouts, transactions, rate limits and schema freshness work as before.
