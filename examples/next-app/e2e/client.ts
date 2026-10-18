/** What an app's own data layer looks like when it talks to NextBase over HTTP. */
export interface Reply<T = Record<string, unknown>> {
  status: number;
  body: T & { message?: string; data?: Record<string, unknown> };
}

export interface ListReply<T> {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  items: T[];
}

export class Api {
  readonly base: string;
  token = "";

  constructor(base: string, token = "") {
    this.base = base;
    this.token = token;
  }

  as(token: string): Api {
    return new Api(this.base, token);
  }

  async send<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Reply<T>> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers,
      body:
        body === undefined
          ? undefined
          : typeof body === "string"
            ? body
            : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text === "" ? ({} as Reply<T>["body"]) : JSON.parse(text),
    };
  }

  list<T = Record<string, unknown>>(
    collection: string,
    params: Record<string, string | number> = {},
  ): Promise<Reply<ListReply<T>>> {
    const query = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)]),
    );
    return this.send("GET", `/collections/${collection}/records?${query}`);
  }

  view<T = Record<string, unknown>>(
    collection: string,
    id: string,
    params: Record<string, string> = {},
  ): Promise<Reply<T>> {
    return this.send(
      "GET",
      `/collections/${collection}/records/${id}?${new URLSearchParams(params)}`,
    );
  }

  create<T = Record<string, unknown>>(
    collection: string,
    body: Record<string, unknown>,
  ): Promise<Reply<T>> {
    return this.send("POST", `/collections/${collection}/records`, body);
  }

  update<T = Record<string, unknown>>(
    collection: string,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Reply<T>> {
    return this.send("PATCH", `/collections/${collection}/records/${id}`, body);
  }

  remove(collection: string, id: string): Promise<Reply> {
    return this.send("DELETE", `/collections/${collection}/records/${id}`);
  }

  async login(
    collection: string,
    identity: string,
    password: string,
  ): Promise<Api> {
    const reply = await this.send<{ token: string }>(
      "POST",
      `/collections/${collection}/auth-with-password`,
      {
        identity,
        password,
      },
    );
    if (reply.status !== 200)
      throw new Error(
        `login failed: ${reply.status} ${JSON.stringify(reply.body)}`,
      );
    return this.as(reply.body.token);
  }

  /** Signs up through a public create rule and logs in. */
  async signup(email: string, name: string): Promise<{ api: Api; id: string }> {
    const password = `pw-${name}-123`;
    const reply = await this.as("").create("users", {
      email,
      name,
      password,
      passwordConfirm: password,
    });
    if (reply.status !== 200)
      throw new Error(
        `signup failed: ${reply.status} ${JSON.stringify(reply.body)}`,
      );
    return {
      api: await this.login("users", email, password),
      id: reply.body.id as string,
    };
  }
}
