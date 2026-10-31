---
"@nextbasejs/core": patch
"@nextbasejs/client": patch
---

Sign-in by a code emailed to the account, with no password. Turn it on with the auth collection option `otp: { enabled: true, duration }` (codes work 180 seconds by default). `requestOtp(email)` answers an id whether or not the account exists, and `signInWithOtp(otpId, code)` signs in, counting the email verified. A code works once, five wrong ones end its id, wrong ones count against the account, and a code sent before the email changed signs in nothing. It is the `emailCode` method for multi-factor sign-in, and `auth-methods` lists it as `otp`.
