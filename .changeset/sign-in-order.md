---
"@nextbasejs/core": patch
---

Sign-in by email code is off when the collection's `authRule` is `null`, and a code the `authRule` refuses no longer marks the email verified. A password sign-in that `validateSignIn` refuses answers the app's refusal even when the email is not verified, and sends no verification link.
