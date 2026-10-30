---
"@nextbasejs/core": minor
"@nextbasejs/client": minor
---

Breaking changes, so this is a minor version:

- `linkOAuth2` is async and needs `{ password }` (plus `mfaCode` with an authenticator app); linking starts with `POST /collections/{collection}/link-oauth2/{provider}`, and `?link=true` on `auth-with-oauth2` answers 400.
- Changing the phone and unlinking a provider need the current password, and an email change from a verified address must be approved from that inbox first (`approveEmailChange`).
- Deleting your own account needs the password once the session is older than a day (or `requestAccountDeletion`), plus `mfaCode` with an authenticator app.
- `signUp` can return `{ mfa: "verify" }`; sessions and auth responses carry `methods`.
- Rate limits are on by default (since 0.1.10).
