import { waitUntil as vercelWaitUntil } from '@vercel/functions';
import { checkAppUrl } from '../app-url.ts';
import { ApiError } from '../errors.ts';
import type { Logger } from '../logs/logger.ts';

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export type MailKind =
  | 'verification'
  | 'passwordReset'
  | 'emailChange'
  | 'emailChangeApproval'
  | 'accountDeletion'
  | 'signUpAttempt'
  | 'passwordChanged'
  | 'emailChanged'
  | 'oauth2Linked'
  | 'oauth2Unlinked'
  | 'phoneChanged'
  | 'signInCode'
  | 'totpEnabled'
  | 'totpDisabled'
  | 'passkeyAdded'
  | 'passkeyRemoved'
  | 'recoveryCodeUsed'
  | 'mfaCleared'
  | 'mfaCodesPaused';

export interface MailContext {
  kind: MailKind;
  /** The auth collection name. */
  collection: string;
  to: string;
  /** Link with the token, for verification, reset, email change and deletion. */
  url?: string;
  token?: string;
  /** Set for `oauth2Linked` and `oauth2Unlinked`. */
  provider?: string;
  /** The code to enter, for `signInCode`. */
  code?: string;
  /** Recovery codes left, for `recoveryCodeUsed`. */
  remaining?: number;
  /** Where the password was reset, for `mfaCodesPaused`. */
  channel?: 'email' | 'phone';
}

export type MailTemplate = (context: MailContext) => {
  subject: string;
  text: string;
  html?: string;
};

export interface MailOptions {
  from: string;
  /** Sends one email through any provider (SMTP, Resend, SES, Postmark...). */
  send(message: MailMessage): Promise<void>;
  /**
   * Base URL of the `/verify-email`, `/reset-password` and other `?token=` pages.
   * Defaults to the `appUrl` option.
   */
  appUrl?: string;
  templates?: Partial<Record<MailKind, MailTemplate>>;
}

const PATHS: Partial<Record<MailKind, string>> = {
  verification: '/verify-email',
  passwordReset: '/reset-password',
  emailChange: '/confirm-email-change',
  emailChangeApproval: '/approve-email-change',
  accountDeletion: '/delete-account',
};

const DEFAULT_TEMPLATES: Record<MailKind, MailTemplate> = {
  verification: ({ url }) => ({
    subject: 'Verify your email',
    text: `Open this link to verify your email:\n\n${url}\n\nIf you did not ask for this, ignore this email.`,
  }),
  passwordReset: ({ url }) => ({
    subject: 'Reset your password',
    text: `Open this link to choose a new password:\n\n${url}\n\nIf you did not ask for this, ignore this email; your password stays as it is.`,
  }),
  emailChange: ({ url }) => ({
    subject: 'Confirm your new email',
    text: `Open this link to make this your account's email:\n\n${url}\n\nIf you did not ask for this, ignore this email.`,
  }),
  emailChangeApproval: ({ url }) => ({
    subject: 'Approve the change of your email',
    text: `Someone signed in to your account asked to move it to another email. Open this link to approve it, and the new address will get a link to confirm:\n\n${url}\n\nIf this was not you, do not open it, and change your password right away.`,
  }),
  accountDeletion: ({ url }) => ({
    subject: 'Confirm the deletion of your account',
    text: `Someone signed in to your account asked to delete it. Open this link and confirm there; the account and its data are then deleted for good:\n\n${url}\n\nIf this was not you, do not open it, and change your password right away.`,
  }),
  signUpAttempt: () => ({
    subject: 'Someone tried to sign up with your email',
    text: 'Someone just tried to create an account with this email, which already has one. If it was you, sign in, or reset your password if you forgot it. If not, you can ignore this email.',
  }),
  passwordChanged: () => ({
    subject: 'Your password was changed',
    text: 'Your password was just changed, and every device was signed out. If this was not you, reset your password right away.',
  }),
  emailChanged: ({ to }) => ({
    subject: 'Your email was changed',
    text: `Your account's email was just changed from ${to} to another address. If this was not you, contact support right away.`,
  }),
  oauth2Linked: ({ provider }) => ({
    subject: 'A new way to sign in was added',
    text: `Your account can now sign in with ${provider}. If this was not you, reset your password and contact support right away.`,
  }),
  phoneChanged: () => ({
    subject: 'Your phone number was changed',
    text: "Your account's phone number was just changed. If this was not you, contact support right away.",
  }),
  oauth2Unlinked: ({ provider }) => ({
    subject: 'A way to sign in was removed',
    text: `Your account can no longer sign in with ${provider}. If this was not you, reset your password and contact support right away.`,
  }),
  signInCode: ({ code }) => ({
    subject: 'Your sign-in code',
    text: `${code} is your sign-in code. It expires in a few minutes. Do not share it.\n\nIf you did not try to sign in, change your password right away.`,
  }),
  totpEnabled: () => ({
    subject: 'Two-step sign-in was turned on',
    text: 'Your account now asks for a code from your authenticator app when you sign in, and other devices were signed out. If this was not you, contact support right away.',
  }),
  totpDisabled: () => ({
    subject: 'Two-step sign-in was turned off',
    text: 'Your account no longer asks for a code from your authenticator app. If this was not you, reset your password and contact support right away.',
  }),
  passkeyAdded: () => ({
    subject: 'A passkey was added',
    text: 'Your account can now sign in with a new passkey. If this was not you, remove it, reset your password and contact support right away.',
  }),
  passkeyRemoved: () => ({
    subject: 'A passkey was removed',
    text: 'A passkey can no longer sign in to your account. If this was not you, reset your password and contact support right away.',
  }),
  mfaCleared: () => ({
    subject: 'Two-step sign-in was reset',
    text: 'A superuser removed the authenticator app and recovery codes of your account. If you did not ask for this, contact support right away.',
  }),
  mfaCodesPaused: ({ channel }) => ({
    subject: 'Sign-in codes paused after your password reset',
    text: `Your password was just reset through your ${channel === 'phone' ? 'phone' : 'email'}. For the next 24 hours, codes sent to your ${channel === 'phone' ? 'phone' : 'email'} will not count as your second sign-in step. If this was not you, contact support right away.`,
  }),
  recoveryCodeUsed: ({ remaining }) => ({
    subject: 'A recovery code was used',
    text: `A recovery code was just used for your account. You have ${remaining} left. If this was not you, reset your password and contact support right away.`,
  }),
};

