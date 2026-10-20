import { ClientError } from "./client-error.ts";
import type { NextBaseClient, SendOptions } from "./index.ts";
import type {
  AuthMethods,
  AuthResponse,
  LinkedAccountModel,
  ListResult,
  RecordModel,
} from "./shared/api.ts";

export interface RecordOptions extends SendOptions {
  /** Relations to load, e.g. `author,comments_via_post.author`. */
  expand?: string;
  /** Output fields, e.g. `id,title,expand.author.name`. */
  fields?: string;
}

export interface AuthOptions extends RecordOptions {
  /** Keep the session in an HttpOnly cookie rather than returning its token. */
  cookie?: boolean;
}

export interface ListOptions extends RecordOptions {
  /** A filter expression; build one from user input with `filter()`. */
  filter?: string;
  /** Comma-separated fields, `-` for descending, e.g. `-created,title`. */
  sort?: string;
  /** Skips counting the matches: faster, with `totalItems` and `totalPages` -1. */
  skipTotal?: boolean;
}

export interface FullListOptions extends ListOptions {
  /** Records fetched per request. Defaults to 1000, the server's maximum. */
  batch?: number;
}

export interface OAuth2Options {
  /** Path on your app to return to afterwards, such as `/dashboard`. */
  redirect?: string;
  /**
   * Path to return to with `?error=` when the sign-in fails, such as
   * `/sign-in`. Defaults to `redirect`.
   */
  errorRedirect?: string;
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
    return this.#send("/records", {
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

