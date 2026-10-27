import { decodeJwt, type JWTPayload, jwtVerify, SignJWT } from "jose";

const encoder = new TextEncoder();

export interface TokenClaims {
  /** Checked on verification, so one kind of token can never pass as another. */
  type: string;
  [claim: string]: unknown;
}

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

/** Unverified decode, only to find the record whose key verifies it. Never trust it before `verifyToken`. */
export function peekToken(token: string): JWTPayload | undefined {
  try {
    return decodeJwt(token);
  } catch {
    return undefined;
  }
}

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
