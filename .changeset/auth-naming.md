---
"@nextbasejs/core": patch
"@nextbasejs/client": patch
---

**Breaking:** auth names are clearer now that records have both an email and a phone.

- The auth record field `verified` is now `emailVerified`. A migration renames the column and rewrites rules that use it, such as `authRule: "verified = true"` or `@request.auth.verified`. Update your own code that reads or writes `verified`, and the SQL of any view collection that selects it.
- `requestVerification()` and `confirmVerification()` are now `requestEmailVerification()` and `confirmEmailVerification()`, at `/request-email-verification` and `/confirm-email-verification`.

Unreleased features were also renamed before their first release: `phoneSignIn` (collection option), `rejectBreachedPasswords` (option), `listLinkedAccounts()`, `unlinkAccount()` and `/linked-accounts`, and new `linkOAuth2()` and `requestPasswordResetByPhone()` methods.
