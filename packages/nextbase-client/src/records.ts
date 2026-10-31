import { AuthStore } from './auth-store.ts';
import { authSync } from './auth-sync.ts';
import { ClientError } from './client-error.ts';
import { hasFiles, toFormData } from './files.ts';
import type { NextBaseClient, SendOptions } from './index.ts';
import {
  createPasskey,
  forgetPasskey,
  getPasskey,
  type PasskeyRequest,
} from './passkeys.ts';
import type { RealtimeEvent, SubscribeOptions } from './realtime.ts';
import type {
  AuthMethods,
  AuthResponse,
  ImpersonateResponse,
  LinkedAccountModel,
  ListResult,
  MfaStatus,
  PasskeyModel,
  RecordModel,
  RecoveryCodes,
  SignInMethod,
  TotpSetup,
} from './shared/api.ts';

export interface RecordOptions extends SendOptions {
  /** Relations to load, e.g. `author,comments_via_post.author`. */
  expand?: string;
  /** Output fields, e.g. `id,title,expand.author.name`. */
  fields?: string;
}

export interface AuthOptions extends RecordOptions {
  /** Keep the session in an HttpOnly cookie instead of returning a token. */
  cookie?: boolean;
}

/**
 * `mfaId` comes from {@link isMfaRequired}. Without it, the step after an OAuth2
 * sign-in uses the id kept in an HttpOnly cookie and ends with a cookie session.
 */
export interface SecondStepOptions extends AuthOptions {
  mfaId?: string;
}

/**
 * Proof for a change that adds or removes a way into the account: the password,
 * and with an authenticator app a code from it or a recovery code.
 */
export interface StepUpOptions extends SendOptions {
  password: string;
  mfaCode?: string;
}

/**
 * Proof for adding or removing a passkey: the password, unless the session signed
 * in within the last day, and with an authenticator app a code from it.
 */
export interface PasskeyStepUp extends SendOptions {
  password?: string;
  mfaCode?: string;
}

/** How to link an OAuth2 provider: the step-up and where to return to. */
export interface OAuth2LinkOptions extends Omit<OAuth2Options, 'mfaId'> {
  password: string;
  /** With an authenticator app, a code from it or a recovery code. */
  mfaCode?: string;
}

/** A sign-up that created the account, which has no second sign-in step to take yet. */
export interface SignUpPending {
  /** Verify the email, or phone, before signing in. */
  mfa: 'verify';
  token?: undefined;
  record?: undefined;
  methods?: undefined;
}

export interface ImpersonateOptions extends AuthOptions {
  /** Seconds, from 60 to 3600. Defaults to 3600. The session is never extended. */
  duration?: number;
}

export interface ListOptions extends RecordOptions {
  /** A filter expression; build one from user input with `filter()`. */
  filter?: string;
  /** Comma-separated fields, `-` for descending, e.g. `-created,title`. */
  sort?: string;
  /** Skip counting matches: faster, but `totalItems` and `totalPages` are -1. */
  skipTotal?: boolean;
}

export interface FullListOptions extends ListOptions {
  /** Records per request. Defaults to 1000, the server's maximum. */
  batch?: number;
}

export interface OAuth2Options {
  /** App path to return to afterwards, such as `/dashboard`. */
  redirect?: string;
  /** App path to return to with `?error=` on failure. Defaults to `redirect`. */
  errorRedirect?: string;
  /** Takes the second step of this sign-in, with a provider linked to the account. */
  mfaId?: string;
  /** Extra authorization page parameters, such as `{ login_hint: "ann@example.com" }`. */
  params?: Record<string, string>;
  /** Passed to the provider's `mapProfile` on the server; it cannot trust it. */
  data?: Record<string, unknown>;
  /** Scopes to ask for besides the provider's, such as more of its API. */
  scopes?: string[];
}

/** A linked account's access token at a provider that stores tokens. */
export interface AccessToken {
  accessToken: string;
  /** ISO 8601; null when the provider did not say. */
  expiresAt: string | null;
  scopes: string[];
}

const MAX_PER_PAGE = 1000;

/** Records of one collection. The auth methods work on auth collections only. */
export class RecordService<T extends RecordModel = RecordModel> {
  readonly #client: NextBaseClient;
  readonly #collection: string;

