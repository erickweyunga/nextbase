---
"@nextbasejs/core": patch
---

The `validateSignIn` option decides who may sign up, link an OAuth2 provider or sign in, at each one and by every method (password, OAuth2 in the browser or by ID token, phone code, email code). It sees the action, the method, the collection, the account (for a sign-up, its values; never the password), and for OAuth2 the provider's profile as it is at this sign-in, and refuses by answering `{ error, message }`: a 403 with the code in `data.account.code`, or `?error=` for an OAuth2 sign-in in the browser. A sign-up is refused before anything is written. Accounts callers create through the records API or a batch are checked as sign-ups too.
