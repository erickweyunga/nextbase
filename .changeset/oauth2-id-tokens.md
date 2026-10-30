---
"@nextbasejs/core": patch
"@nextbasejs/client": patch
---

Native apps sign in with an ID token from a provider's own SDK, such as Google Sign-In or Sign in with Apple: `signInWithIdToken(provider, token, { nonce })`, or `POST /collections/{collection}/auth-with-id-token/{provider}`. The token must be signed by the provider's OpenID Connect keys, issued to one of its client ids, unexpired, carry the nonce (as is or hashed) when one is given, and is accepted once. A provider's `clientId` can be a list, such as the web, iOS and Android apps' ids; the browser sign-in uses the first.
