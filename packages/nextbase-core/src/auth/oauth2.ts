import { createHash, timingSafeEqual } from 'node:crypto';
import type { AuthCollection, AuthProvider } from '@nextbasejs/client';
import type { Builder, DB } from '@nextbasejs/dbx';
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose';
import * as oauth from 'oauth4webapi';
import { table } from '../db/system.ts';
import { ApiError } from '../errors.ts';
import { unstorableText } from '../storable.ts';
import type { SecretKeys } from './secret-keys.ts';
import { isSecure, readCookie } from './sessions.ts';
import { spendToken } from './used-tokens.ts';

// OAuth2 / OpenID Connect sign-in (protocol details via oauth4webapi):
// 1. start() redirects to the provider with a PKCE challenge and a random
//    `state`, also kept in a short-lived cookie.
// 2. consumeState() matches the returned `state` to the cookie, so only the
//    browser that started a sign-in can finish it.
// 3. identify() exchanges the code with the PKCE verifier, checks the ID
//    token's nonce, and reads the account.
// Redirects are built from the configured app URL only.

export interface OAuth2ProviderOptions {
  /**
   * From the provider's OAuth app. Several, such as your web, iOS and
   * Android apps', accept ID tokens issued to any of them; the first is the
   * one the browser sign-in uses.
   */
  clientId: string | string[];
  clientSecret: string;
  /** OpenID Connect issuer URL to discover endpoints from; not needed for `google` and `github`. */
  issuer?: string;
  /** Shown on sign-in buttons; defaults to the provider's name. */
  displayName?: string;
  /** Scopes asked for besides those NextBase needs to know the account. */
  scopes?: string[];
  /** The provider's `prompt`, such as `select_account` or `consent`. */
  prompt?: string;
  /**
   * More parameters for the provider's authorization page, such as Google's
   * `hd` for one Workspace domain. Those NextBase sets itself are refused.
   */
  params?: Record<string, string>;
  /** Signs in accounts that exist, or link it, but creates none. */
  disableSignUp?: boolean;
  /**
   * Keeps each linked account's access and refresh tokens, encrypted with
   * `secretKey`, for `getAccessToken`. Needs `secretKey`.
   */
  storeTokens?: boolean;
  /**
   * The fields of an account this provider creates, from its profile: the
   * ID token's claims, or GitHub's user. `data` is what the app passed to the
   * sign-in, untrusted. Sign-in fields (email, password, phone, verification)
   * are never taken from it; the create rule and field checks still apply.
   */
  mapProfile?: (
    profile: Record<string, unknown>,
    context: { data: Record<string, unknown> | undefined },
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

/** Providers by name: `google`, `github`, or any OpenID Connect issuer. */
export type OAuth2Options = Record<string, OAuth2ProviderOptions>;

export interface Identity {
  /** The provider's permanent account id (OpenID Connect `sub`). */
  id: string;
  email: string | undefined;
  emailVerified: boolean;
  /** What the provider said about the account, for `mapProfile`. */
  profile: Record<string, unknown>;
  /** Set when the provider stores tokens. */
  tokens?: ProviderTokens;
}

/** A linked account's tokens, kept when the provider has `storeTokens`. */
export interface ProviderTokens {
  accessToken: string;
  refreshToken: string | undefined;
  /** Undefined when the provider did not say. */
  expiresAt: Date | undefined;
  scopes: string[];
}

/** An access token for a linked account, refreshed when it was due. */
export interface AccessTokenModel {
  accessToken: string;
  /** ISO 8601; null when the provider did not say. */
  expiresAt: string | null;
  scopes: string[];
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
  /** The hash of the `mfaId` this sign-in is the second step of, if any. */
  mfaIdHash: string | null;
  /** What the app passed to the sign-in, untrusted. */
  data: Record<string, unknown> | null;
  /** The scopes asked for; null for states from before they were kept. */
  scope: string | null;
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
  /** Every client id an ID token may be issued to. */
  audiences: string[];
  /** Parameters for the authorization page, `prompt` among them. */
  params: Record<string, string>;
  disableSignUp: boolean;
  storeTokens: boolean;
  mapProfile: OAuth2ProviderOptions['mapProfile'];
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
/** Bytes of JSON in `params` or `data`, which the state keeps. */
const MAX_EXTRA = 2048;

/**
 * Set by NextBase, or able to change how the provider answers: changing one
 * would break the sign-in or its checks. Compared without regard to case.
 */
const RESERVED_PARAMS = new Set([
  'client_id',
  'redirect_uri',
  'response_type',
  'response_mode',
  'scope',
  'state',
  'code_challenge',
  'code_challenge_method',
  'nonce',
  'request',
  'request_uri',
]);
const PARAM_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

const STATE_COOKIES = {
  secure: '__Host-nextbase_oauth2',
  plain: 'nextbase_oauth2',
} as const;

const signal = (): AbortSignal => AbortSignal.timeout(TIMEOUT_MS);

export class OAuth2 {
  readonly #providers = new Map<string, Provider>();
  /** Each provider's signing keys, fetched and cached by `jose`. */
  readonly #keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
  readonly #appUrl: URL | undefined;
  readonly #callbackBase: string | undefined;
  readonly #secretKeys: SecretKeys;

  constructor(
    options: OAuth2Options | undefined,
    appUrl: URL | undefined,
    basePath: string,
    secretKeys: SecretKeys,
  ) {
    for (const [name, provider] of Object.entries(options ?? {})) {
      this.#providers.set(name, newProvider(name, provider));
      if (provider.storeTokens && !secretKeys.configured) {
        throw new TypeError(
          `OAuth2 provider "${name}" stores tokens, which needs the secretKey option or NEXTBASE_SECRET_KEY.`,
        );
      }
    }
    this.#secretKeys = secretKeys;
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
    if (!provider) throw new ApiError(404, 'OAuth2 provider not found.');
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
      mfaIdHash,
      params = {},
      data = null,
      scopes = [],
    }: {
      collection: AuthCollection;
      provider: Provider;
      redirect: string;
      errorRedirect: string;
      linkRecordId: string | null;
      mfaIdHash: string | null;
      /** For the provider's authorization page, over the provider's own. */
      params?: Record<string, string>;
      data?: Record<string, unknown> | null;
      /** Asked for besides the provider's, such as more of its API. */
      scopes?: string[];
    },
  ): Promise<{ location: string; state: string }> {
    const server = await provider.server();
    const scope = [...new Set([...provider.scope.split(' '), ...scopes])].join(
      ' ',
    );
    const state = oauth.generateRandomState();
    const codeVerifier = oauth.generateRandomCodeVerifier();
    const nonce = oauth.generateRandomNonce();
    // Abandoned sign-ins are cleaned up here, where sign-ins start.
    await q
      .newQuery(
        `DELETE FROM {{${table('_oauth2_states')}}} WHERE expires <= now()`,
      )
      .execute();
    await q
      .newQuery(
        `INSERT INTO {{${table('_oauth2_states')}}}
           (id, collection_id, provider, code_verifier, nonce, redirect, error_redirect,
            link_record_id, mfa_id, data, scope, expires)
         VALUES ({:id}, {:collectionId}, {:provider}, {:codeVerifier}, {:nonce}, {:redirect},
                 {:errorRedirect}, {:linkRecordId}, {:mfaIdHash}, {:data}::jsonb, {:scope},
                 now() + make_interval(secs => ${STATE_MAX_AGE}))`,
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
        mfaIdHash,
        data: data === null ? null : JSON.stringify(data),
        scope,
      })
      .execute();
    const url = new URL(server.authorization_endpoint as string);
    for (const [key, value] of Object.entries({
      ...provider.params,
      ...params,
    })) {
      url.searchParams.set(key, value);
    }
    url.searchParams.set('client_id', provider.client.client_id);
    url.searchParams.set('redirect_uri', this.callbackUrl(provider));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', scope);
    url.searchParams.set('state', state);
    url.searchParams.set(
      'code_challenge',
      await oauth.calculatePKCECodeChallenge(codeVerifier),
    );
    url.searchParams.set('code_challenge_method', 'S256');
    if (provider.oidc) url.searchParams.set('nonce', nonce);
    return { location: url.href, state };
  }

  /**
   * Single-use. The returned `state` must match this browser's cookie, so
   * another site cannot sign the browser in to an account of its choosing.
   */
  async consumeState(q: Builder, request: Request): Promise<OAuth2State> {
    const returned = new URL(request.url).searchParams.get('state') ?? '';
    const expected = readCookie(request, stateCookieName(request)) ?? '';
    const lost = new OAuth2Error(
      'oauth2_failed',
      'The sign-in started in another browser or took too long. Try again.',
    );
    if (returned === '' || !sameText(returned, expected)) throw lost;
    const [state] = await q
      .newQuery(
        `DELETE FROM {{${table('_oauth2_states')}}}
         WHERE id = {:id} AND expires > now()
         RETURNING collection_id AS "collectionId", provider,
           code_verifier AS "codeVerifier", nonce, redirect,
           error_redirect AS "errorRedirect", link_record_id AS "linkRecordId",
           mfa_id AS "mfaIdHash", data, scope`,
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
    if (params.get('error') === 'access_denied') {
      throw new OAuth2Error('oauth2_denied', 'The sign-in was cancelled.');
    }
    const server = await provider.server();
    const callback = oauth.validateAuthResponse(
      server,
      provider.client,
      params,
      params.get('state') ?? '',
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
    const identity = await provider.identity(server, tokens);
    return provider.storeTokens
      ? { ...identity, tokens: tokensOf(tokens, state.scope ?? provider.scope) }
      : identity;
  }

  /**
   * Keeps a linked account's tokens, at a provider with `storeTokens`; a
   * refresh token left out keeps the last. At another provider, it clears
   * any it kept before `storeTokens` was turned off.
   */
  async saveTokens(
    q: Builder,
    collectionId: string,
    recordId: string,
    provider: Provider,
    tokens: ProviderTokens | undefined,
  ): Promise<void> {
    const where = `collection_id = {:collectionId} AND record_id = {:recordId}
       AND provider = {:provider}`;
    const keys = { collectionId, recordId, provider: provider.name };
    if (!tokens) {
      await q
        .newQuery(
          `UPDATE {{${table('_linked_accounts')}}}
           SET access_token = NULL, refresh_token = NULL, token_expires = NULL,
               scopes = NULL, tokens_saved = NULL, refreshing_until = NULL
           WHERE ${where} AND access_token IS NOT NULL`,
        )
        .bind(keys)
        .execute();
      return;
    }
    const aad = tokenAad(collectionId, recordId, provider.name);
    const seal = (text: string): string =>
      this.#secretKeys.encrypt(Buffer.from(text), aad);
    await q
      .newQuery(
        `UPDATE {{${table('_linked_accounts')}}}
         SET access_token = {:access},
             refresh_token = coalesce({:refresh}, refresh_token),
             token_expires = {:expires},
             scopes = {:scopes}::text[],
             tokens_saved = now(),
             refreshing_until = NULL
         WHERE ${where}`,
      )
      .bind({
        ...keys,
        access: seal(tokens.accessToken),
        refresh:
          tokens.refreshToken === undefined ? null : seal(tokens.refreshToken),
        expires: tokens.expiresAt ?? null,
        scopes: tokens.scopes,
      })
      .execute();
  }

  /**
   * The access token of a record's linked account, refreshed first when it
   * expires within a minute, or when `refresh` and it was not refreshed in
   * the last few seconds. One request claims the refresh for a while; the
   * others wait for its result. No connection or lock is held while the
   * provider answers.
   */
  async accessToken(
    db: DB,
    collection: AuthCollection,
    recordId: string,
    providerName: string,
    { refresh = false }: { refresh?: boolean } = {},
  ): Promise<AccessTokenModel> {
    const provider = this.provider(providerName);
    if (!provider.storeTokens) {
      throw new ApiError(
        400,
        `${provider.displayName} does not store tokens: set its storeTokens option.`,
      );
    }
    const keys = {
      collectionId: collection.id,
      recordId,
      provider: provider.name,
    };
    const where = `collection_id = {:collectionId} AND record_id = {:recordId}
       AND provider = {:provider}`;
    const aad = tokenAad(collection.id, recordId, provider.name);
    const signInAgain = (message: string): ApiError =>
      new ApiError(404, `${message}: sign in with the provider again.`);
    const read = async () => {
      const [row] = await db
        .newQuery(
          `SELECT access_token, refresh_token, token_expires, scopes,
             tokens_saved::text AS saved,
             tokens_saved > now() - make_interval(secs => ${FORCED_REFRESH_GAP}) AS fresh,
             token_expires < now() + make_interval(secs => ${REFRESH_AHEAD}) AS due,
             refreshing_until > now() AS claimed
           FROM {{${table('_linked_accounts')}}} WHERE ${where}`,
        )
        .bind(keys)
        .all<TokenRow>();
      if (!row) throw new ApiError(404, 'The provider is not linked.');
      if (row.access_token === null) {
        throw signInAgain('No token is stored for this provider yet');
      }
      return row;
    };
    const open = async (sealed: string): Promise<string> => {
      const plain = this.#secretKeys.decrypt(sealed, aad);
      if (plain) return plain.toString();
      // Sealed with a key no longer configured: useless, so let it go.
      await this.saveTokens(db, collection.id, recordId, provider, undefined);
      throw signInAgain("The stored token's key was removed");
    };
    const model = async (row: TokenRow): Promise<AccessTokenModel> => ({
      accessToken: await open(row.access_token as string),
      expiresAt: row.token_expires?.toISOString() ?? null,
      scopes: row.scopes ?? [],
    });

    let row = await read();
    const wanted = (r: TokenRow): boolean =>
      r.due === true || (refresh && r.fresh !== true);
    for (let waited = 0; wanted(row); waited += CLAIM_POLL_MS) {
      // One request refreshes; the rest wait for it, a few seconds at most.
      // Only while the tokens are still those this request read: once
      // another request saved new ones, there is nothing left to refresh.
      const [claimed] = await db
        .newQuery(
          `UPDATE {{${table('_linked_accounts')}}}
           SET refreshing_until = now() + make_interval(secs => ${CLAIM_SECONDS})
           WHERE ${where} AND access_token IS NOT NULL
             AND (refreshing_until IS NULL OR refreshing_until <= now())
             AND tokens_saved::text IS NOT DISTINCT FROM {:saved}
           RETURNING refresh_token`,
        )
        .bind({ ...keys, saved: row.saved })
        .all<{ refresh_token: string | null }>();
      if (claimed) {
        if (claimed.refresh_token === null) {
          await this.#release(db, where, keys);
          if (row.due !== true) return model(row);
          throw new ApiError(
            400,
            'The token expired, and the provider gave no refresh token: sign in with it again.',
          );
        }
        const fresh = await this.#refresh(
          db,
          provider,
          await open(claimed.refresh_token),
          (row.scopes ?? []).join(' '),
          { collectionId: collection.id, recordId, where, keys },
        );
        return {
          accessToken: fresh.accessToken,
          expiresAt: fresh.expiresAt?.toISOString() ?? null,
          scopes: fresh.scopes,
        };
      }
      if (waited >= CLAIM_SECONDS * 1000) {
        throw new ApiError(409, 'The token is being refreshed. Try again.');
      }
      await new Promise((resolve) => setTimeout(resolve, CLAIM_POLL_MS));
      row = await read();
      // Another request refreshed it meanwhile.
      if (row.fresh === true) return model(row);
    }
    return model(row);
  }

  /** Ends a claim on a refresh that did not happen. */
  async #release(
    db: DB,
    where: string,
    keys: Record<string, string>,
  ): Promise<void> {
    await db
      .newQuery(
        `UPDATE {{${table('_linked_accounts')}}} SET refreshing_until = NULL WHERE ${where}`,
      )
      .bind(keys)
      .execute();
  }

  /** Refreshes with the provider, holding no connection, then saves. */
  async #refresh(
    db: DB,
    provider: Provider,
    refreshToken: string,
    asked: string,
    {
      collectionId,
      recordId,
      where,
      keys,
    }: {
      collectionId: string;
      recordId: string;
      where: string;
      keys: Record<string, string>;
    },
  ): Promise<ProviderTokens> {
    let fresh: ProviderTokens;
    try {
      const server = await provider.server();
      const response = await oauth.refreshTokenGrantRequest(
        server,
        provider.client,
        provider.clientAuth,
        refreshToken,
        { signal },
      );
      fresh = tokensOf(
        await oauth.processRefreshTokenResponse(
          server,
          provider.client,
          response,
        ),
        asked,
      );
    } catch (error) {
      // A rotated refresh token the response carried replaces the spent
      // one, even when the rest of the response was refused.
      const rotated = rotatedRefreshToken(error);
      if (rotated !== undefined) {
        await db
          .newQuery(
            `UPDATE {{${table('_linked_accounts')}}} SET refresh_token = {:refresh} WHERE ${where}`,
          )
          .bind({
            ...keys,
            refresh: this.#secretKeys.encrypt(
              Buffer.from(rotated),
              tokenAad(collectionId, recordId, provider.name),
            ),
          })
          .execute();
      }
      await this.#release(db, where, keys);
      // Never the error itself: its cause can hold the response's tokens.
      console.error(
        `[nextbase] refreshing a ${provider.name} token failed: ${describeOAuthError(error)}`,
      );
      throw new ApiError(
        400,
        'The provider refused to refresh the token: sign in with it again.',
      );
    }
    await this.saveTokens(db, collectionId, recordId, provider, fresh);
    return fresh;
  }

  /**
   * The account of an ID token a native app got from the provider's own
   * SDK, such as Google's or Apple's: signed by the provider, issued to one
   * of its client ids, unexpired, and accepted once. With `nonce`, the token
   * must carry it, as is or as its SHA-256 hex, which Apple's SDK sends.
   */
  async verifyIdToken(
    q: Builder,
    provider: Provider,
    token: unknown,
    nonce: unknown,
  ): Promise<Identity> {
    const invalid = (message: string): never => {
      throw new ApiError(400, message, {
        token: { code: 'validation_invalid_token', message },
      });
    };
    if (!provider.oidc) {
      invalid(`${provider.displayName} has no ID tokens to sign in with.`);
    }
    if (typeof token !== 'string' || token === '' || token.length > 16_384) {
      return invalid('The ID token is missing.');
    }
    const server = await provider.server();
    if (typeof server.jwks_uri !== 'string') {
      return invalid(`${provider.displayName} publishes no signing keys.`);
    }
    let keys = this.#keys.get(provider.name);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(server.jwks_uri), {
        timeoutDuration: TIMEOUT_MS,
      });
      this.#keys.set(provider.name, keys);
    }
    let claims: JWTPayload;
    try {
      ({ payload: claims } = await jwtVerify(token, keys, {
        issuer: issuersOf(server.issuer),
        audience: provider.audiences,
        clockTolerance: 30,
        requiredClaims: ['sub', 'exp', 'iat'],
      }));
    } catch {
      return invalid('The ID token is invalid or has expired.');
    }
    if (nonce !== undefined) {
      const hashed =
        typeof nonce === 'string' &&
        createHash('sha256').update(nonce).digest('hex');
      if (
        typeof nonce !== 'string' ||
        (claims.nonce !== nonce && claims.nonce !== hashed)
      ) {
        invalid('The ID token was issued for another sign-in.');
      }
    }
    // Once: a token seen elsewhere, such as in a log, cannot sign in again.
    // Keyed by what the signature covers: the signature's own last
    // character has spare bits, so other spellings of it verify too.
    const signed = token.split('.').slice(0, 2).join('.');
    const id = `id-token:${server.issuer}:${claims.jti ?? stateHash(signed)}`;
    if (!(await spendToken(q, id, claims.exp))) {
      invalid('The ID token was already used.');
    }
    return {
      id: claims.sub as string,
      email: typeof claims.email === 'string' ? claims.email : undefined,
      // Apple sends it as a string.
      emailVerified:
        claims.email_verified === true || claims.email_verified === 'true',
      profile: claims,
    };
  }

  returnUrl(
    redirect: string,
    error?: string,
    params: Record<string, string> = {},
  ): string {
    const base = this.#appUrl as URL;
    const url = redirect === '' ? new URL(base) : new URL(redirect, base);
    if (error !== undefined) url.searchParams.set('error', error);
    // Added to the app's own parameters, never in place of one.
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.append(key, value);
    }
    return url.href;
  }
}

