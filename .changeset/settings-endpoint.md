---
"@nextbasejs/core": patch
"@nextbasejs/client": patch
---

`GET /settings` answers superusers the settings the server runs with: the app's URL, base path, trusted origins, proxy and client IP, statement timeout, rate limits and realtime, how many secret keys there are and where they come from (never the keys), whether breached passwords are refused and `validateSignIn` is set, each OAuth2 provider with its callback URL but never its client secret, the `logs` option in effect (`null` when logs are off), where files are kept, local folder or bucket, without its credentials, and how email goes out, from whom, and which emails use a custom template. The client reads it with `nb.settings.get()`, and the admin shows them under Settings, Application, Mail, File storage, Logs, OAuth2 providers and Security.
