import { createHash, randomBytes } from "node:crypto";
import type { NextBaseClient } from "@nextbasejs/client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type MailMessage, NextBase } from "../src/index.ts";
import { call, origin } from "./http.ts";
import { createTestDatabase, type TestDatabase } from "./postgres.ts";

const ISSUER = "https://idp.example.com";
/** Where a provider sends the browser back. */
const callbackOf = (provider: string): string =>
  `${origin}/api/nextbase/callback/${provider}`;
const PASSWORD = "password 123 456";

/** The account a fake provider signs in, and how it answers. */
interface Account {
  sub: string;
  email?: string;
  /** Whether the provider verified `email`; it did unless this says no. */
  emailVerified?: boolean;
  /** Overrides the nonce in the ID token. */
  nonce?: string;
}

interface Grant {
  challenge: string;
  redirectUri: string;
  nonce: string | null;
  account: Account;
}

describe("OAuth2 sign-in", () => {
  let t: TestDatabase;
  let nextbase: NextBase;
  let admin: NextBaseClient;
  const sent: MailMessage[] = [];
  const pending: Promise<unknown>[] = [];
  const grants = new Map<string, Grant>();
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;

  /** A fake OpenID Connect provider and GitHub, behind fetch. */
  const provider = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.href === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.href === `${ISSUER}/jwks`) {
      return Response.json({ keys: [await exportJWK(keys.publicKey)] });
    }
    const tokenEndpoint =
      url.href === `${ISSUER}/token` ||
      url.href === "https://github.com/login/oauth/access_token";
    if (tokenEndpoint && request.method === "POST") {
      const body = new URLSearchParams(await request.text());
      const grant = grants.get(body.get("code") ?? "");
      grants.delete(body.get("code") ?? "");
      const verifier = createHash("sha256")
        .update(body.get("code_verifier") ?? "")
        .digest("base64url");
      if (
        !grant ||
        verifier !== grant.challenge ||
        body.get("redirect_uri") !== grant.redirectUri ||
        body.get("client_secret") !== "secret"
      ) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      const accessToken = `at-${grant.account.sub}`;
      if (url.hostname === "github.com") {
        return Response.json({
          access_token: accessToken,
          token_type: "bearer",
          scope: "read:user,user:email",
        });
      }
      const idToken = await new SignJWT({
        ...(grant.account.email !== undefined && {
          email: grant.account.email,
          email_verified: grant.account.emailVerified ?? true,
        }),
        nonce: grant.account.nonce ?? grant.nonce,
      })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(ISSUER)
        .setSubject(grant.account.sub)
        .setAudience("client")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(keys.privateKey);
      return Response.json({
        access_token: accessToken,
        token_type: "Bearer",
        id_token: idToken,
      });
    }
    if (url.hostname === "api.github.com") {
      const sub = (request.headers.get("authorization") ?? "").replace(
        "Bearer at-",
        "",
      );
      if (url.pathname === "/user") return Response.json({ id: Number(sub) });
      if (url.pathname === "/user/emails") {
        return Response.json([
          { email: `old${sub}@example.com`, primary: false, verified: true },
          { email: `gh${sub}@example.com`, primary: true, verified: true },
        ]);
      }
    }
    return new Response("not found", { status: 404 });
  };

  const raw = (
    method: string,
    path: string,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    nextbase.handle(
      new Request(
        path.startsWith("http") ? path : `${origin}/api/nextbase${path}`,
        {
          method,
          headers,
        },
      ),
    );

  const cookieOf = (response: Response, name: string): string | undefined =>
    response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0] as string)
      .find((c) => c.startsWith(`${name}=`) && c !== `${name}=`);

  /**
   * Starts a sign-in, lets the fake provider approve `account`, and returns
   * the callback's response.
   */
  const signIn = async (
    providerName: string,
    account: Account,
    {
      query = "",
      cookie,
      tamper,
      signedOut = false,
    }: {
      query?: string;
      /** The session cookie to start with. */
      cookie?: string;
      tamper?: (callback: URL, stateCookie: string) => [URL, string];
      /** Return from the provider without the session cookie. */
      signedOut?: boolean;
    } = {},
  ): Promise<Response> => {
    const start = await raw(
      "GET",
      `/collections/users/auth-with-oauth2/${providerName}${query}`,
      {
        ...(cookie && { cookie, "sec-fetch-site": "same-origin" }),
      },
    );
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.get("location") ?? "");
    const redirectUri = authorize.searchParams.get("redirect_uri") ?? "";
    expect(redirectUri).toBe(callbackOf(providerName));
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const code = randomBytes(16).toString("hex");
    grants.set(code, {
      challenge: authorize.searchParams.get("code_challenge") ?? "",
      redirectUri,
      nonce: authorize.searchParams.get("nonce"),
      account,
    });
    let callback = new URL(redirectUri);
    callback.searchParams.set("code", code);
    callback.searchParams.set(
      "state",
      authorize.searchParams.get("state") ?? "",
    );
    let stateCookie = cookieOf(start, "nextbase_oauth2") ?? "";
    if (tamper) [callback, stateCookie] = tamper(callback, stateCookie);
    return raw("GET", callback.href, {
      cookie: [stateCookie, signedOut ? undefined : cookie]
        .filter(Boolean)
        .join("; "),
    });
  };

  const errorOf = (response: Response): string | null =>
    new URL(response.headers.get("location") ?? "").searchParams.get("error");

  /** The session a successful sign-in set, as a cookie header. */
  const sessionOf = (response: Response): string => {
    expect(response.status).toBe(302);
    expect(errorOf(response)).toBeNull();
    const cookie = cookieOf(response, "nextbase_session");
    expect(cookie).toBeDefined();
    return cookie as string;
  };

  const whoami = async (cookie: string): Promise<Record<string, unknown>> => {
    const response = await raw("GET", "/session", { cookie });
    expect(response.status).toBe(200);
    return ((await response.json()) as { record: Record<string, unknown> })
      .record;
  };

  /**
   * Creates an account with a password, its email verified unless `verified`
   * says no, and signs it in with a token.
   */
  const passwordAccount = async (email: string, verified = true) => {
    const users = nextbase.client().collection("users");
    await users.create({
      email,
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    const { record } = await users.signInWithPassword(email, PASSWORD);
    if (verified) {
      await admin
        .collection("users")
        .update(record.id, { emailVerified: true });
    }
    return users.signInWithPassword(email, PASSWORD);
  };

  /** Signs in with a cookie, as a browser would, and returns the cookie. */
  const cookieSignIn = async (email: string): Promise<string> => {
    const response = await nextbase.handle(
      new Request(
        `${origin}/api/nextbase/collections/users/auth-with-password`,
        {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({
            identity: email,
            password: PASSWORD,
            cookie: true,
          }),
        },
      ),
    );
    return cookieOf(response, "nextbase_session") as string;
  };

  const findUser = async (email: string) =>
    admin
      .collection("users")
      .getFirstListItem(`email = "${email}"`)
      .catch(() => undefined);

  beforeAll(async () => {
    keys = await generateKeyPair("RS256");
    vi.stubGlobal("fetch", provider);
    t = await createTestDatabase();
    nextbase = new NextBase({
      database: t.pool,
      appUrl: origin,
      oauth2: {
        idp: { issuer: ISSUER, clientId: "client", clientSecret: "secret" },
        github: { clientId: "client", clientSecret: "secret" },
      },
      mail: {
        from: "app@example.com",
        send: async (message) => {
          sent.push(message);
        },
      },
      waitUntil: (promise) => pending.push(promise),
    });
    admin = nextbase.client({ superuser: true });
    await admin.collections.create({
      name: "users",
      type: "auth",
      createRule: "",
      viewRule: "id = @request.auth.id",
    });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await t.close();
  });

  it("lists the providers a sign-in page can offer", async () => {
    const methods = await nextbase
      .client()
      .collection("users")
      .listAuthMethods();
    expect(methods.oauth2).toEqual({
      enabled: true,
      providers: [
        { name: "idp", displayName: "idp" },
        { name: "github", displayName: "GitHub" },
      ],
    });
    const superusers = await nextbase
      .client()
      .collection("_superusers")
      .listAuthMethods();
    expect(superusers.oauth2).toEqual({ enabled: false, providers: [] });
  });

  it("signs up a new account with the email the provider verified", async () => {
    const response = await signIn(
      "idp",
      { sub: "u1", email: "ada@example.com", emailVerified: true },
      { query: "?redirect=/home" },
    );
    expect(response.headers.get("location")).toBe(`${origin}/home`);
    const record = await whoami(sessionOf(response));
    expect(record).toMatchObject({
      email: "ada@example.com",
      emailVerified: true,
    });
  });

  it("signs the same provider account in to the same record, even after an email change there", async () => {
    const first = await whoami(
      sessionOf(await signIn("idp", { sub: "u2", email: "bo@example.com" })),
    );
    const again = await whoami(
      sessionOf(
        await signIn("idp", { sub: "u2", email: "bo.new@example.com" }),
      ),
    );
    expect(again.id).toBe(first.id);
    expect(again.email).toBe("bo@example.com");
  });

  it("signs in with GitHub through its API and primary email", async () => {
    const record = await whoami(
      sessionOf(await signIn("github", { sub: "42" })),
    );
    expect(record).toMatchObject({
      email: "gh42@example.com",
      emailVerified: true,
    });
  });

  it("rejects a callback without this browser's state cookie, or a second time", async () => {
    const stolen = await signIn(
      "idp",
      { sub: "u3", email: "cy@example.com" },
      { tamper: (callback) => [callback, ""] },
    );
    expect(errorOf(stolen)).toBe("oauth2_failed");
    expect(cookieOf(stolen, "nextbase_session")).toBeUndefined();

    let replay: [URL, string] | undefined;
    const used = await signIn(
      "idp",
      { sub: "u3", email: "cy@example.com" },
      {
        tamper: (callback, cookie) => {
          replay = [callback, cookie];
          return [callback, cookie];
        },
      },
    );
    sessionOf(used);
    const [callback, cookie] = replay as [URL, string];
    const again = await raw("GET", callback.href, { cookie });
    expect(errorOf(again)).toBe("oauth2_failed");
  });

  it("rejects a sign-in returning to another provider's callback", async () => {
    const response = await signIn(
      "idp",
      { sub: "u14", email: "max@example.com" },
      {
        tamper: (callback, cookie) => [
          new URL(`${callbackOf("github")}${callback.search}`),
          cookie,
        ],
      },
    );
    expect(errorOf(response)).toBe("oauth2_failed");
    expect(await findUser("max@example.com")).toBeUndefined();
  });

  it("rejects an ID token issued for another sign-in", async () => {
    // Logged, as any unexpected failure of a provider is.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await signIn("idp", {
      sub: "u4",
      email: "di@example.com",
      nonce: "another",
    });
    expect(errorOf(response)).toBe("oauth2_failed");
    expect(await findUser("di@example.com")).toBeUndefined();
    expect(String(logged.mock.calls[0]?.[1])).toMatch(/nonce/);
    logged.mockRestore();
  });

  it("reports a sign-in the user cancelled at the provider", async () => {
    const response = await signIn(
      "idp",
      { sub: "u5" },
      {
        query: "?redirect=/home&errorRedirect=%2Fsign-in%3Fnext%3D%2Fhome",
        tamper: (callback, cookie) => {
          const denied = new URL(callback);
          denied.searchParams.delete("code");
          denied.searchParams.set("error", "access_denied");
          return [denied, cookie];
        },
      },
    );
    expect(response.headers.get("location")).toBe(
      `${origin}/sign-in?next=%2Fhome&error=oauth2_denied`,
    );
    expect(errorOf(response)).toBe("oauth2_denied");
  });

  it("links an existing account by email only when both sides verified it", async () => {
    const users = admin.collection("users");
    const existing = await users.create({
      email: "eve@example.com",
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    if (!existing) throw new Error("A superuser views every record.");
    // NextBase never verified the address: whoever owns the provider account
    // may not own this one.
    expect(
      errorOf(
        await signIn("idp", {
          sub: "u6",
          email: "EVE@example.com",
          emailVerified: true,
        }),
      ),
    ).toBe("account_exists");

    await users.update(existing.id, { emailVerified: true });
    // The provider did not verify it.
    expect(
      errorOf(
        await signIn("idp", {
          sub: "u6",
          email: "eve@example.com",
          emailVerified: false,
        }),
      ),
    ).toBe("email_not_verified");

    const record = await whoami(
      sessionOf(
        await signIn("idp", {
          sub: "u6",
          email: "eve@example.com",
          emailVerified: true,
        }),
      ),
    );
    expect(record.id).toBe(existing.id);
    await Promise.all(pending.splice(0));
    expect(sent.at(-1)).toMatchObject({
      to: "eve@example.com",
      subject: "A new way to sign in was added",
    });
  });

  it("links and unlinks a provider for the signed-in account", async () => {
    const { token, record } = await passwordAccount("fay@example.com");
    const linked = await signIn(
      "github",
      { sub: "77" },
      {
        query: "?link=true&redirect=/settings",
        cookie: await cookieSignIn("fay@example.com"),
      },
    );
    expect(linked.headers.get("location")).toBe(`${origin}/settings`);
    // Linking keeps the current session.
    expect(cookieOf(linked, "nextbase_session")).toBeUndefined();

    const path = `/collections/users/records/${record.id}/linked-accounts`;
    const list = await call(nextbase, "GET", path, { token });
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([
      expect.objectContaining({ provider: "github" }),
    ]);
    // GitHub now signs in to this account, though its email is another.
    const viaGithub = await whoami(
      sessionOf(await signIn("github", { sub: "77" })),
    );
    expect(viaGithub.id).toBe(record.id);

    // Someone else may neither see nor remove the link.
    const { token: other } = await passwordAccount("gus@example.com");
    expect((await call(nextbase, "GET", path, { token: other })).status).toBe(
      404,
    );
    const unlink = `${path}/github`;
    expect(
      (await call(nextbase, "DELETE", unlink, { token: other })).status,
    ).toBe(404);
    expect((await call(nextbase, "DELETE", unlink, { token })).status).toBe(
      204,
    );
    await Promise.all(pending.splice(0));
    expect(sent.at(-1)).toMatchObject({
      to: "fay@example.com",
      subject: "A way to sign in was removed",
    });
    expect(sent.at(-1)?.text).toContain("GitHub");
    expect((await call(nextbase, "DELETE", unlink, { token })).status).toBe(
      404,
    );
  });

  it("refuses to link a provider account another record already has", async () => {
    await signIn("idp", { sub: "u8", email: "hal@example.com" });
    await passwordAccount("ivy@example.com");
    const response = await signIn(
      "idp",
      { sub: "u8" },
      { query: "?link=true", cookie: await cookieSignIn("ivy@example.com") },
    );
    expect(errorOf(response)).toBe("already_linked");
  });

  it("links only to the account still signed in on the browser", async () => {
    await passwordAccount("joy@example.com");
    const cookie = await cookieSignIn("joy@example.com");
    const response = await signIn(
      "idp",
      { sub: "u13" },
      {
        query: "?link=true",
        cookie,
        // Signed out between starting and finishing.
        signedOut: true,
      },
    );
    expect(errorOf(response)).toBe("oauth2_failed");
  });

  it("does not start a link for a signed-out caller or from another site", async () => {
    const signedOut = await raw(
      "GET",
      "/collections/users/auth-with-oauth2/idp?link=true",
      { "sec-fetch-site": "same-origin" },
    );
    expect(signedOut.status).toBe(401);
    const crossSite = await raw(
      "GET",
      "/collections/users/auth-with-oauth2/idp?link=true",
      { "sec-fetch-site": "cross-site" },
    );
    expect(crossSite.status).toBe(403);
  });

  it("only returns to paths on the app", async () => {
    for (const redirect of [
      "//evil.example",
      "https://evil.example/",
      "/\\evil.example",
      "evil",
    ]) {
      const response = await raw(
        "GET",
        `/collections/users/auth-with-oauth2/idp?redirect=${encodeURIComponent(redirect)}`,
      );
      expect(response.status).toBe(400);
    }
  });

  it("lets an account created through a provider set a password by resetting it", async () => {
    const created = await whoami(
      sessionOf(
        await signIn("idp", {
          sub: "u15",
          email: "ned@example.com",
          emailVerified: true,
        }),
      ),
    );
    const users = nextbase.client().collection("users");
    await users.requestPasswordReset("ned@example.com");
    await Promise.all(pending.splice(0));
    const message = sent.filter((m) => m.to === "ned@example.com").at(-1);
    const token = /token=([\w.-]+)/.exec(message?.text ?? "")?.[1] ?? "";
    await users.confirmPasswordReset(token, PASSWORD, PASSWORD);
    const { record } = await users.signInWithPassword(
      "ned@example.com",
      PASSWORD,
    );
    expect(record.id).toBe(created.id);
  });

  it("lets a deleted account's provider account sign up again", async () => {
    const first = await whoami(
      sessionOf(await signIn("idp", { sub: "u9", email: "jo@example.com" })),
    );
    await admin.collection("users").delete(first.id as string);
    const again = await whoami(
      sessionOf(await signIn("idp", { sub: "u9", email: "jo@example.com" })),
    );
    expect(again.id).not.toBe(first.id);
  });

  it("follows the create rule and the auth rule", async () => {
    await admin.collections.update("users", { createRule: null });
    expect(
      errorOf(await signIn("idp", { sub: "u10", email: "kim@example.com" })),
    ).toBe("sign_up_disabled");
    await admin.collections.update("users", {
      createRule: "",
      authRule: 'email != "lee@example.com"',
    });
    expect(
      errorOf(await signIn("idp", { sub: "u11", email: "lee@example.com" })),
    ).toBe("sign_in_forbidden");
    await admin.collections.update("users", { authRule: "" });
  });

  it("needs a provider that shares an email to sign up", async () => {
    expect(errorOf(await signIn("idp", { sub: "u12" }))).toBe("email_required");
  });

  it("creates no account from an email the provider did not verify", async () => {
    // Otherwise someone could claim your email at a provider that does not
    // check it, and hold the account before you sign up.
    const response = await signIn("idp", {
      sub: "u16",
      email: "pam@example.com",
      emailVerified: false,
    });
    expect(errorOf(response)).toBe("email_not_verified");
    expect(cookieOf(response, "nextbase_session")).toBeUndefined();
    expect(await findUser("pam@example.com")).toBeUndefined();
  });

  it("links no provider to an account whose email nobody verified", async () => {
    // Someone signed up with your email: they must not add a way in that
    // survives you resetting the password.
    const { record } = await passwordAccount("quin@example.com", false);
    const response = await signIn(
      "idp",
      { sub: "u17", email: "attacker@example.com" },
      { query: "?link=true", cookie: await cookieSignIn("quin@example.com") },
    );
    expect(errorOf(response)).toBe("email_not_verified");
    const path = `/collections/users/records/${record.id}/linked-accounts`;
    const { token } = await nextbase
      .client()
      .collection("users")
      .signInWithPassword("quin@example.com", PASSWORD);
    expect((await call(nextbase, "GET", path, { token })).body.items).toEqual(
      [],
    );
  });

  it("drops the providers linked before the owner first proved the email", async () => {
    const users = nextbase.client().collection("users");
    const tokenTo = async (email: string): Promise<string> => {
      await Promise.all(pending.splice(0));
      const message = sent.filter((m) => m.to === email).at(-1);
      return /token=([\w.-]+)/.exec(message?.text ?? "")?.[1] ?? "";
    };
    /**
     * An account someone set up under another's email, with their provider
     * linked, as linking allowed before it needed a verified email.
     */
    const preHijacked = async (email: string, sub: string) => {
      const { record } = await passwordAccount(email);
      const linked = await signIn(
        "idp",
        { sub },
        { query: "?link=true", cookie: await cookieSignIn(email) },
      );
      expect(errorOf(linked)).toBeNull();
      await admin.collection("users").update(record.id, {
        emailVerified: false,
      });
      return record.id;
    };
    const linkedTo = async (id: string): Promise<unknown[]> =>
      (
        await t.db
          .newQuery(
            "SELECT id FROM nextbase._linked_accounts WHERE record_id = {:id}",
          )
          .bind({ id })
          .all()
      ).map((row) => row.id);

    // The owner resets the password.
    const reset = await preHijacked("rae@example.com", "u18");
    await users.requestPasswordReset("rae@example.com");
    await users.confirmPasswordReset(
      await tokenTo("rae@example.com"),
      "the owner's password",
      "the owner's password",
    );
    expect(await linkedTo(reset)).toEqual([]);
    // The provider account no longer signs in to it, and cannot sign up
    // without an email.
    expect(errorOf(await signIn("idp", { sub: "u18" }))).toBe("email_required");

    // The owner verifies the email.
    const verified = await preHijacked("sol@example.com", "u19");
    await users.requestEmailVerification("sol@example.com");
    await users.confirmEmailVerification(await tokenTo("sol@example.com"));
    expect(await linkedTo(verified)).toEqual([]);

    // Once the email is proven, a reset keeps the owner's own providers.
    const { record } = await passwordAccount("tia@example.com");
    await signIn(
      "idp",
      { sub: "u20", email: "tia@example.com" },
      { query: "?link=true", cookie: await cookieSignIn("tia@example.com") },
    );
    await users.requestPasswordReset("tia@example.com");
    await users.confirmPasswordReset(
      await tokenTo("tia@example.com"),
      "tia's new password",
      "tia's new password",
    );
    expect(await linkedTo(record.id)).toHaveLength(1);
  });

  it("is not offered to superusers or for unknown providers", async () => {
    expect(
      (await raw("GET", "/collections/_superusers/auth-with-oauth2/idp"))
        .status,
    ).toBe(400);
    expect(
      (await raw("GET", "/collections/users/auth-with-oauth2/nope")).status,
    ).toBe(404);
  });

  it("needs the app URL to build redirects", () => {
    expect(
      () =>
        new NextBase({
          oauth2: { google: { clientId: "a", clientSecret: "b" } },
        }),
    ).toThrow(/appUrl/);
    expect(
      () =>
        new NextBase({
          appUrl: origin,
          oauth2: { custom: { clientId: "a", clientSecret: "b" } },
        }),
    ).toThrow(/issuer/);
  });
});
