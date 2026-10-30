import { AuthStore } from './auth-store.ts';
import { authSync } from './auth-sync.ts';
import { ClientError } from './client-error.ts';
import { hasFiles, toFormData } from './files.ts';
import type { NextBaseClient, SendOptions } from './index.ts';
import type { RealtimeEvent, SubscribeOptions } from './realtime.ts';
import type {
  AuthMethods,
  AuthResponse,
  ImpersonateResponse,
  LinkedAccountModel,
  ListResult,
  RecordModel,
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
   * Calls `callback` for each record created, updated or deleted that the
   * caller may see: `"*"` for the collection, under its list rule and
   * `filter`, or a record id, under its view rule. The collection must be
   * listed in the server's `realtime` option. Returns the unsubscribe
   * function.
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

  /** Creates a record. Returns null when the caller may not view it. */
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
   * Updates a record. Returns null when the caller may no longer view it.
   * Updating the signed-in record refreshes it in the auth store.
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

  /** Deletes a record. Deleting the signed-in record signs out. */
  async delete(id: string, options?: SendOptions): Promise<void> {
    await this.#send(`/records/${encodeURIComponent(id)}`, {
      ...options,
      method: 'DELETE',
    });
    // Checked once deleted: another account may have signed in meanwhile.
    const store = this.#client.authStore;
    if (store.record?.id === id && this.#matches(store.record)) store.clear();
  }

  /**
   * Creates an account and signs it in, saving the session like `signInWithPassword`.
   * Returns null when the account may not sign in yet, e.g. before email verification.
   */
  async signUp(
    body: Record<string, unknown>,
    options: AuthOptions = {},
  ): Promise<AuthResponse<T> | null> {
    const { cookie, ...rest } = options;
    const apply = authSync(this.#client.authStore).intent();
    const response = await this.#send<AuthResponse<T> | undefined>('/sign-up', {
      ...rest,
      method: 'POST',
      body: await this.#body(
        { ...body, ...(cookie && { cookie: true }) },
        rest,
      ),
    });
    if (response) apply(() => this.#save(response));
    return response ?? null;
  }

  /**
   * Signs in and saves the session in the auth store. With `cookie: true` it goes
   * in an HttpOnly cookie instead, and the response and store hold no token.
   * Of sign-ins and sign-outs that overlap, the one started last wins.
   */
  async signInWithPassword(
    identity: string,
    password: string,
    options: AuthOptions = {},
  ): Promise<AuthResponse<T>> {
    const { cookie, ...rest } = options;
    return this.#signIn('/auth-with-password', rest, {
      identity,
      password,
      ...(cookie && { cookie: true }),
    });
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
   * As a superuser, starts a session that acts as the record, to see the app
   * as its owner does. By default the result has a new client signed in as
   * the record, with its own in-memory auth store: this client stays signed
   * in as the superuser. With `cookie: true`, this browser's cookie session
   * becomes the record's instead, and `signOut()` gives the superuser theirs
   * back; the auth store is then saved as for a cookie sign-in.
   */
  async impersonate(
    id: string,
    options: ImpersonateOptions & { cookie: true },
  ): Promise<ImpersonateResponse<T>>;
  async impersonate(
    id: string,
    options?: ImpersonateOptions,
  ): Promise<ImpersonateResponse<T> & { client: NextBaseClient }>;
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
  linkOAuth2(provider: string, options: OAuth2Options = {}): void {
    if (typeof location === 'undefined') {
      throw new Error(
        'linkOAuth2 works in the browser; use oauth2Url with link: true elsewhere.',
      );
    }
    location.assign(this.oauth2Url(provider, { ...options, link: true }));
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

  /** Unlinks an OAuth2 provider from a record. */
  async unlinkAccount(
    recordId: string,
    provider: string,
    options?: SendOptions,
  ): Promise<void> {
    await this.#send(
      `/records/${encodeURIComponent(recordId)}/linked-accounts/${encodeURIComponent(provider)}`,
      { ...options, method: 'DELETE' },
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

  /** Emails `newEmail` a link that moves the signed-in account to it. */
  async requestEmailChange(
    newEmail: string,
    options?: SendOptions,
  ): Promise<void> {
    await this.#post('/request-email-change', { newEmail }, options);
  }

  /** Confirms an email change with its token and the current password. Ends every session. */
  async confirmEmailChange(
    token: string,
    password: string,
    options?: SendOptions,
  ): Promise<void> {
    await this.#post('/confirm-email-change', { token, password }, options);
  }

  /**
   * Texts a sign-in code to `phone`, such as `+255712345678`; a new phone signs up.
   * Never reveals whether an account exists.
   */
  async requestPhoneCode(phone: string, options?: SendOptions): Promise<void> {
    await this.#post('/request-phone-code', { phone }, options);
  }

  /** Texts a password reset code if `phone` is an account's verified phone. Never reveals which. */
  async requestPasswordResetByPhone(
    phone: string,
    options?: SendOptions,
  ): Promise<void> {
    await this.#post('/request-password-reset-by-phone', { phone }, options);
  }

  /**
   * Signs in with a code from {@link requestPhoneCode}, creating the account for a new
   * phone. Saves the session like `signInWithPassword`.
   */
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

  /** Texts a code that verifies `phone` for the signed-in account. */
  async requestPhoneVerification(
    phone: string,
    options?: SendOptions,
  ): Promise<void> {
    await this.#post('/request-phone-verification', { phone }, options);
  }

  /** Verifies `phone` for the signed-in account. Changing it signs out other devices. */
  async confirmPhoneVerification(
    phone: string,
    code: string,
    options?: SendOptions,
  ): Promise<void> {
    await this.#post('/confirm-phone-verification', { phone, code }, options);
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
