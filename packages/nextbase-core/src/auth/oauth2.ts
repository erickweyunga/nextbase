import { createHash, timingSafeEqual } from "node:crypto";
import type { AuthCollection, AuthProvider } from "@nextbasejs/client";
import type { Builder } from "@nextbasejs/dbx";
import * as oauth from "oauth4webapi";
import { table } from "../db/system.ts";
import { ApiError } from "../errors.ts";
import { hasNul } from "../storable.ts";
import { isSecure, readCookie } from "./sessions.ts";

// OAuth2 / OpenID Connect sign-in (protocol details via oauth4webapi):
// 1. start() redirects to the provider with a PKCE challenge and a random
//    `state`, also kept in a short-lived cookie.
// 2. consumeState() matches the returned `state` to the cookie, so only the
//    browser that started a sign-in can finish it.
// 3. identify() exchanges the code with the PKCE verifier, checks the ID
//    token's nonce, and reads the account.
// Redirects are built from the configured app URL only.

export interface OAuth2ProviderOptions {
  clientId: string;
  clientSecret: string;
  /** OpenID Connect issuer URL to discover endpoints from; not needed for `google` and `github`. */
  issuer?: string;
  /** Shown on sign-in buttons; defaults to the provider's name. */
  displayName?: string;
}

/** Providers by name: `google`, `github`, or any OpenID Connect issuer. */
export type OAuth2Options = Record<string, OAuth2ProviderOptions>;

export interface Identity {
  /** The provider's permanent account id (OpenID Connect `sub`). */
  id: string;
  email: string | undefined;
  emailVerified: boolean;
}

export interface OAuth2State {
  collectionId: string;
  provider: string;
  codeVerifier: string;
  nonce: string;
  /** App path to return to; "" for the app URL itself. */
  redirect: string;
  errorRedirect: string;
  /** Set when a signed-in record is linking a provider instead of signing in. */
  linkRecordId: string | null;
}

/** Sent back to the app as `?error=code`, not JSON, since the browser is navigating. */
export class OAuth2Error extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface Provider extends AuthProvider {
  scope: string;
  /** Identity comes from a nonce-checked ID token. */
  oidc: boolean;
  client: oauth.Client;
  clientAuth: oauth.ClientAuth;
  server(): Promise<oauth.AuthorizationServer>;
  identity(
    server: oauth.AuthorizationServer,
    tokens: oauth.TokenEndpointResponse,
  ): Promise<Identity>;
}

const TIMEOUT_MS = 10_000;
/** Seconds a sign-in may take at the provider before it must start over. */
const STATE_MAX_AGE = 600;
const MAX_REDIRECT = 2048;

const STATE_COOKIES = {
  secure: "__Host-nextbase_oauth2",
  plain: "nextbase_oauth2",
} as const;

const signal = (): AbortSignal => AbortSignal.timeout(TIMEOUT_MS);

export class OAuth2 {
  readonly #providers = new Map<string, Provider>();
  readonly #appUrl: URL | undefined;
  readonly #callbackBase: string | undefined;

  constructor(
    options: OAuth2Options | undefined,
    appUrl: URL | undefined,
    basePath: string,
  ) {
    for (const [name, provider] of Object.entries(options ?? {})) {
      this.#providers.set(name, newProvider(name, provider));
    }
    if (this.#providers.size > 0 && !appUrl) {
      throw new TypeError(
        "OAuth2 needs your app's URL to build its callback URL: pass the appUrl option.",
      );
    }
    this.#appUrl = appUrl;
    // On the app URL's origin, never the request's Host, which an attacker can set.
    this.#callbackBase =
      appUrl && new URL(`${basePath}/callback/`, appUrl.origin).href;
  }

  /** One per provider, so a callback can refuse a response meant for another provider. */
  callbackUrl(provider: Provider): string {
    return `${this.#callbackBase as string}${provider.name}`;
  }

