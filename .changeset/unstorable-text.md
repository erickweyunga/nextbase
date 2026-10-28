---
"@nextbasejs/core": patch
---

Sign-in identities, emails for the email flows and superusers, redirect paths, upload file names and filter values refuse lone UTF-16 surrogates as they refuse NUL characters, instead of Postgres quietly storing or matching them as U+FFFD.
