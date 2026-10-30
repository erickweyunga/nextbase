---
"@nextbasejs/core": patch
"@nextbasejs/client": patch
---

Auth collections have an `emailVerification` option, `{ required, sendOnSignUp, sendOnSignIn }`, each off by default. `required` refuses sign-ins and refreshes of accounts with an unverified email (403, "Verify your email to sign in."; accounts without an email are not affected), ends their sessions from before (not a superuser's impersonation), and answers a sign-up with an already registered email with the same 202 as a new one, and the same errors for its other fields, while emailing the owner (`signUpAttempt`). `_superusers` keeps every option off. `sendOnSignUp` sends the verification link when an account signs up, and `sendOnSignIn` sends it again when an unverified account signs in with the right password. A link that cannot be sent never fails the request.
