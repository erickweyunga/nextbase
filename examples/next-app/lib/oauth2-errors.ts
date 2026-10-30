/** What each `?error=` from an OAuth2 sign-in means, for the user. */
export const OAUTH2_ERRORS: Record<string, string> = {
  oauth2_denied: 'The sign-in was cancelled.',
  oauth2_failed: 'The sign-in did not complete. Please try again.',
  account_exists:
    'An account with this email already exists. Sign in to it, then link this provider from your dashboard.',
  email_required: 'The provider did not share an email address.',
  sign_up_disabled: 'New accounts cannot be created right now.',
  sign_up_failed: 'Your account could not be created.',
  sign_in_forbidden: 'This account cannot sign in yet.',
  already_linked:
    'That provider account is linked to another user, or you already linked one from this provider.',
};