  list(): AuthProvider[] {
    return [...this.#providers.values()].map(({ name, displayName }) => ({
      name,
      displayName,
    }));
  }

  /** Falls back to `name` for a provider no longer configured. */
  displayName(name: string): string {
    return this.#providers.get(name)?.displayName ?? name;
  }

  provider(name: string): Provider {
    const provider = this.#providers.get(name);
    if (!provider) throw new ApiError(404, "OAuth2 provider not found.");
    return provider;
  }

  /** The caller must set the returned state as a cookie. */
  async start(
    q: Builder,
    {
      collection,
      provider,
      redirect,
      errorRedirect,
      linkRecordId,
    }: {
      collection: AuthCollection;
      provider: Provider;
      redirect: string;
      errorRedirect: string;
      linkRecordId: string | null;
    },
  ): Promise<{ location: string; state: string }> {
    const server = await provider.server();
    const state = oauth.generateRandomState();
    const codeVerifier = oauth.generateRandomCodeVerifier();
    const nonce = oauth.generateRandomNonce();
    // Abandoned sign-ins are cleaned up here, where sign-ins start.
    await q
      .newQuery(
        `DELETE FROM {{${table("_oauth2_states")}}} WHERE expires <= now()`,
      )
      .execute();
    await q
      .newQuery(
        `INSERT INTO {{${table("_oauth2_states")}}}
           (id, collection_id, provider, code_verifier, nonce, redirect, error_redirect,
            link_record_id, expires)
         VALUES ({:id}, {:collectionId}, {:provider}, {:codeVerifier}, {:nonce}, {:redirect},
                 {:errorRedirect}, {:linkRecordId}, now() + make_interval(secs => ${STATE_MAX_AGE}))`,
      )
      .bind({
        id: stateHash(state),
        collectionId: collection.id,
        provider: provider.name,
        codeVerifier,
        nonce,
        redirect,
        errorRedirect,
        linkRecordId,
      })
      .execute();
    const url = new URL(server.authorization_endpoint as string);
    url.searchParams.set("client_id", provider.client.client_id);
    url.searchParams.set("redirect_uri", this.callbackUrl(provider));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", provider.scope);
    url.searchParams.set("state", state);
    url.searchParams.set(
      "code_challenge",
      await oauth.calculatePKCECodeChallenge(codeVerifier),
    );
    url.searchParams.set("code_challenge_method", "S256");
    if (provider.oidc) url.searchParams.set("nonce", nonce);
    return { location: url.href, state };
  }

  /**
   * Single-use. The returned `state` must match this browser's cookie, so
   * another site cannot sign the browser in to an account of its choosing.
   */
  async consumeState(q: Builder, request: Request): Promise<OAuth2State> {
    const returned = new URL(request.url).searchParams.get("state") ?? "";
    const expected = readCookie(request, stateCookieName(request)) ?? "";
    const lost = new OAuth2Error(
      "oauth2_failed",
      "The sign-in started in another browser or took too long. Try again.",
    );
    if (returned === "" || !sameText(returned, expected)) throw lost;
    const [state] = await q
      .newQuery(
        `DELETE FROM {{${table("_oauth2_states")}}}
         WHERE id = {:id} AND expires > now()
         RETURNING collection_id AS "collectionId", provider,
           code_verifier AS "codeVerifier", nonce, redirect,
           error_redirect AS "errorRedirect", link_record_id AS "linkRecordId"`,
      )
      .bind({ id: stateHash(returned) })
      .all<OAuth2State>();
    if (!state) throw lost;
    return state;
  }

  async identify(
    provider: Provider,
    state: OAuth2State,
    request: Request,
  ): Promise<Identity> {
    const params = new URL(request.url).searchParams;
    if (params.get("error") === "access_denied") {
      throw new OAuth2Error("oauth2_denied", "The sign-in was cancelled.");
    }
    const server = await provider.server();
    const callback = oauth.validateAuthResponse(
      server,
      provider.client,
      params,
      params.get("state") ?? "",
    );
    const response = await oauth.authorizationCodeGrantRequest(
      server,
      provider.client,
      provider.clientAuth,
      callback,
      this.callbackUrl(provider),
      state.codeVerifier,
      { signal },
    );
    const tokens = await oauth.processAuthorizationCodeResponse(
      server,
      provider.client,
      response,
      provider.oidc ? { expectedNonce: state.nonce, requireIdToken: true } : {},
    );
    return provider.identity(server, tokens);
  }

  returnUrl(redirect: string, error?: string): string {
    const base = this.#appUrl as URL;
    const url = redirect === "" ? new URL(base) : new URL(redirect, base);
    if (error !== undefined) url.searchParams.set("error", error);
    return url.href;
  }
}

/** App paths only, so a sign-in link cannot forward users to a look-alike site. */
export function checkRedirect(
  value: string | null,
  param = "redirect",
): string {
  if (value === null || value === "") return "";
  // `//host` and `/\host` are protocol-relative URLs to another site.
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.startsWith("/\\") ||
    value.length > MAX_REDIRECT ||
    hasNul(value)
  ) {
    throw new ApiError(400, `${param} must be a path on the app.`, {
      [param]: {
        code: "validation_invalid_redirect",
        message: "Must be a path, such as /dashboard.",
      },
    });
  }
  return value;
}

