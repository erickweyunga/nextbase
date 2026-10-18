/** Alphabet of record, collection and field ids. */
export const LOWER_ALPHANUMERIC = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Alphabet of secrets. */
export const ALPHANUMERIC =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Returns `length` characters drawn uniformly from `alphabet` with a CSPRNG.
 * Bytes that would bias the result towards the start of the alphabet are
 * rejected rather than wrapped with modulo.
 */
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
