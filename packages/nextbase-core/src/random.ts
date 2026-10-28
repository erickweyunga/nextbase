/** Alphabet of record, collection and field ids. */
export const LOWER_ALPHANUMERIC = "abcdefghijklmnopqrstuvwxyz0123456789";

/** The form of ids from `newId`, also checked by the database. */
export const ID_PATTERN: RegExp = /^[a-z0-9]{15}$/;

/** A new id for a record, a collection or a session. */
export function newId(): string {
  return randomString(15, LOWER_ALPHANUMERIC);
}

/** Whether `value` has the form of an id from `newId`. */
export function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** Alphabet of secrets. */
export const ALPHANUMERIC =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// Rejection sampling, not modulo, so the alphabet's start is not favored.
export function randomString(length: number, alphabet: string): string {
  if (alphabet.length === 0 || alphabet.length > 256) {
    throw new RangeError("randomString needs 1 to 256 alphabet characters.");
  }
  const limit = 256 - (256 % alphabet.length);
  const bytes = new Uint8Array(Math.max(length * 2, 16));
  let out = "";
  while (out.length < length) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= limit) continue;
      out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}