/** SameSite=Lax: the provider returns via a cross-site top-level navigation, which Lax allows. */
export function setStateCookie(request: Request, state?: string): string {
  const secure = isSecure(request);
  return [
    `${stateCookieName(request)}=${state ?? ""}`,
    "Path=/",
    `Max-Age=${state === undefined ? 0 : STATE_MAX_AGE}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function stateCookieName(request: Request): string {
  return isSecure(request) ? STATE_COOKIES.secure : STATE_COOKIES.plain;
}

// States are stored hashed, so a database leak cannot finish a sign-in.
function stateHash(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function newProvider(name: string, options: OAuth2ProviderOptions): Provider {
  if (!NAME.test(name)) {
    throw new TypeError(
      `OAuth2 provider name "${name}" must be 1 to 32 lowercase letters, digits, "-" or "_".`,
    );
  }
  if (!options.clientId || !options.clientSecret) {
    throw new TypeError(
      `OAuth2 provider "${name}" needs a clientId and a clientSecret.`,
    );
  }
  const base = {
    name,
    client: { client_id: options.clientId },
    clientAuth: oauth.ClientSecretPost(options.clientSecret),
  };
  if (options.issuer === undefined && name === "github") {
    return {
      ...base,
      displayName: options.displayName ?? "GitHub",
      ...github(),
    };
  }
  const issuer =
    options.issuer ??
    (name === "google" ? "https://accounts.google.com" : undefined);
  if (issuer === undefined) {
    throw new TypeError(
      `OAuth2 provider "${name}" needs the issuer of its OpenID Connect provider.`,
    );
  }
  return {
    ...base,
    displayName: options.displayName ?? (name === "google" ? "Google" : name),
    ...openIdConnect(issuer, base.client),
  };
}

function openIdConnect(
  issuer: string,
  client: oauth.Client,
): Pick<Provider, "scope" | "oidc" | "server" | "identity"> {
  const url = new URL(issuer);
  let discovered: Promise<oauth.AuthorizationServer> | undefined;
  return {
    scope: "openid email",
    oidc: true,
    server() {
      // Once per instance; a failed discovery is retried on the next sign-in.
      discovered ??= oauth
        .discoveryRequest(url, { algorithm: "oidc", signal })
        .then((response) => oauth.processDiscoveryResponse(url, response))
        .catch((error: unknown) => {
          discovered = undefined;
          throw error;
        });
      return discovered;
    },
    async identity(server, tokens) {
      let claims: Record<string, unknown> = {
        ...(oauth.getValidatedIdTokenClaims(tokens) as oauth.IDToken),
      };
      const sub = claims.sub as string;
      // Providers may leave the email out of the ID token and in UserInfo.
      if (typeof claims.email !== "string" && server.userinfo_endpoint) {
        const response = await oauth.userInfoRequest(
          server,
          client,
          tokens.access_token,
          { signal },
        );
        claims = {
          ...(await oauth.processUserInfoResponse(
            server,
            client,
            sub,
            response,
          )),
        };
      }
      return {
        id: sub,
        email: typeof claims.email === "string" ? claims.email : undefined,
        emailVerified: claims.email_verified === true,
      };
    },
  };
}

// GitHub has no OpenID Connect: the account and primary email come from its REST API.
function github(): Pick<Provider, "scope" | "oidc" | "server" | "identity"> {
  const server: oauth.AuthorizationServer = {
    issuer: "https://github.com/login/oauth",
    authorization_endpoint: "https://github.com/login/oauth/authorize",
    token_endpoint: "https://github.com/login/oauth/access_token",
  };
  const api = async <T>(path: string, token: string): Promise<T> => {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "nextbase",
        "x-github-api-version": "2022-11-28",
      },
      signal: signal(),
    });
    if (!response.ok) {
      throw new Error(`GitHub ${path} answered ${response.status}.`);
    }
    return (await response.json()) as T;
  };
  return {
    scope: "read:user user:email",
    oidc: false,
    server: async () => server,
    async identity(_server, tokens) {
      const user = await api<{ id: number }>("/user", tokens.access_token);
      const emails = await api<
        { email: string; primary: boolean; verified: boolean }[]
      >("/user/emails", tokens.access_token);
      const primary = emails.find((e) => e.primary);
      return {
        id: String(user.id),
        email: primary?.email,
        emailVerified: primary?.verified === true,
      };
    },
  };
}
