---
"@nextbasejs/core": patch
---

Batches of creates whose rows set different fields no longer fail with a 500. A batch now reports the first failing write in order even when an earlier create duplicates a unique value, and a write that follows earlier writes of the batch is checked against them, so a record can have its password changed twice in one batch. A manager who sends an old password no longer counts a failed attempt against the account. The setup command in the server log takes its URL from `appUrl`, never from the request's Host header.
