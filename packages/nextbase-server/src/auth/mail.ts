import { waitUntil as vercelWaitUntil } from "@vercel/functions";
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
  | "emailChanged";

/** What a template gets to write one email. */
export interface MailContext {
  kind: MailKind;
  /** The auth collection, by name. */
  collection: string;
  to: string;
  /** The link to open, with the token: for verification, reset and email change. */
  url?: string;
  token?: string;
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
   * Your app's URL, where the pages that take tokens live:
   * `/verify-email`, `/reset-password` and `/confirm-email-change`, each
   * with `?token=`. Never taken from the request's Host header, which an
   * attacker can set (OWASP Forgot Password Cheat Sheet). HTTPS, except on
   * localhost.
   */
  appUrl: string;
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
    waitUntil: ((promise: Promise<unknown>) => void) | undefined,
  ) {
    this.#options = options;
    this.#appUrl = options && checkAppUrl(options.appUrl);
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
  send(kind: MailKind, collection: string, to: string, token?: string): void {
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

function checkAppUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`mail.appUrl is not a URL: ${value}`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new TypeError(
      "mail.appUrl must use HTTPS, so links carrying tokens are not sent in the clear (http is allowed on localhost).",
    );
  }
  return url;
}

function withToken(base: URL, path: string, token: string): string {
  const url = new URL(`${base.pathname.replace(/\/+$/, "")}${path}`, base);
  url.searchParams.set("token", token);
  return url.toString();
}