/**
 * Sends after the response so timing does not reveal whether an account
 * exists; `waitUntil` keeps the work alive on serverless platforms.
 */
export class Mailer {
  readonly #options: MailOptions | undefined;
  readonly #appUrl: URL | undefined;
  readonly #waitUntil: (promise: Promise<unknown>) => void;
  readonly #logger: Logger;

  constructor(
    options: MailOptions | undefined,
    appUrl: URL | undefined,
    waitUntil: ((promise: Promise<unknown>) => void) | undefined,
    logger: Logger,
  ) {
    this.#options = options;
    this.#appUrl =
      options?.appUrl === undefined
        ? appUrl
        : checkAppUrl(options.appUrl, 'mail.appUrl');
    if (options && !this.#appUrl) {
      throw new TypeError(
        "Mail needs your app's URL for its links: pass the appUrl option.",
      );
    }
    this.#waitUntil = waitUntil ?? vercelWaitUntil;
    this.#logger = logger;
  }

  /** Development without mail set up logs emails instead, so flows work locally. */
  check(): void {
    if (this.#options || process.env.NODE_ENV !== 'production') return;
    throw new ApiError(
      400,
      'Sending email is not set up. Pass the mail option to new NextBase().',
      { mail: { code: 'mail_not_configured', message: 'Not set up.' } },
    );
  }

  /** Failures are logged, never shown to the caller. */
  send(
    kind: MailKind,
    collection: string,
    to: string,
    {
      token,
      provider,
      code,
      remaining,
      channel,
    }: {
      token?: string;
      provider?: string;
      code?: string;
      remaining?: number;
      channel?: 'email' | 'phone';
    } = {},
  ): void {
    const path = PATHS[kind];
    const url =
      path && token !== undefined && this.#appUrl
        ? withToken(this.#appUrl, path, token)
        : undefined;
    const context: MailContext = {
      kind,
      collection,
      to,
      ...(url !== undefined && { url }),
      ...(token !== undefined && { token }),
      ...(provider !== undefined && { provider }),
      ...(code !== undefined && { code }),
      ...(remaining !== undefined && { remaining }),
      ...(channel !== undefined && { channel }),
    };
    const template =
      this.#options?.templates?.[kind] ?? DEFAULT_TEMPLATES[kind];
    const options = this.#options;
    const work = (async () => {
      const content = template(context);
      if (!options) {
        console.info(
          `[nextbase] mail is not set up; this ${kind} email to ${to} was not sent:\n${content.subject}\n${content.text}${token !== undefined && !url ? `\nToken: ${token}` : ''}`,
        );
        return;
      }
      await options.send({ from: options.from, to, ...content });
    })().catch((error: unknown) => {
      this.#logger.failure('mail', `sending a ${kind} email failed`, error);
    });
    this.#waitUntil(work);
  }
}

function withToken(base: URL, path: string, token: string): string {
  const url = new URL(`${base.pathname.replace(/\/+$/, '')}${path}`, base);
  url.searchParams.set('token', token);
  return url.toString();
}
