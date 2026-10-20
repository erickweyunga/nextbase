import { createHash } from "node:crypto";
import { ApiError } from "../errors.ts";

// Checks new passwords against Have I Been Pwned's Pwned Passwords, as NIST
// SP 800-63B requires of passwords that users choose. Through the range API's
// k-anonymity model, only the first 5 characters of the password's SHA-1
// leave the server, and padded responses hide which prefix had matches.

const RANGE_API = "https://api.pwnedpasswords.com/range/";
const TIMEOUT_MS = 5_000;
const LINE = /^([0-9A-F]{35}):(\d+)$/;

/**
 * Rejects a password found in known data breaches with a 400 on `password`.
 * When the service cannot be reached or answers unexpectedly, the password
 * is accepted and a warning logged, so an outage never blocks sign-ups.
 */
export async function checkBreached(password: string): Promise<void> {
  const sha1 = createHash("sha1")
    .update(password.normalize("NFC"))
    .digest("hex")
    .toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  let body: string;
  try {
    const response = await fetch(`${RANGE_API}${prefix}`, {
      headers: { "add-padding": "true", "user-agent": "nextbase" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
    body = await response.text();
  } catch (error) {
    console.warn(
      "[nextbase] the breached password check is unavailable; the password was accepted:",
      error,
    );
    return;
  }
  const lines = body.split(/\r?\n/).filter((line) => line !== "");
  // A captive portal or proxy can answer 200 with something else entirely.
  if (lines.length === 0 || !lines.every((line) => LINE.test(line))) {
    console.warn(
      "[nextbase] the breached password check got an unexpected answer; the password was accepted.",
    );
    return;
  }
  // Padding entries have a count of 0 and match no real password.
  const breached = lines.some((line) => {
    const [, hash, count] = LINE.exec(line) as RegExpExecArray;
    return hash === suffix && Number(count) > 0;
  });
  if (breached) {
    throw new ApiError(400, "Failed to save the password.", {
      password: {
        code: "validation_breached_password",
        message:
          "This password has appeared in a data breach. Choose another one.",
      },
    });
  }
}
