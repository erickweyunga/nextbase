import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Api } from "./client.ts";
import { type Account, type Provider, startProvider } from "./provider.ts";
import { type Server, startServer } from "./server.ts";
import { firstSuperuser } from "./setup.ts";

// OAuth2 sign-in through the built example app, as a browser does it: the
// cookies, redirects and pages Next.js serves, against an OpenID Connect
// provider over HTTPS.

const PASSWORD = "password 123 456";

let provider: Provider;
let server: Server;
let admin: Api;

/** A browser: keeps cookies and follows nothing on its own. */
class Browser {
  readonly #cookies = new Map<string, string>();

  /** Opens `url` as a top-level navigation from `from`, as a link click does. */
  async open(
    url: string,
    { from = "none" }: { from?: "none" | "same-origin" } = {},
  ): Promise<Response> {
    const target = new URL(url, server.origin);
    const response = await fetch(target, {
      redirect: "manual",
      headers: {
        "sec-fetch-site": from,
        "sec-fetch-mode": "navigate",
        ...(this.#cookies.size > 0 && { cookie: this.cookieHeader() }),
      },
    });
    this.store(response);
    return response;
  }

  /** A same-origin fetch from one of the app's pages. */
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(new URL(path, server.origin), {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        origin: server.origin,
        "sec-fetch-site": "same-origin",
        cookie: this.cookieHeader(),
      },
    });
    this.store(response);
    return response;
  }

  /** Follows one redirect's Location header. */
  location(response: Response): string {
    expect([302, 303, 307]).toContain(response.status);
    return new URL(response.headers.get("location") ?? "", server.origin).href;
  }

  has(name: string): boolean {
    return this.#cookies.has(name);
  }

  cookieHeader(): string {
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  store(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = header.split(";");
      const [name = "", ...value] = pair.trim().split("=");
      const removed =
        value.join("=") === "" ||
        attributes.some((a) => a.trim().toLowerCase() === "max-age=0");
      if (removed) this.#cookies.delete(name);
      else this.#cookies.set(name, value.join("="));
    }
  }
}

/**
 * Clicks a provider link on a page, approves `account` at the provider and
 * returns the app's answer to the provider's redirect back.
 */
async function signInThroughProvider(
  browser: Browser,
  link: string,
  account: Account,
  { from = "same-origin" }: { from?: "none" | "same-origin" } = {},
): Promise<Response> {
  const start = await browser.open(link, { from });
  const authorize = browser.location(start);
  expect(authorize.startsWith(`${provider.issuer}/authorize`)).toBe(true);
  expect(browser.has("__Host-nextbase_oauth2")).toBe(true);
  // The provider's redirect is a navigation from another site.
  return browser.open(provider.approve(authorize, account), { from: "none" });
}

/** The href of the link whose text is `text` on an HTML page. */
function linkTo(html: string, text: string): string {
  const match = new RegExp(`<a href="([^"]+)"[^>]*>${text}</a>`).exec(
    html.replaceAll("<!-- -->", ""),
  );
  expect(match, `a link "${text}" in:\n${html}`).not.toBeNull();
  return (match?.[1] ?? "").replaceAll("&amp;", "&");
}

async function page(browser: Browser, path: string): Promise<string> {
  const response = await browser.open(path, { from: "same-origin" });
  expect(response.status).toBe(200);
  return (await response.text()).replaceAll("<!-- -->", "");
}

beforeAll(async () => {
  provider = await startProvider();
  server = await startServer({
    env: (origin) => ({
      APP_URL: origin,
      OIDC_ISSUER: provider.issuer,
      OIDC_CLIENT_ID: provider.clientId,
      OIDC_CLIENT_SECRET: provider.clientSecret,
      OIDC_NAME: "Test IdP",
      // The server trusts the provider's self-signed certificate.
      NODE_EXTRA_CA_CERTS: provider.certificate,
    }),
  });
  admin = await firstSuperuser(server);
  const users = await admin.send("POST", "/collections", {
    name: "users",
    type: "auth",
    createRule: "",
    viewRule: "id = @request.auth.id",
  });
  expect(users.status).toBe(200);
});

afterAll(async () => {
  await server?.stop();
  await provider?.stop();
});

