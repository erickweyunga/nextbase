import { waitUntil as vercelWaitUntil } from "@vercel/functions";
import { ApiError } from "../errors.ts";
import { phoneCountry } from "../phone.ts";

/** One text message, as `sms.send` receives it. */
export interface SmsMessage {
  /** In E.164, such as `+255712345678`. */
  to: string;
  text: string;
}

/** The texts phone sign-in sends. */
export type SmsKind =
  | "signIn"
  | "passwordReset"
  | "verifyPhone"
  | "phoneChanged";

/** What a template gets to write one text. */
export interface SmsContext {
  kind: SmsKind;
  /** The auth collection, by name. */
  collection: string;
  to: string;
  /** The code to enter, for every kind but `phoneChanged`. */
  code?: string;
}

export type SmsTemplate = (context: SmsContext) => string;

export interface SmsOptions {
  /** Sends one text, through any provider: Twilio, Africa's Talking, AWS SNS... */
  send(message: SmsMessage): Promise<void>;
  /**
   * The countries texts may go to, as ISO 3166-1 alpha-2 codes such as
   * `["TZ", "KE"]`. Limiting them is the strongest defense against SMS
   * pumping, where attackers request codes to premium numbers they profit
   * from. Defaults to every country.
   */
  countries?: string[];
  /** Replaces the default text of any kind of message. */
  templates?: Partial<Record<SmsKind, SmsTemplate>>;
}

const DEFAULT_TEMPLATES: Record<SmsKind, SmsTemplate> = {
  signIn: ({ code }) =>
    `${code} is your sign-in code. It expires in 10 minutes. Do not share it.`,
  passwordReset: ({ code }) =>
    `${code} is your password reset code. It expires in 10 minutes. If you did not ask for it, ignore this message.`,
  verifyPhone: ({ code }) =>
    `${code} is your code to verify this phone number. It expires in 10 minutes.`,
  phoneChanged: () =>
    "The phone number of your account was just changed. If this was not you, contact support right away.",
};

/**
 * Sends texts in the background, after the response is decided, so response
 * times do not reveal whether an account exists. `waitUntil` keeps the work
 * alive past the response on serverless platforms.
 */
export class Sms {
  readonly #options: SmsOptions | undefined;
  readonly #countries: ReadonlySet<string> | undefined;
  readonly #waitUntil: (promise: Promise<unknown>) => void;

  constructor(
    options: SmsOptions | undefined,
    waitUntil: ((promise: Promise<unknown>) => void) | undefined,
  ) {
    this.#options = options;
    this.#countries =
      options?.countries &&
      new Set(options.countries.map((c) => c.toUpperCase()));
    this.#waitUntil = waitUntil ?? vercelWaitUntil;
  }

  /**
   * Throws 400 when texts cannot go to `phone`: SMS is not set up (outside
   * development, where texts are logged instead), or its country is not
   * allowed.
   */
  check(phone: string): void {
    if (!this.#options && process.env.NODE_ENV === "production") {
      throw new ApiError(
        400,
        "Sending SMS is not set up. Pass the sms option to new NextBase().",
        { sms: { code: "sms_not_configured", message: "Not set up." } },
      );
    }
    const country = phoneCountry(phone);
    if (this.#countries && !(country && this.#countries.has(country))) {
      throw new ApiError(400, "Texts cannot be sent to this country.", {
        phone: {
          code: "validation_country_not_allowed",
          message: "Texts cannot be sent to this country.",
        },
      });
    }
  }

  /** Queues one text; failures are logged, never shown to the caller. */
  send(kind: SmsKind, collection: string, to: string, code?: string): void {
    const template =
      this.#options?.templates?.[kind] ?? DEFAULT_TEMPLATES[kind];
    const options = this.#options;
    const work = (async () => {
      const text = template({
        kind,
        collection,
        to,
        ...(code !== undefined && { code }),
      });
      if (!options) {
        console.info(
          `[nextbase] sms is not set up; this ${kind} text to ${to} was not sent:\n${text}`,
        );
        return;
      }
      await options.send({ to, text });
    })().catch((error: unknown) => {
      console.error(`[nextbase] sending a ${kind} text failed:`, error);
    });
    this.#waitUntil(work);
  }
}
