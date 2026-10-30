---
"@nextbasejs/core": patch
"@nextbasejs/client": patch
---

Deleting your own account needs more than a session: the current `password`, or a session signed in within the last day, plus `mfaCode` with an authenticator app. `delete(id, { password, mfaCode })` sends them in the body of `DELETE`, and rules never see them. Accounts that can do neither, such as ones that signed up through a provider, confirm by email: `requestAccountDeletion()` sends a link to `/delete-account`, and `confirmAccountDeletion(token)` deletes the account as its owner, so the delete rule still decides. Superusers and other deleters are unchanged, and an impersonation session cannot delete the account it acts as. The new `implicitLinking` collection option (default `true`) turns off linking a provider to an existing account by email; such a sign-in answers `account_exists`. An account that takes a second sign-in step is never linked by email, since whoever holds its inbox could otherwise add a provider as a second step. How each password was set is now recorded while MFA is off too, and `nextbase.verifyPassword(collection, id, password)` checks a password from server code.
