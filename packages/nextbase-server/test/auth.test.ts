import { describe, expect, it } from "vitest";
import {
  hashPassword,
  needsRehash,
  verifyPassword,
} from "../src/auth/password.ts";
import { signToken, verifyToken } from "../src/auth/tokens.ts";

describe("passwords", () => {
  it("hashes into PHC format with a fresh salt and verifies", async () => {
    const a = await hashPassword("correct horse battery staple");
    const b = await hashPassword("correct horse battery staple");
    expect(a).toMatch(
      /^\$scrypt\$ln=14,r=8,p=5\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/,
    );
    expect(a).not.toBe(b);
    expect(await verifyPassword("correct horse battery staple", a)).toBe(true);
    expect(await verifyPassword("correct horse battery stapler", a)).toBe(
      false,
    );
    expect(needsRehash(a)).toBe(false);
  });

  it("normalizes Unicode, so the same password typed differently matches", async () => {
    const hash = await hashPassword("café");
    expect(await verifyPassword("café", hash)).toBe(true);
  });

  it("never matches malformed or unbounded hashes, and flags old parameters", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "$2b$10$bcryptstyle")).toBe(false);
    expect(
      await verifyPassword("x", "$scrypt$ln=30,r=8,p=1$c2FsdA$aGFzaA"),
    ).toBe(false);
    expect(needsRehash("$scrypt$ln=13,r=8,p=1$c2FsdA$aGFzaA")).toBe(true);
  });
});

describe("tokens", () => {
  const key = "a-signing-key-of-reasonable-length";

  it("verifies its own tokens and exposes their claims", async () => {
    const token = await signToken(key, { type: "auth", id: "abc" }, 60);
    expect(await verifyToken(token, key, "auth")).toMatchObject({
      type: "auth",
      id: "abc",
    });
  });

  it("rejects another key, another type, expired tokens and tampering", async () => {
    const token = await signToken(key, { type: "auth", id: "abc" }, 60);
    expect(await verifyToken(token, `${key}x`, "auth")).toBeUndefined();
    expect(await verifyToken(token, key, "setup")).toBeUndefined();
    expect(
      await verifyToken(
        await signToken(key, { type: "auth" }, -10),
        key,
        "auth",
      ),
    ).toBeUndefined();

    const [header, payload, signature] = token.split(".") as [
      string,
      string,
      string,
    ];
    const forged = Buffer.from(
      JSON.stringify({ type: "auth", id: "admin", exp: 9e9 }),
    ).toString("base64url");
    expect(
      await verifyToken(`${header}.${forged}.${signature}`, key, "auth"),
    ).toBeUndefined();
    const none = Buffer.from(
      JSON.stringify({ alg: "none", typ: "JWT" }),
    ).toString("base64url");
    expect(
      await verifyToken(`${none}.${payload}.`, key, "auth"),
    ).toBeUndefined();
  });
});