/** App paths only, so a sign-in link cannot forward users to a look-alike site. */
export function checkRedirect(
  value: string | null,
  param = 'redirect',
): string {
  if (value === null || value === '') return '';
  // `//host` and `/\host` are protocol-relative URLs to another site.
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.startsWith('/\\') ||
    value.length > MAX_REDIRECT ||
    unstorableText(value) !== undefined
  ) {
    throw new ApiError(400, `${param} must be a path on the app.`, {
      [param]: {
        code: 'validation_invalid_redirect',
        message: 'Must be a path, such as /dashboard.',
      },
    });
  }
  return value;
}

/** SameSite=Lax: the provider returns via a cross-site top-level navigation, which Lax allows. */
export function setStateCookie(request: Request, state?: string): string {
  const secure = isSecure(request);
  return [
    `${stateCookieName(request)}=${state ?? ''}`,
    'Path=/',
    `Max-Age=${state === undefined ? 0 : STATE_MAX_AGE}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function stateCookieName(request: Request): string {
  return isSecure(request) ? STATE_COOKIES.secure : STATE_COOKIES.plain;
}

/** Seconds before it expires that a token is refreshed, so one handed out still works. */
const REFRESH_AHEAD = 60;
/** Seconds after a refresh in which `refresh` asks for no other. */
const FORCED_REFRESH_GAP = 10;
/** Seconds a refresh is claimed for: the provider's timeout, and some. */
const CLAIM_SECONDS = 15;
const CLAIM_POLL_MS = 200;

interface TokenRow {
  access_token: string | null;
  /** When the tokens were saved, as text, to compare exactly. */
  saved: string | null;
  refresh_token: string | null;
  token_expires: Date | null;
  scopes: string[] | null;
  fresh: boolean | null;
  due: boolean | null;
  claimed: boolean | null;
}

/** What is safe to log of an OAuth2 failure: never a response's body. */
function describeOAuthError(error: unknown): string {
  if (error instanceof oauth.ResponseBodyError) {
    return `${error.name} ${error.error}`;
  }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return `${error.name}${typeof code === 'string' ? ` ${code}` : ''}: ${error.message}`;
  }
  return 'unknown error';
}

/** A refresh token in the parsed body a failed response check carries. */
function rotatedRefreshToken(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const body =
    typeof cause === 'object' && cause !== null && 'body' in cause
      ? (cause as { body: unknown }).body
      : undefined;
  const token =
    typeof body === 'object' && body !== null
      ? (body as { refresh_token?: unknown }).refresh_token
      : undefined;
  return typeof token === 'string' && token !== '' ? token : undefined;
}

/** Binds a sealed token to its linked account. */
function tokenAad(
  collectionId: string,
  recordId: string,
  provider: string,
): string {
  return `${collectionId}:${recordId}:${provider}`;
}

/** The tokens of a token endpoint's answer; `asked` when it names no scopes. */
function tokensOf(
  response: oauth.TokenEndpointResponse,
  asked: string,
): ProviderTokens {
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt:
      typeof response.expires_in === 'number'
        ? new Date(Date.now() + response.expires_in * 1000)
        : undefined,
    // GitHub separates them with commas.
    scopes: (response.scope ?? asked).split(/[\s,]+/).filter(Boolean),
  };
}

/** Google's ID tokens name its issuer with or without the scheme. */
function issuersOf(issuer: string): string[] {
  return issuer === 'https://accounts.google.com'
    ? [issuer, 'accounts.google.com']
    : [issuer];
}

// States are stored hashed, so a database leak cannot finish a sign-in.
function stateHash(state: string): string {
  return createHash('sha256').update(state).digest('hex');
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
  const audiences =
    typeof options.clientId === 'string'
      ? [options.clientId]
      : options.clientId;
  if (
    !Array.isArray(audiences) ||
    audiences.length === 0 ||
    audiences.some((id) => typeof id !== 'string' || id === '') ||
    !options.clientSecret
  ) {
    throw new TypeError(
      `OAuth2 provider "${name}" needs a clientId and a clientSecret.`,
    );
  }
  const params = {
    ...checkParams(options.params ?? {}, `OAuth2 provider "${name}" params`),
    ...(options.prompt !== undefined && { prompt: options.prompt }),
  };
  const base = {
    name,
    client: { client_id: audiences[0] as string },
    audiences,
    clientAuth: oauth.ClientSecretPost(options.clientSecret),
    params,
    disableSignUp: options.disableSignUp === true,
    storeTokens: options.storeTokens === true,
    mapProfile: options.mapProfile,
  };
  const withScopes = <P extends { scope: string }>(provider: P): P => ({
    ...provider,
    scope: [
      ...new Set([...provider.scope.split(' '), ...(options.scopes ?? [])]),
    ].join(' '),
  });
  if (options.issuer === undefined && name === 'github') {
    return withScopes({
      ...base,
      displayName: options.displayName ?? 'GitHub',
      ...github(),
    });
  }
  const issuer =
    options.issuer ??
    (name === 'google' ? 'https://accounts.google.com' : undefined);
  if (issuer === undefined) {
    throw new TypeError(
      `OAuth2 provider "${name}" needs the issuer of its OpenID Connect provider.`,
    );
  }
  return withScopes({
    ...base,
    displayName: options.displayName ?? (name === 'google' ? 'Google' : name),
    ...openIdConnect(issuer, base.client),
  });
}

/**
 * Parameters for a provider's authorization page: strings, none of those
 * NextBase sets. Throws a TypeError naming `what`, for options, or an
 * ApiError on `field`, for a request's.
 */
export function checkParams(
  value: unknown,
  what: string,
  field?: string,
): Record<string, string> {
  const refuse = (message: string): never => {
    if (field === undefined) throw new TypeError(`${what} ${message}`);
    throw new ApiError(400, `${field} ${message}`, {
      [field]: { code: 'validation_invalid_value', message },
    });
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return refuse('must be an object of strings.');
  }
  for (const [key, text] of Object.entries(value)) {
    if (typeof text !== 'string') refuse('must be an object of strings.');
    if (!PARAM_NAME.test(key)) refuse(`cannot set ${JSON.stringify(key)}.`);
    if (RESERVED_PARAMS.has(key.toLowerCase())) refuse(`cannot set ${key}.`);
  }
  if (JSON.stringify(value).length > MAX_EXTRA) refuse('is too long.');
  return value as Record<string, string>;
}

/** RFC 6749's scope-token: printable ASCII but space, `"` and `\\`. */
const SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/;

/** Scopes a sign-in asks for besides its provider's: at most 20 of them. */
export function checkScopes(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 20 ||
    value.some((scope) => typeof scope !== 'string' || !SCOPE.test(scope))
  ) {
    throw new ApiError(400, 'scopes must be a list of OAuth2 scopes.', {
      scopes: {
        code: 'validation_invalid_value',
        message: 'At most 20 scopes, without spaces or quotes.',
      },
    });
  }
  return value as string[];
}

/** What an app passes through a sign-in to `mapProfile`: a small JSON object. */
export function checkData(value: unknown): Record<string, unknown> {
  const invalid = (message: string): never => {
    throw new ApiError(400, `data ${message}`, {
      data: { code: 'validation_invalid_value', message },
    });
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid('must be a JSON object.');
  }
  if (JSON.stringify(value).length > MAX_EXTRA) invalid('is too long.');
  if (unstorableText(JSON.stringify(value)) !== undefined) {
    invalid('cannot be stored.');
  }
  return value as Record<string, unknown>;
}

function openIdConnect(
  issuer: string,
  client: oauth.Client,
): Pick<Provider, 'scope' | 'oidc' | 'server' | 'identity'> {
  const url = new URL(issuer);
  let discovered: Promise<oauth.AuthorizationServer> | undefined;
  return {
    scope: 'openid email',
    oidc: true,
    server() {
      // Once per instance; a failed discovery is retried on the next sign-in.
      discovered ??= oauth
        .discoveryRequest(url, { algorithm: 'oidc', signal })
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
      if (typeof claims.email !== 'string' && server.userinfo_endpoint) {
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
        email: typeof claims.email === 'string' ? claims.email : undefined,
        emailVerified: claims.email_verified === true,
        profile: claims,
      };
    },
  };
}

// GitHub has no OpenID Connect: the account and primary email come from its REST API.
function github(): Pick<Provider, 'scope' | 'oidc' | 'server' | 'identity'> {
  const server: oauth.AuthorizationServer = {
    issuer: 'https://github.com/login/oauth',
    authorization_endpoint: 'https://github.com/login/oauth/authorize',
    token_endpoint: 'https://github.com/login/oauth/access_token',
  };
  const api = async <T>(path: string, token: string): Promise<T> => {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'nextbase',
        'x-github-api-version': '2022-11-28',
      },
      signal: signal(),
    });
    if (!response.ok) {
      throw new Error(`GitHub ${path} answered ${response.status}.`);
    }
    return (await response.json()) as T;
  };
  return {
    scope: 'read:user user:email',
    oidc: false,
    server: async () => server,
    async identity(_server, tokens) {
      const user = await api<{ id: number } & Record<string, unknown>>(
        '/user',
        tokens.access_token,
      );
      const emails = await api<
        { email: string; primary: boolean; verified: boolean }[]
      >('/user/emails', tokens.access_token);
      const primary = emails.find((e) => e.primary);
      return {
        id: String(user.id),
        email: primary?.email,
        emailVerified: primary?.verified === true,
        profile: user,
      };
    },
  };
}
