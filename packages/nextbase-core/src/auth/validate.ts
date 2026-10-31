import type { SignInMethod } from '@nextbasejs/client';
import { ApiError } from '../errors.ts';

/** How the account signs in; each starts a session. */
export type SignInAction = 'sign-up' | 'link' | 'sign-in';

/** What the app's `validateSignIn` sees. */
export interface SignInCheck {
  action: SignInAction;
  /** How the account proved itself: `password`, `oauth2`, `phoneCode` or `emailCode`. */
  method: SignInMethod;
  collection: string;
  /**
   * The account signing in or linking, as stored; for a sign-up, the values
   * it is to be created with. Never the password or tokenKey.
   */
  record: Readonly<Record<string, unknown>>;
  /** For OAuth2: the provider and what it says about the account now. */
  oauth2?: {
    provider: string;
    profile: Readonly<Record<string, unknown>>;
  };
}

/** Refuses a sign-in: `error` is a code such as `email_not_allowed`. */
export interface SignInRefusal {
  error: string;
  /** Shown to the user; keep secrets out of it. */
  message?: string;
}

/** Answers nothing to allow, or a refusal. */
export type ValidateSignIn = (
  check: SignInCheck,
) => SignInRefusal | undefined | Promise<SignInRefusal | undefined>;

/** A refusal by the app's `validateSignIn`, answered as a 403. */
export class SignInRefused extends ApiError {
  readonly code: string;

  constructor({ error, message }: SignInRefusal) {
    const shown = message ?? 'This account cannot sign in.';
    super(403, shown, { account: { code: error, message: shown } });
    this.code = error;
  }
}

/** Never shown to the app's check. */
const SECRETS = new Set([
  'password',
  'passwordConfirm',
  'oldPassword',
  'tokenKey',
]);

/** Codes go into URLs and JSON as they are. */
const CODE = /^[a-z0-9_]{1,64}$/;

/**
 * Runs the app's check, if any; throws `SignInRefused` when it refuses. A
 * check that answers a malformed code throws a TypeError, as a bug.
 */
export async function checkSignIn(
  validate: ValidateSignIn | undefined,
  check: SignInCheck,
): Promise<void> {
  if (!validate) return;
  const record = Object.freeze(
    Object.fromEntries(
      Object.entries(check.record).filter(([key]) => !SECRETS.has(key)),
    ),
  );
  const refusal = await validate(
    Object.freeze({
      ...check,
      record,
      ...(check.oauth2 && {
        oauth2: Object.freeze({
          ...check.oauth2,
          profile: Object.freeze({ ...check.oauth2.profile }),
        }),
      }),
    }),
  );
  if (!refusal) return;
  if (typeof refusal.error !== 'string' || !CODE.test(refusal.error)) {
    throw new TypeError(
      'validateSignIn must answer an error code of lowercase letters, digits and "_".',
    );
  }
  throw new SignInRefused(refusal);
}
