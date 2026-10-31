---
"@nextbasejs/core": patch
"@nextbasejs/client": patch
---

Passkeys. With the collection's new `passkeySignIn` option and the `appUrl` option, `signInWithPasskey()` signs in with a passkey in the browser, with the dialog or, with `autofill: true`, the browser's autofill. `addPasskey`, `listPasskeys`, `renamePasskey` and `deletePasskey` manage the signed-in record's passkeys. Adding or removing one needs the password unless the session signed in within the last day, plus a code with an authenticator app, and emails the owner (`passkeyAdded`, `passkeyRemoved`). A passkey the device unlocked, by fingerprint, face or PIN, signs in without a second step; one that did not is a first step, and a passkey can also be the second step. Verification uses SimpleWebAuthn; challenges are kept server-side, work once and expire after 5 minutes. `auth-methods` reports `passkey`, and `validateSignIn` sees the method `passkey`.
