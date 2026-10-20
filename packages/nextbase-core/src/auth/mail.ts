import { waitUntil as vercelWaitUntil } from "@vercel/functions";
import { checkAppUrl } from "../app-url.ts";
import { ApiError } from "../errors.ts";

/** One email, as `mail.send` receives it. */
export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** The emails auth flows send. */
export type MailKind =
  | "verification"
  | "passwordReset"
  | "emailChange"
  | "passwordChanged"
  | "emailChanged"
  | "oauth2Linked"
  | "oauth2Unlinked";

/** What a template gets to write one email. */
export interface MailContext {
  kind: MailKind;
  /** The auth collection, by name. */
  collection: string;
  to: string;
  /** The link to open, with the token: for verification, reset and email change. */
  url?: string;
  token?: string;
  /** The provider of `oauth2Linked` and `oauth2Unlinked`. */
  provider?: string;
}

export type MailTemplate = (context: MailContext) => {
  subject: string;
  text: string;
  html?: string;
};

export interface MailOptions {
  /** Sender address, such as `app@example.com`. */
  from: string;
  /** Sends one email, through any provider: SMTP, Resend, SES, Postmark... */
  send(message: MailMessage): Promise<void>;
  /**
   * Where the pages that take tokens live: `/verify-email`,
   * `/reset-password` and `/confirm-email-change`, each with `?token=`.
   * Defaults to the `appUrl` option.
   */
  appUrl?: string;
  /** Replaces the default subject and text of any kind of email. */
  templates?: Partial<Record<MailKind, MailTemplate>>;
}

const PATHS: Partial<Record<MailKind, string>> = {
  verification: "/verify-email",
  passwordReset: "/reset-password",
  emailChange: "/confirm-email-change",
};

const DEFAULT_TEMPLATES: Record<MailKind, MailTemplate> = {
  verification: ({ url }) => ({
    subject: "Verify your email",
    text: `Open this link to verify your email:\n\n${url}\n\nIf you did not ask for this, ignore this email.`,
  }),
  passwordReset: ({ url }) => ({
    subject: "Reset your password",
    text: `Open this link to choose a new password:\n\n${url}\n\nIf you did not ask for this, ignore this email; your password stays as it is.`,
  }),
  emailChange: ({ url }) => ({
    subject: "Confirm your new email",
    text: `Open this link to make this your account's email:\n\n${url}\n\nIf you did not ask for this, ignore this email.`,
  }),
  passwordChanged: () => ({
    subject: "Your password was changed",
    text: "Your password was just changed, and every device was signed out. If this was not you, reset your password right away.",
  }),
  emailChanged: ({ to }) => ({
    subject: "Your email was changed",
    text: `Your account's email was just changed from ${to} to another address. If this was not you, contact support right away.`,
  }),
  oauth2Linked: ({ provider }) => ({
    subject: "A new way to sign in was added",
    text: `Your account can now sign in with ${provider}. If this was not you, reset your password and contact support right away.`,
  }),
  oauth2Unlinked: ({ provider }) => ({
    subject: "A way to sign in was removed",
    text: `Your account can no longer sign in with ${provider}. If this was not you, reset your password and contact support right away.`,
  }),
};

/**
 * Sends auth emails in the background, after the response is decided, so
 * response times do not reveal whether an account exists (OWASP Forgot
 * Password Cheat Sheet). `waitUntil` keeps the work alive past the response
 * on serverless platforms.
 */
export class Mailer {
  readonly #options: MailOptions | undefined;
  readonly #appUrl: URL | undefined;
  readonly #waitUntil: (promise: Promise<unknown>) => void;

  constructor(
    options: MailOptions | undefined,
    appUrl: URL | undefined,
    waitUntil: ((promise: Promise<unknown>) => void) | undefined,
  ) {
    this.#options = options;
    this.#appUrl =
      options?.appUrl === undefined
        ? appUrl
        : checkAppUrl(options.appUrl, "mail.appUrl");
    if (options && !this.#appUrl) {
      throw new TypeError(
        "Mail needs your app's URL for its links: pass the appUrl option.",
      );
    }
    this.#waitUntil = waitUntil ?? vercelWaitUntil;
  }

  /**
   * Throws 400 when mail is not set up. Development without it logs emails
   * instead, so flows can be tried locally.
   */
  check(): void {
    if (this.#options || process.env.NODE_ENV !== "production") return;
    throw new ApiError(
      400,
      "Sending email is not set up. Pass the mail option to new NextBase().",
      { mail: { code: "mail_not_configured", message: "Not set up." } },
    );
  }

  /** Queues one email; failures are logged, never shown to the caller. */
  send(
    kind: MailKind,
    collection: string,
    to: string,
    { token, provider }: { token?: string; provider?: string } = {},
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
    };
    const template =
      this.#options?.templates?.[kind] ?? DEFAULT_TEMPLATES[kind];
    const options = this.#options;
    const work = (async () => {
      const content = template(context);
      if (!options) {
        console.info(
          `[nextbase] mail is not set up; this ${kind} email to ${to} was not sent:\n${content.subject}\n${content.text}${token !== undefined && !url ? `\nToken: ${token}` : ""}`,
        );
        return;
      }
      await options.send({ from: options.from, to, ...content });
    })().catch((error: unknown) => {
      console.error(`[nextbase] sending a ${kind} email failed:`, error);
    });
    this.#waitUntil(work);
  }
}

function withToken(base: URL, path: string, token: string): string {
  const url = new URL(`${base.pathname.replace(/\/+$/, "")}${path}`, base);
  url.searchParams.set("token", token);
  return url.toString();
}
