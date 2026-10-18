import { type DB, hash, type Row } from "@nextbase/dbx";
import type { AuthCollection } from "../../shared/schema.ts";
import { table } from "../db/system.ts";
import { ApiError } from "../errors.ts";
import type { Schema } from "../schema/cache.ts";
import { peekToken, signToken, verifyToken } from "./tokens.ts";

/** Who is making a request. */
export interface Principal {
  /** The auth collection of the authenticated record. */
  collection?: AuthCollection;
  /** The authenticated record's row. */
  record?: Row;
  /** Whether the record is a superuser, who bypasses every rule. */
  superuser: boolean;
}

const ANONYMOUS: Principal = { superuser: false };

const SUPERUSERS = "_superusers";

/** Signs a token with the record's own key: rotating `tokenKey` revokes it. */
export function authToken(
  collection: AuthCollection,
  record: Row,
): Promise<string> {
  const { secret, duration } = collection.tokens.auth;
  return signToken(
    `${record.tokenKey as string}${secret}`,
    {
      type: "auth",
      id: record.id,
      collectionId: collection.id,
      refreshable: true,
    },
    duration,
  );
}

/**
 * Resolves the `Authorization: Bearer <token>` header. No header means an
 * anonymous request; a header with an invalid or expired token is a 401, so
 * clients notice instead of silently getting anonymous results.
 */
export async function resolvePrincipal(
  request: Request,
  db: DB,
  schema: Schema,
): Promise<Principal> {
  const header = request.headers.get("authorization");
  if (header === null) return ANONYMOUS;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  const invalid = new ApiError(
    401,
    "The authorization token is invalid or has expired.",
  );
  if (!match) throw invalid;
  const token = match[1] as string;

  const claims = peekToken(token);
  const collection =
    typeof claims?.collectionId === "string"
      ? schema.find(claims.collectionId)
      : undefined;
  if (collection?.type !== "auth" || typeof claims?.id !== "string")
    throw invalid;

  const [record] = await db
    .select()
    .from(table(collection.name))
    .where(hash({ id: claims.id }))
    .all();
  if (!record) throw invalid;
  const verified = await verifyToken(
    token,
    `${record.tokenKey as string}${collection.tokens.auth.secret}`,
    "auth",
  );
  if (!verified) throw invalid;
  return { collection, record, superuser: collection.id === SUPERUSERS };
}

/** Throws 401 for anonymous callers and 403 for authenticated non-superusers. */
export function requireSuperuser(principal: Principal): void {
  if (principal.superuser) return;
  if (!principal.record)
    throw new ApiError(401, "Sign in as a superuser to do this.");
  throw new ApiError(403, "Only superusers can do this.");
}
