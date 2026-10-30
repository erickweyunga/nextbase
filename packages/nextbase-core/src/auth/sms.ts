import { waitUntil as vercelWaitUntil } from '@vercel/functions';
import { ApiError } from '../errors.ts';
import type { Logger } from '../logs/logger.ts';
import { phoneCountry } from '../phone.ts';

export interface SmsMessage {
  /** In E.164, such as `+255712345678`. */
  to: string;
  text: string;
}

export type SmsKind =
  | 'signIn'
  | 'passwordReset'
  | 'verifyPhone'
  | 'phoneChanged';

export interface SmsContext {
  kind: SmsKind;
  /** The auth collection name. */
  collection: string;
  to: string;
  /** The code to enter, for every kind but `phoneChanged`. */
  code?: string;
}

export type SmsTemplate = (context: SmsContext) => string;

export interface SmsOptions {
  /** Sends one text through any provider (Twilio, Africa's Talking, AWS SNS...). */
  send(message: SmsMessage): Promise<void>;
  /**
   * Allowed destination countries, such as `["TZ", "KE"]`; defaults to all.
   * The strongest defense against attackers texting premium numbers on your bill.
   */
  countries?: string[];
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
    'The phone number of your account was just changed. If this was not you, contact support right away.',
};

/**
 * Sends after the response so timing does not reveal whether an account
 * exists; `waitUntil` keeps the work alive on serverless platforms.
 */
export class Sms {
  readonly #options: SmsOptions | undefined;
  readonly #countries: ReadonlySet<string> | undefined;
  readonly #waitUntil: (promise: Promise<unknown>) => void;
  readonly #logger: Logger;

  constructor(
    options: SmsOptions | undefined,
    waitUntil: ((promise: Promise<unknown>) => void) | undefined,
    logger: Logger,
  ) {
    this.#options = options;
    this.#countries =
      options?.countries &&
      new Set(options.countries.map((c) => c.toUpperCase()));
    this.#waitUntil = waitUntil ?? vercelWaitUntil;
    this.#logger = logger;
  }

  /** Development without SMS set up logs texts instead. */
  check(phone: string): void {
    if (!this.#options && process.env.NODE_ENV === 'production') {
      throw new ApiError(
        400,
        'Sending SMS is not set up. Pass the sms option to new NextBase().',
        { sms: { code: 'sms_not_configured', message: 'Not set up.' } },
      );
    }
    const country = phoneCountry(phone);
    if (this.#countries && !(country && this.#countries.has(country))) {
      throw new ApiError(400, 'Texts cannot be sent to this country.', {
        phone: {
          code: 'validation_country_not_allowed',
          message: 'Texts cannot be sent to this country.',
        },
      });
    }
  }

  /** Failures are logged, never shown to the caller. */
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
      this.#logger.failure('sms', `sending a ${kind} text failed`, error);
    });
    this.#waitUntil(work);
  }
}
