---
"@nextbasejs/core": patch
"@nextbasejs/client": patch
---

OAuth2 providers take `scopes` (asked for besides the ones NextBase needs), `prompt`, `params` for the provider's authorization page (NextBase's own parameters are refused), `disableSignUp` (existing accounts only; new ones fail with `sign_up_disabled`), and `mapProfile(profile, { data })`, which fills a new account's fields from the ID token's claims or GitHub's user. Sign-in fields are never taken from it, and the create rule and field checks still apply. A sign-in can pass its own `params` and untrusted `data` (a JSON object of at most 2 KB) for `mapProfile`: `signInWithOAuth2(provider, { params, data })`.
