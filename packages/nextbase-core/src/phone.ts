import { parsePhoneNumberFromString } from "libphonenumber-js/max";

/** E.164 such as `+255712345678`, or undefined unless a valid international number. */
export function normalizePhone(input: string): string | undefined {
  const trimmed = input.trim();
  // Without a country to assume, only international numbers can be read.
  if (!trimmed.startsWith("+")) return undefined;
  const parsed = parsePhoneNumberFromString(trimmed);
  return parsed?.isValid() ? parsed.number : undefined;
}

/** The two-letter country code, when the number has one. */
export function phoneCountry(phone: string): string | undefined {
  return parsePhoneNumberFromString(phone)?.country;
}
