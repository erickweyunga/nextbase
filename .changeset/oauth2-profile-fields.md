---
"@nextbasejs/core": patch
---

Richer OAuth2 sign-ups. A refused sign-up is logged as a warning with its reason, and returns `&field=` with `?error=sign_up_failed`, naming the field it lacked. The new `profileFields` provider option fills a new account's `name`, `givenName`, `familyName` and `avatar` from the standard profile, or fields you name by claim, and asks for the `profile` scope itself. A file field can take the profile photo, from `profileFields` or `remoteFile(url)` in `mapProfile`: it is downloaded once, over https from the provider's `photoHosts` only, up to 5 MB within 5 seconds and within the field's own limits, and a photo that fails is skipped, never failing the sign-up. `refreshProfile` lists fields to update from the provider on every sign-in.
