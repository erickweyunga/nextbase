import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

// AES-256-GCM as `v1.<key id>.<iv>.<ciphertext>.<tag>`. The AAD binds a value to
// its row, and the key id is a hash so keys can be reordered or retired freely.

const VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64 = /^[A-Za-z0-9+/]{43}=$/;

interface Key {
  id: string;
  key: Buffer;
}

export class SecretKeys {
  readonly #keys: readonly Key[];

  /**
   * Each key is the base64 of 32 random bytes. The first encrypts and all
   * decrypt, so a new key goes first and old ones stay until rotated out.
   */
  constructor(option: string | readonly string[] | undefined) {
    const list =
      option === undefined
        ? []
        : typeof option === 'string'
          ? [option]
          : option;
    this.#keys = list.map((text, i) => {
      const trimmed = typeof text === 'string' ? text.trim() : '';
      if (!BASE64.test(trimmed)) {
        throw new TypeError(
          `secretKey${list.length > 1 ? `[${i}]` : ''} must be the base64 of 32 random bytes, such as the output of \`openssl rand -base64 32\`.`,
        );
      }
      const key = Buffer.from(trimmed, 'base64');
      if (key.length !== KEY_BYTES) {
        throw new TypeError('secretKey must decode to exactly 32 bytes.');
      }
      return { id: keyId(key), key };
    });
  }

  get configured(): boolean {
    return this.#keys.length > 0;
  }

  encrypt(plain: Buffer, aad: string): string {
    const [current] = this.#keys;
    if (!current) throw new Error('No secretKey is set.');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', current.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return [
      VERSION,
      current.id,
      iv.toString('base64url'),
      ciphertext.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.');
  }

  /** Undefined when no key opens it, or it was made for other data. */
  decrypt(stored: string, aad: string): Buffer | undefined {
    const [version, id, iv, ciphertext, tag, ...rest] = stored.split('.');
    if (
      version !== VERSION ||
      rest.length > 0 ||
      iv === undefined ||
      ciphertext === undefined ||
      tag === undefined
    ) {
      return undefined;
    }
    const found = this.#keys.find((k) => k.id === id);
    if (!found) return undefined;
    const ivBytes = Buffer.from(iv, 'base64url');
    const tagBytes = Buffer.from(tag, 'base64url');
    if (ivBytes.length !== IV_BYTES || tagBytes.length !== TAG_BYTES) {
      return undefined;
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', found.key, ivBytes);
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(tagBytes);
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64url')),
        decipher.final(),
      ]);
    } catch {
      return undefined;
    }
  }
}

/** The env value: one key, or several separated by commas. */
export function secretKeysFromEnv(
  value: string | undefined,
): string[] | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return value.split(',').map((part) => part.trim());
}

function keyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('base64url').slice(0, 8);
}
