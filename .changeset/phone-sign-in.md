---
"@nextbasejs/core": patch
"@nextbasejs/client": patch
---

Phone sign-in: a `phone` field type and `phone`/`phoneVerified` system fields on auth collections, and, for collections with `phoneAuth`, sign-in and sign-up with codes texted through the new `sms` option, phone and password sign-in, password reset by SMS, and phone verification and change. Codes follow NIST SP 800-63B; texts are limited per phone and optionally to a list of countries.
