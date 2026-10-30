---
"@nextbasejs/core": patch
"@nextbasejs/client": patch
---

OAuth2 providers with `storeTokens` keep each linked account's access and refresh tokens, encrypted with `secretKey`. `getAccessToken(recordId, provider)` in the SDK, `GET /collections/{collection}/records/{id}/linked-accounts/{provider}/token`, or `nextbase.getAccessToken(collection, id, provider)` in server code answers a token, refreshed first when it expires within a minute, or with `refresh` unless it was refreshed in the last 10 seconds. Concurrent requests refresh it once, and no database connection is held while the provider answers. Refresh failures are logged without the provider's response, a rotated refresh token is kept even when the rest of the response is refused, and tokens sealed with a removed key, or kept by a provider whose `storeTokens` was turned off, are deleted. Only the account itself or a superuser gets it, never an impersonation session. Sign-ins and links take `scopes` to ask for more of the provider's API, and the stored scopes follow what was granted.
