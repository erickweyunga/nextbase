import { decodeJwt, type JWTPayload, jwtVerify, SignJWT } from "jose";
import { isId } from "../random.ts";

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

/**
 * Unverified decode, only to find the record whose key verifies it. Never
 * trust it before `verifyToken`. Anyone can forge these claims, so they are
 * checked to be ids before they go into a query.
 */
export function peekToken(
  token: string,
): { id: string; collectionId: string } | undefined {
  let claims: JWTPayload;
  try {
    claims = decodeJwt(token);
  } catch {
    return undefined;
  }
  const { id, collectionId } = claims;
  // The collection id is only compared or looked up in the schema, and
  // system collections such as `_superusers` have ids of another form.
  if (!isId(id) || typeof collectionId !== "string") return undefined;
  return { id, collectionId };
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
