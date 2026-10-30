import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Slow enough to make cracking stolen hashes expensive, yet only 16 MiB per
// hash so small serverless instances can verify several sign-ins at once.
const PARAMS = { ln: 14, r: 8, p: 5 } as const;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const FORMAT =
  /^\$scrypt\$ln=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

interface Params {
  ln: number;
  r: number;
  p: number;
}

function derive(
  password: string,
  salt: Buffer,
  { ln, r, p }: Params,
  length: number,
): Promise<Buffer> {
  const N = 2 ** ln;
  return new Promise((resolve, reject) => {
    scrypt(
      // One password can be typed as different Unicode sequences; NFC unifies them.
      password.normalize('NFC'),
      salt,
      length,
      { N, r, p, maxmem: 256 * N * r },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

const b64 = (bytes: Buffer): string =>
  bytes.toString('base64').replace(/=+$/, '');

/** PHC format: `$scrypt$ln=14,r=8,p=5$<salt>$<hash>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, PARAMS, KEY_LENGTH);
  return `$scrypt$ln=${PARAMS.ln},r=${PARAMS.r},p=${PARAMS.p}$${b64(salt)}$${b64(key)}`;
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  const match = FORMAT.exec(hash);
  if (!match) return false;
  const [, ln, r, p, salt, expected] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const params = { ln: Number(ln), r: Number(r), p: Number(p) };
  // Stored hashes come from this module, but bound the cost anyway.
  if (params.ln > 20 || params.r > 32 || params.p > 16) return false;
  const expectedKey = Buffer.from(expected, 'base64');
  const key = await derive(
    password,
    Buffer.from(salt, 'base64'),
    params,
    expectedKey.length,
  );
  return key.length === expectedKey.length && timingSafeEqual(key, expectedKey);
}

export function needsRehash(hash: string): boolean {
  return !hash.startsWith(
    `$scrypt$ln=${PARAMS.ln},r=${PARAMS.r},p=${PARAMS.p}$`,
  );
}

let dummyHash: Promise<string> | undefined;

/** Equalizes timing so an unknown identity is not answered faster than a wrong password. */
export async function verifyDummyPassword(password: string): Promise<void> {
  dummyHash ??= hashPassword('nextbase-dummy-password');
  await verifyPassword(password, await dummyHash);
}