describe("OAuth2 in the example app", () => {
  it("signs up, lands on the protected page and stays signed in", async () => {
    const browser = new Browser();
    // proxy.ts sends a signed-out visitor to the sign-in page.
    const guarded = await browser.open("/dashboard");
    expect(browser.location(guarded)).toBe(
      `${server.origin}/sign-in?next=%2Fdashboard`,
    );
    const signInPage = await page(browser, "/sign-in?next=%2Fdashboard");
    const link = linkTo(signInPage, "Continue with Test IdP");

    const callback = await signInThroughProvider(browser, link, {
      sub: "ada",
      email: "ada@example.com",
      emailVerified: true,
    });
    expect(browser.location(callback)).toBe(`${server.origin}/dashboard`);
    // Both cookies came through Next.js: the session set, the state removed.
    expect(browser.has("__Host-nextbase_session")).toBe(true);
    expect(browser.has("__Host-nextbase_oauth2")).toBe(false);
    const session = callback.headers
      .getSetCookie()
      .find((c) => c.startsWith("__Host-nextbase_session="));
    expect(session).toMatch(/; Path=\/; .*HttpOnly; SameSite=Lax; Secure/);

    const dashboard = await page(browser, "/dashboard");
    expect(dashboard).toContain("Welcome, ada@example.com.");
    expect(dashboard).toMatch(/<li>Test IdP <button[^>]*>Unlink<\/button>/);

    // Signing in again finds the same account.
    const again = new Browser();
    await signInThroughProvider(again, link, {
      sub: "ada",
      email: "ada@example.com",
      emailVerified: true,
    });
    expect(await page(again, "/dashboard")).toContain(
      "Welcome, ada@example.com.",
    );
  });

  it("shows why a sign-in failed on the sign-in page, not the protected one", async () => {
    await admin.send("POST", "/collections/users/records", {
      email: "bob@example.com",
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    const browser = new Browser();
    const link = linkTo(
      await page(browser, "/sign-in?next=%2Fdashboard"),
      "Continue with Test IdP",
    );
    // NextBase never verified bob's email, so the provider cannot claim it.
    const callback = await signInThroughProvider(browser, link, {
      sub: "not-bob",
      email: "bob@example.com",
      emailVerified: true,
    });
    const back = browser.location(callback);
    expect(back).toBe(
      `${server.origin}/sign-in?next=%2Fdashboard&error=account_exists`,
    );
    expect(browser.has("__Host-nextbase_session")).toBe(false);
    expect(await page(browser, back)).toContain(
      "An account with this email already exists.",
    );
  });

  it("refuses a callback that did not start in this browser", async () => {
    const victim = new Browser();
    const attacker = new Browser();
    const link = linkTo(
      await page(attacker, "/sign-in"),
      "Continue with Test IdP",
    );
    const start = await attacker.open(link, { from: "same-origin" });
    // The attacker approves their own account, then sends the victim the
    // callback URL to sign them in to it.
    const callbackUrl = provider.approve(attacker.location(start), {
      sub: "mallory",
      email: "mallory@example.com",
      emailVerified: true,
    });
    const response = await victim.open(callbackUrl);
    expect(new URL(victim.location(response)).searchParams.get("error")).toBe(
      "oauth2_failed",
    );
    expect(victim.has("__Host-nextbase_session")).toBe(false);
  });

  it("links and unlinks the provider from the dashboard", async () => {
    await admin.send("POST", "/collections/users/records", {
      email: "cy@example.com",
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    const browser = new Browser();
    const login = await browser.fetch(
      "/api/nextbase/collections/users/auth-with-password",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          identity: "cy@example.com",
          password: PASSWORD,
          cookie: true,
        }),
      },
    );
    expect(login.status).toBe(200);

    const dashboard = await page(browser, "/dashboard");
    const callback = await signInThroughProvider(
      browser,
      linkTo(dashboard, "Connect Test IdP"),
      // Another email: linking does not depend on it.
      { sub: "cy-at-idp", email: "cy.work@example.com" },
    );
    expect(browser.location(callback)).toBe(`${server.origin}/dashboard`);
    const linked = await page(browser, "/dashboard");
    expect(linked).toContain("Welcome, cy@example.com.");
    expect(linked).toMatch(/<li>Test IdP <button[^>]*>Unlink<\/button>/);

    // The provider now signs in to cy's account.
    const elsewhere = new Browser();
    await signInThroughProvider(
      elsewhere,
      linkTo(await page(elsewhere, "/sign-in"), "Continue with Test IdP"),
      { sub: "cy-at-idp", email: "cy.work@example.com" },
    );
    expect(await page(elsewhere, "/dashboard")).toContain(
      "Welcome, cy@example.com.",
    );

    // What the Unlink button sends.
    const me = await (await browser.fetch("/api/nextbase/session")).json();
    const unlink = await browser.fetch(
      `/api/nextbase/collections/users/records/${me.record.id}/linked-accounts/oidc`,
      { method: "DELETE" },
    );
    expect(unlink.status).toBe(204);
    expect(await page(browser, "/dashboard")).toContain("Connect Test IdP");
  });

  it("does not let another site start a link", async () => {
    const browser = new Browser();
    await signInThroughProvider(
      browser,
      linkTo(await page(browser, "/sign-in"), "Continue with Test IdP"),
      { sub: "dee", email: "dee@example.com", emailVerified: true },
    );
    expect(browser.has("__Host-nextbase_session")).toBe(true);
    const link = new URL(
      "/api/nextbase/collections/users/auth-with-oauth2/oidc",
      server.origin,
    );
    link.searchParams.set("link", "true");
    const crossSite = await fetch(link, {
      redirect: "manual",
      headers: {
        cookie: browser.cookieHeader(),
        "sec-fetch-site": "cross-site",
      },
    });
    expect(crossSite.status).toBe(403);
  });
});
