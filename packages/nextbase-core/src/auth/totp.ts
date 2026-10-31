import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

// TOTP (RFC 6238) on HMAC-SHA1 with 6 digits and 30-second steps, as every
// authenticator app supports, and one-time recovery codes.

const SECRET_BYTES = 20;
const DIGITS = 6;
const TOTP_PERIOD = 30;
/** Steps either side of now that are accepted, for clocks that drift. */
const WINDOW = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
// Crockford's base32: no I, L, O or U, so codes read back without mix-ups.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_CODE_BYTES = 10;
const RECOVERY_CODE_COUNT = 10;

export function newTotpSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

/** RFC 4648 base32 without padding, as authenticator apps expect. */
export function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** The code for one counter value (RFC 4226). */
export function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The current step for a time in milliseconds. */
export function totpStep(now: number): number {
  return Math.floor(now / 1000 / TOTP_PERIOD);
}

/**
 * The step whose code `code` is, within one step of `now`, or undefined.
 * Every candidate is compared, in constant time, so timing does not say which.
 */
export function matchTotp(
  secret: Buffer,
  code: string,
  now: number,
): number | undefined {
  if (!/^\d{6}$/.test(code)) return undefined;
  const typed = Buffer.from(code);
  const current = totpStep(now);
  let matched: number | undefined;
  for (let step = current - WINDOW; step <= current + WINDOW; step++) {
    if (timingSafeEqual(Buffer.from(hotp(secret, step)), typed)) {
      matched ??= step;
    }
  }
  return matched;
}

/** The URI an authenticator app reads, usually from a QR code. */
export function otpauthUri(
  secret: Buffer,
  issuer: string,
  account: string,
): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: base32(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(TOTP_PERIOD),
  });
  return `otpauth://totp/${label}?${params}`;
}

/** Ten codes of 80 bits each, shown as `XXXX-XXXX-XXXX-XXXX`. */
export function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const bytes = randomBytes(RECOVERY_CODE_BYTES);
    let bits = 0;
    let value = 0;
    let code = '';
    for (const byte of bytes) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        code += CROCKFORD[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    return (code.match(/.{4}/g) as string[]).join('-');
  });
}

/**
 * A typed recovery code in its stored form, or undefined. Case, spaces and dashes
 * are ignored, and letters that look like digits are read as those digits.
 */
export function normalizeRecoveryCode(input: string): string | undefined {
  if (input.length > 64) return undefined;
  const code = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (code.length !== 16 || ![...code].every((c) => CROCKFORD.includes(c))) {
    return undefined;
  }
  return code;
}

/** Salted with the record, so equal codes of two records differ. */
export function recoveryCodeHash(
  collectionId: string,
  recordId: string,
  normalized: string,
): string {
  return createHash('sha256')
    .update(`${collectionId}:${recordId}:${normalized}`)
    .digest('hex');
}
