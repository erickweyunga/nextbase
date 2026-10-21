---
"@nextbasejs/core": patch
---

The `rejectBreachedPasswords` option refuses passwords found in known data breaches, checked with the Have I Been Pwned password service, which only receives the first 5 characters of the password's hash, on sign-up, password changes and resets. Off by default.
