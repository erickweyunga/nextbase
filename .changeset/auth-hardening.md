---
"@nextbasejs/core": patch
---

Accounts can no longer be taken over in advance through OAuth2. A provider that did not verify the email it shares creates no account, a record whose email is not verified cannot link a provider, both failing with `email_not_verified`, and confirming a password reset or an email verification for an email that was not verified before unlinks the providers linked to the record. A password reset or email change link works once even when several requests use it at the same time. A forged token with claims that cannot be stored is refused as an invalid link instead of failing with a 500, for emailed links and file tokens alike. Signing in with a very long identity fails with the usual 400 and is counted against the limit, instead of failing with a 500.
