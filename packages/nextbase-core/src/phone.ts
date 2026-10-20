import { parsePhoneNumberFromString } from "libphonenumber-js/max";

/**
 * A phone number in E.164, such as `+255712345678`, or undefined when
 * `input` is not a valid number in international format. Validated against
 * each country's numbering plan with libphonenumber's full metadata.
 */
export function normalizePhone(input: string): string | undefined {
  const trimmed = input.trim();
  // Without a country to assume, only international numbers can be read.
  if (!trimmed.startsWith("+")) return undefined;
  const parsed = parsePhoneNumberFromString(trimmed);
  return parsed?.isValid() ? parsed.number : undefined;
}

/** The ISO 3166-1 alpha-2 country of an E.164 number, when it has one. */
export function phoneCountry(phone: string): string | undefined {
  return parsePhoneNumberFromString(phone)?.country;
}
