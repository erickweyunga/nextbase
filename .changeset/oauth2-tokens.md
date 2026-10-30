---
"@nextbasejs/core": patch
"@nextbasejs/client": patch
---

OAuth2 providers with `storeTokens` keep each linked account's access and refresh tokens, encrypted with `secretKey`. `getAccessToken(recordId, provider)` in the SDK, `GET /collections/{collection}/records/{id}/linked-accounts/{provider}/token`, or `nextbase.getAccessToken(collection, id, provider)` in server code answers a token, refreshed first when it expires within a minute or with `refresh`; concurrent requests refresh it once. Only the account itself or a superuser gets it, never an impersonation session. Sign-ins and links take `scopes` to ask for more of the provider's API, and the stored scopes follow what was granted.
