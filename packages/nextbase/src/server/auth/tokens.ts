import { decodeJwt, type JWTPayload, jwtVerify, SignJWT } from "jose";

const encoder = new TextEncoder();

export interface TokenClaims {
  /** What the token is for. Checked on verification, so one kind can never pass as another. */
  type: string;
  [claim: string]: unknown;
}

/** Signs an HS256 JWT valid for `durationSeconds`. */
export function signToken(
  key: string,
  claims: TokenClaims,
  durationSeconds: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(now + durationSeconds)
    .sign(encoder.encode(key));
}

/**
 * Reads a token's claims without verifying it, to find the record whose key
 * verifies it. Never trust the result before `verifyToken` succeeds.
 */
export function peekToken(token: string): JWTPayload | undefined {
  try {
    return decodeJwt(token);
  } catch {
    return undefined;
  }
}

/**
 * Verifies an HS256 token signed with `key` and of the given `type`. Returns
 * its claims, or undefined for any token that is malformed, forged, expired,
 * of another type, or uses another algorithm.
 */
export async function verifyToken(
  token: string,
  key: string,
  type: string,
): Promise<JWTPayload | undefined> {
  try {
    const { payload } = await jwtVerify(token, encoder.encode(key), {
      algorithms: ["HS256"],
      requiredClaims: ["exp", "type"],
    });
    return payload.type === type ? payload : undefined;
  } catch {
    return undefined;
  }
}
