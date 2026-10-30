import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { AuthCollection } from '@nextbasejs/client';
import type { Builder } from '@nextbasejs/dbx';
import type { Mailer } from './mail.ts';
import { countAttempt, mailKey } from './throttle.ts';

// Six-digit codes sent by email or text. The caller keeps each one hashed
// and single-use, and limits guesses.

/** A new six-digit code. */
export function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** A code as typed, if it can be one. */
export function typedCode(input: unknown): string | undefined {
  const code = typeof input === 'string' ? input.trim() : '';
  return /^\d{6}$/.test(code) ? code : undefined;
}

/** Salted with what the code is for, so a database leak shows no live codes. */
export function codeHash(salt: string, code: string): string {
  return createHash('sha256').update(`${salt}:${code}`).digest('hex');
}

export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Emails a new sign-in code to `to` and returns it. Emails per address are
 * capped as for every auth email, so no one can flood an inbox.
 */
export async function emailSignInCode(
  q: Builder,
  mailer: Mailer,
  collection: AuthCollection,
  to: string,
): Promise<string> {
  mailer.check();
  await countAttempt(q, [mailKey(collection.id, to)]);
  const code = newCode();
  mailer.send('signInCode', collection.name, to, { code });
  return code;
}