  /** The first record matching `filter`. Throws a 404 {@link ClientError} when none does. */
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
        message: "No record matches the filter.",
        data: {},
      });
    }
    return item;
  }

  getOne(id: string, options?: RecordOptions): Promise<T> {
    return this.#send(`/records/${encodeURIComponent(id)}`, options);
  }

  /**
   * Creates a record. Returns it, or `null` when it was created but the
   * caller may not view it.
   */
  async create(
    body: Record<string, unknown>,
    options?: RecordOptions,
  ): Promise<T | null> {
    const record = await this.#send<T | undefined>("/records", {
      ...options,
      method: "POST",
      body,
    });
    return record ?? null;
  }

  /**
   * Updates a record. Returns it, or `null` when it was updated but the
   * caller may no longer view it. Updating the signed-in record refreshes it
   * in the auth store.
   */
  async update(
    id: string,
    body: Record<string, unknown>,
    options?: RecordOptions,
  ): Promise<T | null> {
    const record = await this.#send<T | undefined>(
      `/records/${encodeURIComponent(id)}`,
      { ...options, method: "PATCH", body },
    );
    const store = this.#client.authStore;
    if (record && this.#isSignedIn(record)) {
      store.save(store.token, { ...store.record, ...record });
    }
    return record ?? null;
  }

  /** Deletes a record. Deleting the signed-in record signs out. */
  async delete(id: string, options?: SendOptions): Promise<void> {
    const store = this.#client.authStore;
    const signedIn = store.record;
    await this.#send(`/records/${encodeURIComponent(id)}`, {
      ...options,
      method: "DELETE",
    });
    if (signedIn && signedIn.id === id && this.#matches(signedIn)) {
      store.clear();
    }
  }

  /**
   * Creates an account and signs it in, in one request, under the
   * collection's create rule: `body` holds the record's fields, `password`
   * and `passwordConfirm`. Saves the session like `signInWithPassword`, and
   * takes the same `cookie` option. Returns null when the account was created
   * but may not sign in yet, such as before verifying its email.
   */
  async signUp(
    body: Record<string, unknown>,
    options: AuthOptions = {},
  ): Promise<AuthResponse<T> | null> {
    const { cookie, ...rest } = options;
    const response = await this.#send<AuthResponse<T> | undefined>("/sign-up", {
      ...rest,
      method: "POST",
      body: { ...body, ...(cookie && { cookie: true }) },
    });
    return response ? this.#saveAuth(response) : null;
  }

  /**
   * Signs in and saves the record, and the token, in the auth store. With
   * `cookie: true` the session goes into an HttpOnly cookie instead, out of
   * reach of scripts and readable by server components; the response and
   * the store then hold no token.
   */
  async signInWithPassword(
    identity: string,
    password: string,
    options: AuthOptions = {},
  ): Promise<AuthResponse<T>> {
    const { cookie, ...rest } = options;
    return this.#saveAuth(
      await this.#send<AuthResponse<T>>("/auth-with-password", {
        ...rest,
        method: "POST",
        body: { identity, password, ...(cookie && { cookie: true }) },
      }),
    );
  }

  /** Extends the current session to its full lifetime and reloads the record. */
  async refreshSession(options?: RecordOptions): Promise<AuthResponse<T>> {
    return this.#saveAuth(
      await this.#send<AuthResponse<T>>("/auth-refresh", {
        ...options,
        method: "POST",
      }),
    );
  }

  /**
   * The URL that signs in with an OAuth2 provider, such as `google`: open it
   * in the browser, as a link or a redirect. The server sends the browser
   * to the provider and back to `redirect` signed in with a session cookie,
   * or with `?error=` naming what went wrong.
   */
  oauth2Url(
    provider: string,
    options: OAuth2Options & {
      /** Link the provider to the signed-in account instead of signing in. */
      link?: boolean;
    } = {},
  ): string {
    return this.#client.buildUrl(
      `/collections/${encodeURIComponent(this.#collection)}/auth-with-oauth2/${encodeURIComponent(provider)}`,
      {
        redirect: options.redirect,
        errorRedirect: options.errorRedirect,
        ...(options.link && { link: true }),
      },
    );
  }

  /** Signs in with an OAuth2 provider by sending the browser to {@link oauth2Url}. */
  signInWithOAuth2(provider: string, options: OAuth2Options = {}): void {
    if (typeof location === "undefined") {
      throw new Error(
        "signInWithOAuth2 works in the browser; use oauth2Url elsewhere.",
      );
    }
    location.assign(this.oauth2Url(provider, options));
  }

  /**
   * Links an OAuth2 provider to the signed-in account, by sending the
   * browser to the provider; the session stays as it is. Comes back to
   * `redirect`, or to `errorRedirect` with `?error=`.
   */
  linkOAuth2(provider: string, options: OAuth2Options = {}): void {
    if (typeof location === "undefined") {
      throw new Error(
        "linkOAuth2 works in the browser; use oauth2Url with link: true elsewhere.",
      );
    }
    location.assign(this.oauth2Url(provider, { ...options, link: true }));
  }

  /** The OAuth2 providers linked to a record: the signed-in record's own, or any for superusers. */
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

  /** Unlinks an OAuth2 provider from a record. */
  async unlinkAccount(
    recordId: string,
    provider: string,
    options?: SendOptions,
  ): Promise<void> {
    await this.#send(
      `/records/${encodeURIComponent(recordId)}/linked-accounts/${encodeURIComponent(provider)}`,
      { ...options, method: "DELETE" },
    );
  }

  /** How records of this auth collection sign in, for a login page. */
  listAuthMethods(options?: SendOptions): Promise<AuthMethods> {
    return this.#send("/auth-methods", options);
  }

  /**
   * Emails a verification link to `email`, if it belongs to an unverified
   * account. Resolves the same either way, so it reveals no accounts.
   */
  async requestEmailVerification(
    email: string,
    options?: SendOptions,
  ): Promise<void> {
    await this.#post("/request-email-verification", { email }, options);
  }

  /** Verifies the account of a verification link's token. */
  async confirmEmailVerification(
    token: string,
    options?: SendOptions,
  ): Promise<void> {
    await this.#post("/confirm-email-verification", { token }, options);
  }

  /**
   * Emails a password reset link to `email`, if it belongs to an account.
   * Resolves the same either way.
   */
  async requestPasswordReset(
    email: string,
    options?: SendOptions,
  ): Promise<void> {
    await this.#post("/request-password-reset", { email }, options);
  }

  /**
   * Sets a new password with a reset link's token. Every session of the
   * account ends; sign in again with the new password.
   */
  async confirmPasswordReset(
    token: string,
    password: string,
    passwordConfirm: string,
    options?: SendOptions,
  ): Promise<void> {
    await this.#post(
      "/confirm-password-reset",
      { token, password, passwordConfirm },
      options,
    );
  }

  /** Emails a link to `newEmail` that moves the signed-in account to it. */
  async requestEmailChange(
    newEmail: string,
    options?: SendOptions,
  ): Promise<void> {
    await this.#post("/request-email-change", { newEmail }, options);
  }

  /**
   * Moves the account to the new email of an email change link's token,
   * given its current password. Every session of the account ends.
   */
  async confirmEmailChange(
    token: string,
    password: string,
    options?: SendOptions,
  ): Promise<void> {
    await this.#post("/confirm-email-change", { token, password }, options);
  }

  /**
   * Texts a sign-in code to `phone`, in international format such as
   * `+255712345678`; a new phone signs up. Resolves the same either way, so
   * it reveals no accounts.
   */
  async requestPhoneCode(phone: string, options?: SendOptions): Promise<void> {
    await this.#post("/request-phone-code", { phone }, options);
  }

  /**
   * Texts a password reset code to `phone`, if it is an account's verified
   * phone. Resolves the same either way, so it reveals no accounts.
   */
  async requestPasswordResetByPhone(
    phone: string,
    options?: SendOptions,
  ): Promise<void> {
    await this.#post("/request-password-reset-by-phone", { phone }, options);
  }

  /**
   * Signs in with a code from {@link requestPhoneCode}, creating the account
   * for a new phone under the collection's create rule. Saves the session
   * like `signInWithPassword`, and takes the same `cookie` option.
   */
  async signInWithPhoneCode(
    phone: string,
    code: string,
    options: AuthOptions = {},
  ): Promise<AuthResponse<T>> {
    const { cookie, ...rest } = options;
    return this.#saveAuth(
      await this.#send<AuthResponse<T>>("/auth-with-phone-code", {
        ...rest,
        method: "POST",
        body: { phone, code, ...(cookie && { cookie: true }) },
      }),
    );
  }

  /**
   * Sets a new password with a code texted for a password reset. Every
   * session of the account ends; sign in again with the new password.
   */
  async confirmPasswordResetByPhone(
    phone: string,
    code: string,
    password: string,
    passwordConfirm: string,
    options?: SendOptions,
  ): Promise<void> {
    await this.#post(
      "/confirm-password-reset-by-phone",
      { phone, code, password, passwordConfirm },
      options,
    );
  }

  /** Texts a code to `phone` that verifies it as the signed-in account's phone. */
  async requestPhoneVerification(
    phone: string,
    options?: SendOptions,
  ): Promise<void> {
    await this.#post("/request-phone-verification", { phone }, options);
  }

  /**
   * Makes `phone` the signed-in account's verified phone, given the code
   * texted to it. Changing the phone signs out the account's other devices.
   */
  async confirmPhoneVerification(
    phone: string,
    code: string,
    options?: SendOptions,
  ): Promise<void> {
    await this.#post("/confirm-phone-verification", { phone, code }, options);
  }

  async #post(
    path: string,
    body: Record<string, unknown>,
    options: SendOptions = {},
  ): Promise<void> {
    await this.#client.send(
      `/collections/${encodeURIComponent(this.#collection)}${path}`,
      { ...options, method: "POST", body },
    );
  }

  #saveAuth(response: AuthResponse<T>): AuthResponse<T> {
    this.#client.authStore.save(response.token ?? "", response.record);
    return response;
  }

  #isSignedIn(record: RecordModel): boolean {
    const signedIn = this.#client.authStore.record;
    return (
      signedIn?.id === record.id &&
      signedIn.collectionId === record.collectionId
    );
  }

  /** Whether a record from the auth store belongs to this collection. */
  #matches(record: RecordModel): boolean {
    return (
      record.collectionId === this.#collection ||
      record.collectionName === this.#collection
    );
  }

  #send<R>(path: string, options: RecordOptions = {}): Promise<R> {
    const { expand, fields, ...rest } = options;
    return this.#client.send(
      `/collections/${encodeURIComponent(this.#collection)}${path}`,
      { ...rest, query: { ...rest.query, expand, fields } },
    );
  }
}