  constructor(client: NextBaseClient, idOrName: string) {
    this.#client = client;
    this.#collection = idOrName;
  }

  getList(
    page = 1,
    perPage = 30,
    options: ListOptions = {},
  ): Promise<ListResult<T>> {
    const { filter, sort, skipTotal, ...rest } = options;
    return this.#send('/records', {
      ...rest,
      query: { ...rest.query, page, perPage, filter, sort, skipTotal },
    });
  }

  /** Every matching record, fetched in batches. */
  async getFullList(options: FullListOptions = {}): Promise<T[]> {
    const { batch = MAX_PER_PAGE, ...rest } = options;
    if (!Number.isInteger(batch) || batch < 1 || batch > MAX_PER_PAGE) {
      throw new RangeError(
        `batch must be an integer from 1 to ${MAX_PER_PAGE}.`,
      );
    }
    const items: T[] = [];
    for (let page = 1; ; page++) {
      const result = await this.getList(page, batch, {
        ...rest,
        skipTotal: true,
      });
      items.push(...result.items);
      if (result.items.length < batch) return items;
    }
  }

  /** The first record matching `filter`. Throws a 404 {@link ClientError} if none. */
  async getFirstListItem(
    filter: string,
    options: ListOptions = {},
  ): Promise<T> {
    const result = await this.getList(1, 1, {
      ...options,
      filter,
      skipTotal: true,
    });
    const [item] = result.items;
    if (!item) {
      throw new ClientError({
        status: 404,
        message: 'No record matches the filter.',
        data: {},
      });
    }
    return item;
  }

  /**
   * Watches `"*"` (under the list rule and `filter`) or one record id (under the view
   * rule). The collection must be in the server's `realtime` option. Returns unsubscribe.
   */
  subscribe(
    topic: string,
    callback: (event: RealtimeEvent<T>) => void,
    options?: SubscribeOptions,
  ): () => void {
    return this.#client.realtime.subscribe(
      this.#collection,
      topic,
      callback,
      options,
    );
  }

  getOne(id: string, options?: RecordOptions): Promise<T> {
    return this.#send(`/records/${encodeURIComponent(id)}`, options);
  }

  /** Returns null when the caller may not view the new record. */
  async create(
    body: Record<string, unknown>,
    options?: RecordOptions,
  ): Promise<T | null> {
    const record = await this.#send<T | undefined>('/records', {
      ...options,
      method: 'POST',
      body: await this.#body(body, options),
    });
    return record ?? null;
  }

  /**
   * Returns null when the caller may no longer view it. Updating the signed-in
   * record refreshes it in the auth store.
   */
  async update(
    id: string,
    body: Record<string, unknown>,
    options?: RecordOptions,
  ): Promise<T | null> {
    const store = this.#client.authStore;
    const signedIn = store.record;
    const record = await this.#send<T | undefined>(
      `/records/${encodeURIComponent(id)}`,
      { ...options, method: 'PATCH', body: await this.#body(body, options) },
    );
    if (
      record &&
      signedIn?.id === id &&
      this.#matches(signedIn) &&
      store.record === signedIn
    ) {
      // `fields` may leave out what changed, so the record is read in full.
      const full = options?.fields
        ? await this.getOne(id).catch(() => undefined)
        : record;
      if (full && store.record === signedIn) {
        store.save(store.token, { ...signedIn, ...full });
      }
    }
    return record ?? null;
  }

  /**
   * Deleting the signed-in record signs out and needs `password` (unless signed in
   * within a day) plus `mfaCode` with an app. Otherwise see `requestAccountDeletion`.
   */
  async delete(
    id: string,
    options: SendOptions & { password?: string; mfaCode?: string } = {},
  ): Promise<void> {
    const { password, mfaCode, ...rest } = options;
    const body = stepUp({ password, mfaCode });
    await this.#send(`/records/${encodeURIComponent(id)}`, {
      ...rest,
      method: 'DELETE',
      ...(Object.keys(body).length > 0 && { body }),
    });
    // Checked once deleted: another account may have signed in meanwhile.
    const store = this.#client.authStore;
    if (store.record?.id === id && this.#matches(store.record)) store.clear();
  }

  /**
   * Creates an account and signs it in. Returns null when the authRule blocks sign-in
   * yet (e.g. unverified email), and `{ mfa: "verify" }` when a second step has none yet.
   */
  async signUp(
    body: Record<string, unknown>,
    options: AuthOptions = {},
  ): Promise<AuthResponse<T> | SignUpPending | null> {
    const { cookie, ...rest } = options;
    const apply = authSync(this.#client.authStore).intent();
    const response = await this.#send<
      AuthResponse<T> | SignUpPending | undefined
    >('/sign-up', {
      ...rest,
      method: 'POST',
      body: await this.#body(
        { ...body, ...(cookie && { cookie: true }) },
        rest,
      ),
    });
    if (response && 'mfa' in response) return response;
    if (response) apply(() => this.#save(response));
    return response ?? null;
  }

  /**
   * Saves the session in the auth store, or with `cookie: true` in an HttpOnly cookie
   * and no token. Of overlapping sign-ins and sign-outs, the one started last wins.
   */
  async signInWithPassword(
    identity: string,
    password: string,
    options: SecondStepOptions = {},
  ): Promise<AuthResponse<T>> {
    const { cookie, mfaId, ...rest } = options;
    return this.#signIn('/auth-with-password', rest, {
      identity,
      password,
      ...(mfaId !== undefined && { mfaId }),
      ...(cookie && { cookie: true }),
    });
  }

  /**
   * Emails a sign-in code and returns the id to sign in with. Never reveals whether an
   * account exists: an unknown email gets an id no code matches.
   */
  async requestOtp(email: string, options?: SendOptions): Promise<string> {
    const { otpId } = await this.#client.send<{ otpId: string }>(
      `/collections/${encodeURIComponent(this.#collection)}/request-otp`,
      { ...options, method: 'POST', body: { email } },
    );
    return otpId;
  }

  /** Signs in with the code `requestOtp` emailed. The email counts as verified. */
  async signInWithOtp(
    otpId: string,
    code: string,
    options: AuthOptions = {},
  ): Promise<AuthResponse<T>> {
    const { cookie, ...rest } = options;
    return this.#signIn('/auth-with-otp', rest, {
      otpId,
      code,
      ...(cookie && { cookie: true }),
    });
  }

  /**
   * Signs in with a passkey, in the browser. `autofill` waits for one picked from the
   * suggestions of an input with `autocomplete="username webauthn"`; abort it with `signal`.
   */
  async signInWithPasskey(
    options: SecondStepOptions & { autofill?: boolean } = {},
  ): Promise<AuthResponse<T>> {
    const { cookie, mfaId, autofill, signal, ...rest } = options;
    const passkey = await this.#client.send<{
      challengeId: string;
      options: PasskeyRequest;
    }>(`/collections/${encodeURIComponent(this.#collection)}/passkey-options`, {
      method: 'POST',
      body: mfaId === undefined ? {} : { mfaId },
      ...(signal && { signal }),
    });
    const credential = await getPasskey(passkey.options, {
      ...(autofill && { autofill }),
      ...(signal && { signal }),
    });
    try {
      return await this.#signIn(
        '/auth-with-passkey',
        { ...rest, ...(signal && { signal }) },
        {
          challengeId: passkey.challengeId,
          credential,
          ...(mfaId !== undefined && { mfaId }),
          ...(cookie && { cookie: true }),
        },
      );
    } catch (error) {
      const code = (error as ClientError).data?.credential?.code;
      if (code === 'passkey_not_found' && passkey.options.rpId) {
        forgetPasskey(passkey.options.rpId, credential.id);
      }
      throw error;
    }
  }

  /**
   * Creates a passkey on this device for the signed-in record, in the browser.
   * The owner is emailed; `name` labels it in {@link listPasskeys}.
   */
  async addPasskey(
    recordId: string,
    options: PasskeyStepUp & { name?: string } = {},
  ): Promise<PasskeyModel> {
    const { password, mfaCode, name, ...rest } = options;
    const passkey = await this.#client.send<{
      challengeId: string;
      options: unknown;
    }>(this.#mfaPath(recordId, '/passkeys/options'), {
      ...rest,
      method: 'POST',
      body: {
        ...(password !== undefined && { password }),
        ...(mfaCode !== undefined && { mfaCode }),
      },
    });
    const credential = await createPasskey(
      passkey.options,
      rest.signal ?? undefined,
    );
    return this.#client.send(this.#mfaPath(recordId, '/passkeys'), {
      ...rest,
      method: 'POST',
      body: {
        challengeId: passkey.challengeId,
        credential,
        ...(name !== undefined && { name }),
      },
    });
  }

  /** The signed-in record's passkeys. */
  listPasskeys(
    recordId: string,
    options?: SendOptions,
  ): Promise<PasskeyModel[]> {
    return this.#client.send(this.#mfaPath(recordId, '/passkeys'), options);
  }

  renamePasskey(
    recordId: string,
    passkeyId: string,
    name: string,
    options?: SendOptions,
  ): Promise<PasskeyModel> {
    return this.#client.send(
      this.#mfaPath(recordId, `/passkeys/${encodeURIComponent(passkeyId)}`),
      { ...options, method: 'PATCH', body: { name } },
    );
  }

  /** Removes a passkey of the signed-in record; the owner is emailed. */
  async deletePasskey(
    recordId: string,
    passkeyId: string,
    options: PasskeyStepUp = {},
  ): Promise<void> {
    const { password, mfaCode, ...rest } = options;
    await this.#client.send(
      this.#mfaPath(recordId, `/passkeys/${encodeURIComponent(passkeyId)}`),
      {
        ...rest,
        method: 'DELETE',
        body: {
          ...(password !== undefined && { password }),
          ...(mfaCode !== undefined && { mfaCode }),
        },
      },
    );
  }

  /**
   * Signs in with an ID token from a native SDK such as Sign in with Apple. `nonce` is
   * the one given to the SDK; a new account goes through `mapProfile` with `data`.
   */
  async signInWithIdToken(
    provider: string,
    token: string,
    options: SecondStepOptions & {
      nonce?: string;
      data?: Record<string, unknown>;
    } = {},
  ): Promise<AuthResponse<T>> {
    const { cookie, mfaId, nonce, data, ...rest } = options;
    return this.#signIn(
      `/auth-with-id-token/${encodeURIComponent(provider)}`,
      rest,
      {
        token,
        ...(nonce !== undefined && { nonce }),
        ...(data !== undefined && { data }),
        ...(mfaId !== undefined && { mfaId }),
        ...(cookie && { cookie: true }),
      },
    );
  }

  /** The second step of a sign-in, with a code from the account's authenticator app. */
  async signInWithTotp(
    code: string,
    options: SecondStepOptions = {},
  ): Promise<AuthResponse<T>> {
    return this.#secondStep('/auth-with-totp', code, options);
  }

  /** The second step of a sign-in, with a recovery code. Each works once. */
  async signInWithRecoveryCode(
    code: string,
    options: SecondStepOptions = {},
  ): Promise<AuthResponse<T>> {
    return this.#secondStep('/auth-with-recovery-code', code, options);
  }

  /** Emails a code for the second step of a sign-in to the account's verified email. */
  async requestEmailCode(
    options: SendOptions & { mfaId?: string } = {},
  ): Promise<void> {
    const { mfaId, ...rest } = options;
    await this.#post(
      '/request-email-code',
      mfaId === undefined ? {} : { mfaId },
      rest,
    );
  }

  /** The second step of a sign-in, with a code from {@link requestEmailCode}. */
  async signInWithEmailCode(
    code: string,
    options: SecondStepOptions = {},
  ): Promise<AuthResponse<T>> {
    return this.#secondStep('/auth-with-email-code', code, options);
  }

  /** Whether the signed-in record has an authenticator app, and its recovery codes left. */
  getMfa(recordId: string, options?: SendOptions): Promise<MfaStatus> {
    return this.#send(`/records/${encodeURIComponent(recordId)}/mfa`, options);
  }

  /**
   * Starts authenticator app setup: show `uri` as a QR code, then confirm with a code
   * from the app within 15 minutes. Needs the current password.
   */
  startTotp(
    recordId: string,
    password: string,
    options?: SendOptions,
  ): Promise<TotpSetup> {
    return this.#client.send(this.#mfaPath(recordId, '/totp'), {
      ...options,
      method: 'POST',
      body: { password },
    });
  }

  /**
   * As a superuser, removes a record's authenticator app, recovery codes and pending
   * sign-ins, for an owner who lost their app. The owner is emailed.
   */
  async clearMfa(recordId: string, options?: SendOptions): Promise<void> {
    await this.#client.send(this.#mfaPath(recordId, '/mfa'), {
      ...options,
      method: 'DELETE',
    });
  }

  /** The second steps a sign-in can take, after an OAuth2 sign-in kept its id in a cookie. */
  async getPendingMfa(
    options?: SendOptions,
  ): Promise<{ methods: SignInMethod[] }> {
    return this.#send('/mfa', options);
  }

  /**
   * Turns the authenticator app on and returns recovery codes, shown only once.
   * Other sessions are signed out.
   */
  async confirmTotp(
    recordId: string,
    code: string,
    options?: SendOptions,
  ): Promise<string[]> {
    const { recoveryCodes } = await this.#client.send<RecoveryCodes>(
      this.#mfaPath(recordId, '/totp/confirm'),
      { ...options, method: 'POST', body: { code } },
    );
    return recoveryCodes;
  }

  /** Turns the authenticator app off, with a code from it or a recovery code. */
  async removeTotp(
    recordId: string,
    mfaCode: string,
    options?: SendOptions,
  ): Promise<void> {
    await this.#client.send(this.#mfaPath(recordId, '/totp'), {
      ...options,
      method: 'DELETE',
      body: { mfaCode },
    });
  }

  /** Replaces the recovery codes, with a code from the app or a recovery code. */
  async regenerateRecoveryCodes(
    recordId: string,
    mfaCode: string,
    options?: SendOptions,
  ): Promise<string[]> {
    const { recoveryCodes } = await this.#client.send<RecoveryCodes>(
      this.#mfaPath(recordId, '/recovery-codes'),
      { ...options, method: 'POST', body: { mfaCode } },
    );
    return recoveryCodes;
  }

  /**
   * Extends the session to its full lifetime and reloads the record. The store
   * is left as it is if it changed meanwhile, as by a sign-out.
   */
  async refreshSession(options?: RecordOptions): Promise<AuthResponse<T>> {
    const unchanged = authSync(this.#client.authStore).snapshot();
    const response = await this.#send<AuthResponse<T>>('/auth-refresh', {
      ...options,
      method: 'POST',
    });
    if (unchanged()) this.#save(response);
    return response;
  }

  /**
   * As a superuser, acts as the record. By default returns a new in-memory client; with
   * `cookie: true` this browser's cookie session switches, and `signOut()` switches back.
   */
  async impersonate(
    id: string,
    options: ImpersonateOptions & { cookie: true },
  ): Promise<ImpersonateResponse<T>>;
  async impersonate(
    id: string,
    options?: ImpersonateOptions & { cookie?: false },
  ): Promise<ImpersonateResponse<T> & { client: NextBaseClient }>;
  /** `client` is set when `cookie` is not true. */
  async impersonate(
    id: string,
    options?: ImpersonateOptions,
  ): Promise<ImpersonateResponse<T> & { client?: NextBaseClient }>;
  async impersonate(
    id: string,
    options: ImpersonateOptions = {},
  ): Promise<ImpersonateResponse<T> & { client?: NextBaseClient }> {
    const { cookie, duration, ...rest } = options;
    const apply = cookie
      ? authSync(this.#client.authStore).intent()
      : undefined;
    const response = await this.#send<ImpersonateResponse<T>>(
      `/impersonate/${encodeURIComponent(id)}`,
      {
        ...rest,
        method: 'POST',
        body: {
          ...(duration !== undefined && { duration }),
          ...(cookie && { cookie: true }),
        },
      },
    );
    if (apply) {
      apply(() => this.#save(response));
      return response;
    }
    const store = new AuthStore({ storage: null });
    store.save(response.token ?? '', response.record);
    return { ...response, client: this.#client.withAuthStore(store) };
  }

  /**
   * A URL to open in the browser that signs in with an OAuth2 provider such as `google`,
   * returning to `redirect` with a session cookie, or with `?error=` on failure.
   */
  oauth2Url(provider: string, options: OAuth2Options = {}): string {
    return this.#client.buildUrl(
      `/collections/${encodeURIComponent(this.#collection)}/auth-with-oauth2/${encodeURIComponent(provider)}`,
      {
        redirect: options.redirect,
        errorRedirect: options.errorRedirect,
        mfaId: options.mfaId,
        params: options.params && JSON.stringify(options.params),
        data: options.data && JSON.stringify(options.data),
        scopes: options.scopes?.join(' '),
      },
    );
  }

  /**
   * Returns the provider's URL that links it to the signed-in account. Needs a cookie
   * session, which the provider's return checks.
   */
  async oauth2LinkUrl(
    provider: string,
    link: OAuth2LinkOptions,
    options?: SendOptions,
  ): Promise<string> {
    const { password, mfaCode, redirect, errorRedirect, params, data, scopes } =
      link;
    const { url } = await this.#client.send<{ url: string }>(
      `/collections/${encodeURIComponent(this.#collection)}/link-oauth2/${encodeURIComponent(provider)}`,
      {
        ...options,
        method: 'POST',
        body: {
          password,
          ...(mfaCode !== undefined && { mfaCode }),
          ...(redirect !== undefined && { redirect }),
          ...(errorRedirect !== undefined && { errorRedirect }),
          ...(params !== undefined && { params }),
          ...(data !== undefined && { data }),
          ...(scopes !== undefined && { scopes }),
        },
      },
    );
    return url;
  }

  /** Signs in with an OAuth2 provider by navigating to {@link oauth2Url}. Browser only. */
  signInWithOAuth2(provider: string, options: OAuth2Options = {}): void {
    if (typeof location === 'undefined') {
      throw new Error(
        'signInWithOAuth2 works in the browser; use oauth2Url elsewhere.',
      );
    }
    location.assign(this.oauth2Url(provider, options));
  }

  /** Links an OAuth2 provider to the signed-in account by navigating to it. Browser only. */
  async linkOAuth2(
    provider: string,
    link: OAuth2LinkOptions,
    options?: SendOptions,
  ): Promise<void> {
    if (typeof location === 'undefined') {
      throw new Error(
        'linkOAuth2 works in the browser; use oauth2LinkUrl elsewhere.',
      );
    }
    location.assign(await this.oauth2LinkUrl(provider, link, options));
  }

  /**
   * For a provider with `storeTokens`; refreshed first when about to expire or with
   * `refresh`. Only its own record, unless a superuser.
   */
  async getAccessToken(
    recordId: string,
    provider: string,
    options: SendOptions & { refresh?: boolean } = {},
  ): Promise<AccessToken> {
    const { refresh, ...rest } = options;
    return this.#send<AccessToken>(
      `/records/${encodeURIComponent(recordId)}/linked-accounts/${encodeURIComponent(provider)}/token`,
      {
        ...rest,
        query: { ...rest.query, refresh: refresh ? 'true' : undefined },
      },
    );
  }

  /** OAuth2 providers linked to a record. Only its own record, unless a superuser. */
  async listLinkedAccounts(
    recordId: string,
    options?: SendOptions,
  ): Promise<LinkedAccountModel[]> {
    return (
      await this.#send<{ items: LinkedAccountModel[] }>(
        `/records/${encodeURIComponent(recordId)}/linked-accounts`,
        options,
      )
    ).items;
  }

  /** Its owner needs the password; a superuser unlinking another record's does not. */
  async unlinkAccount(
    recordId: string,
    provider: string,
    options: SendOptions & Partial<StepUpOptions> = {},
  ): Promise<void> {
    const { password, mfaCode, ...rest } = options;
    await this.#send(
      `/records/${encodeURIComponent(recordId)}/linked-accounts/${encodeURIComponent(provider)}`,
      { ...rest, method: 'DELETE', body: stepUp({ password, mfaCode }) },
    );
  }

  /** The sign-in methods of this auth collection, for a login page. */
  listAuthMethods(options?: SendOptions): Promise<AuthMethods> {
    return this.#send('/auth-methods', options);
  }

  /** Emails a verification link if `email` is an unverified account. Never reveals which. */
  async requestEmailVerification(
    email: string,
    options?: SendOptions,
  ): Promise<void> {
    await this.#post('/request-email-verification', { email }, options);
  }

  /** Verifies an account with a verification link's token. */
  async confirmEmailVerification(
    token: string,
    options?: SendOptions,
  ): Promise<void> {
    await this.#post('/confirm-email-verification', { token }, options);
  }

  /** Emails a password reset link if `email` is an account. Never reveals which. */
  async requestPasswordReset(
    email: string,
    options?: SendOptions,
  ): Promise<void> {
    await this.#post('/request-password-reset', { email }, options);
  }

  /** Sets a new password with a reset link's token. Ends every session of the account. */
  async confirmPasswordReset(
    token: string,
    password: string,
    passwordConfirm: string,
    options?: SendOptions,
  ): Promise<void> {
    await this.#post(
      '/confirm-password-reset',
      { token, password, passwordConfirm },
      options,
    );
  }

  /**
   * With a verified email the current inbox approves the change first, then `newEmail`
   * gets its link; otherwise `newEmail` gets it at once.
   */
  async requestEmailChange(
    newEmail: string,
    options?: SendOptions,
  ): Promise<void> {
    await this.#post('/request-email-change', { newEmail }, options);
  }

  /** Approves an email change with the token of the link the current inbox got. */
  async approveEmailChange(
    token: string,
    options?: SendOptions,
  ): Promise<void> {
    await this.#post('/approve-email-change', { token }, options);
  }

  /**
   * Needs the current password, and with an authenticator app a code from it or a
   * recovery code. Ends every session.
   */
  async confirmEmailChange(
    token: string,
    password: string,
    options: SendOptions & { mfaCode?: string } = {},
  ): Promise<void> {
    const { mfaCode, ...rest } = options;
    await this.#post(
      '/confirm-email-change',
      { token, password, ...(mfaCode !== undefined && { mfaCode }) },
      rest,
    );
  }

  /**
   * Emails a deletion link, for an owner with neither a password nor a recent sign-in.
   * Needs a verified email.
   */
  async requestAccountDeletion(options?: SendOptions): Promise<void> {
    await this.#post('/request-account-deletion', {}, options);
  }

  /**
   * Needs a code from the authenticator app or a recovery code if it has one. This
   * client signs out when it was the signed-in account.
   */
  async confirmAccountDeletion(
    token: string,
    options: SendOptions & { mfaCode?: string } = {},
  ): Promise<void> {
    const { mfaCode, ...rest } = options;
    await this.#post(
      '/confirm-account-deletion',
      { token, ...(mfaCode !== undefined && { mfaCode }) },
      rest,
    );
    const store = this.#client.authStore;
    const { record } = store;
    if (record && record.id === tokenRecordId(token) && this.#matches(record)) {
      store.clear();
    }
  }

  /**
   * Texts a sign-in code to `phone`, such as `+255712345678`; a new phone signs up.
   * Never reveals whether an account exists.
   */
  async requestPhoneCode(phone: string, options?: SendOptions): Promise<void> {
    await this.#post('/request-phone-code', { phone }, options);
  }

  /** Texts a code for the second step of a sign-in to the account's verified phone. */
  async requestMfaPhoneCode(
    options: SendOptions & { mfaId?: string } = {},
  ): Promise<void> {
    const { mfaId, ...rest } = options;
    await this.#post(
      '/request-phone-code',
      mfaId === undefined ? {} : { mfaId },
      rest,
    );
  }

  /** The second step of a sign-in, with a code from {@link requestMfaPhoneCode}. */
  async signInWithMfaPhoneCode(
    code: string,
    options: SecondStepOptions = {},
  ): Promise<AuthResponse<T>> {
    return this.#secondStep('/auth-with-phone-code', code, options);
  }

  /** Texts a password reset code if `phone` is an account's verified phone. Never reveals which. */
  async requestPasswordResetByPhone(
    phone: string,
    options?: SendOptions,
  ): Promise<void> {
    await this.#post('/request-password-reset-by-phone', { phone }, options);
  }

  /** Signs in with a code from {@link requestPhoneCode}, creating the account for a new phone. */
  async signInWithPhoneCode(
    phone: string,
    code: string,
    options: AuthOptions = {},
  ): Promise<AuthResponse<T>> {
    const { cookie, ...rest } = options;
    return this.#signIn('/auth-with-phone-code', rest, {
      phone,
      code,
      ...(cookie && { cookie: true }),
    });
  }

  /** Sets a new password with a texted reset code. Ends every session of the account. */
  async confirmPasswordResetByPhone(
    phone: string,
    code: string,
    password: string,
    passwordConfirm: string,
    options?: SendOptions,
  ): Promise<void> {
    await this.#post(
      '/confirm-password-reset-by-phone',
      { phone, code, password, passwordConfirm },
      options,
    );
  }

  /**
   * Texts a code that verifies `phone` for the signed-in account. A new or
   * changed phone needs the password.
   */
  async requestPhoneVerification(
    phone: string,
    options: SendOptions & Partial<StepUpOptions> = {},
  ): Promise<void> {
    const { password, mfaCode, ...rest } = options;
    await this.#post(
      '/request-phone-verification',
      { phone, ...stepUp({ password, mfaCode }) },
      rest,
    );
  }

  /**
   * Verifies `phone` for the signed-in account. A new or changed phone needs
   * the password, and signs out other devices.
   */
  async confirmPhoneVerification(
    phone: string,
    code: string,
    options: SendOptions & Partial<StepUpOptions> = {},
  ): Promise<void> {
    const { password, mfaCode, ...rest } = options;
    await this.#post(
      '/confirm-phone-verification',
      { phone, code, ...stepUp({ password, mfaCode }) },
      rest,
    );
  }

  async #post(
    path: string,
    body: Record<string, unknown>,
    options: SendOptions = {},
  ): Promise<void> {
    await this.#client.send(
      `/collections/${encodeURIComponent(this.#collection)}${path}`,
      { ...options, method: 'POST', body },
    );
  }

  async #signIn(
    path: string,
    options: RecordOptions,
    body: Record<string, unknown>,
  ): Promise<AuthResponse<T>> {
    const apply = authSync(this.#client.authStore).intent();
    const response = await this.#send<AuthResponse<T>>(path, {
      ...options,
      method: 'POST',
      body,
    });
    apply(() => this.#save(response));
    return response;
  }

  #secondStep(
    path: string,
    code: string,
    options: SecondStepOptions,
  ): Promise<AuthResponse<T>> {
    const { cookie, mfaId, ...rest } = options;
    return this.#signIn(path, rest, {
      code,
      ...(mfaId !== undefined && { mfaId }),
      ...(cookie && { cookie: true }),
    });
  }

  #mfaPath(recordId: string, path: string): string {
    return `/collections/${encodeURIComponent(this.#collection)}/records/${encodeURIComponent(recordId)}${path}`;
  }

  #save(response: AuthResponse<T>): void {
    this.#client.authStore.save(response.token ?? '', response.record);
  }

  #matches(record: RecordModel): boolean {
    return (
      record.collectionId === this.#collection ||
      record.collectionName === this.#collection
    );
  }

  #body(
    body: Record<string, unknown>,
    options: SendOptions = {},
  ): Promise<Record<string, unknown> | FormData> | Record<string, unknown> {
    return hasFiles(body)
      ? toFormData(this.#client, this.#collection, body, options)
      : body;
  }

  #send<R>(path: string, options: RecordOptions = {}): Promise<R> {
    const { expand, fields, ...rest } = options;
    return this.#client.send(
      `/collections/${encodeURIComponent(this.#collection)}${path}`,
      { ...rest, query: { ...rest.query, expand, fields } },
    );
  }
}

/** The record a link's token was made for: its JWT payload's `id`. */
function tokenRecordId(token: string): string | undefined {
  try {
    const payload = token.split('.')[1] ?? '';
    const claims: unknown = JSON.parse(
      atob(payload.replace(/-/g, '+').replace(/_/g, '/')),
    );
    return typeof claims === 'object' &&
      claims !== null &&
      'id' in claims &&
      typeof claims.id === 'string'
      ? claims.id
      : undefined;
  } catch {
    // Not a JWT: the server already refused it.
    return undefined;
  }
}

function stepUp({
  password,
  mfaCode,
}: {
  password: string | undefined;
  mfaCode: string | undefined;
}): Record<string, string> {
  return {
    ...(password !== undefined && { password }),
    ...(mfaCode !== undefined && { mfaCode }),
  };
}
