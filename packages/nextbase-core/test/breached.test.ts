import { createHash } from "node:crypto";
import { ClientError, type NextBaseClient } from "@nextbasejs/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type MailMessage, NextBase } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "./postgres.ts";

const BREACHED = "correct horse battery staple";
const FRESH = "a fresh password 0451 nobody has";

const sha1 = (password: string): string =>
  createHash("sha1").update(password).digest("hex").toUpperCase();

describe("breached password check", () => {
  let t: TestDatabase;
  let nextbase: NextBase;
  let admin: NextBaseClient;
  const sent: MailMessage[] = [];
  const pending: Promise<unknown>[] = [];
  /** The prefixes the fake service was asked about. */
  const asked: string[] = [];
  let answer: (prefix: string) => Response;

  /** A padded range answer, as the service sends: its matches and zero-count noise. */
  const range = (prefix: string): Response => {
    const lines = Array.from(
      { length: 800 },
      (_, i) => `${i.toString(16).toUpperCase().padStart(35, "0")}:0`,
    );
    const breached = sha1(BREACHED);
    if (breached.startsWith(prefix)) lines.push(`${breached.slice(5)}:52579`);
    // Padding that happens to equal a fresh password's suffix never counts.
    const fresh = sha1(FRESH);
    if (fresh.startsWith(prefix)) lines.push(`${fresh.slice(5)}:0`);
    return new Response(lines.join("\r\n"));
  };

  const failure = async (promise: Promise<unknown>): Promise<ClientError> => {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClientError);
    return error as ClientError;
  };

  const signUp = (email: string, password: string) =>
    nextbase
      .client()
      .collection("users")
      .signUp({ email, password, passwordConfirm: password });

  beforeAll(async () => {
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input);
        expect(url.origin).toBe("https://api.pwnedpasswords.com");
        expect(new Headers(init?.headers).get("add-padding")).toBe("true");
        const prefix = url.pathname.replace("/range/", "");
        asked.push(prefix);
        return answer(prefix);
      },
    );
    t = await createTestDatabase();
    nextbase = new NextBase({
      database: t.pool,
      breachedPasswords: true,
      mail: {
        from: "app@example.com",
        appUrl: "https://app.example.com",
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
      updateRule: "id = @request.auth.id",
    });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await t.close();
  });

  it("refuses a breached password on sign-up, sending only the hash's first 5 characters", async () => {
    answer = range;
    const error = await failure(signUp("ann@example.com", BREACHED));
    expect(error.status).toBe(400);
    expect(error.data.password?.code).toBe("validation_breached_password");
    expect(asked.at(-1)).toBe(sha1(BREACHED).slice(0, 5));
    expect(await signUp("ann@example.com", FRESH)).not.toBeNull();
  });

  it("refuses a breached password on a password change and a reset", async () => {
    answer = range;
    const users = nextbase.client().collection("users");
    const { record } = await users.signInWithPassword("ann@example.com", FRESH);
    const change = await failure(
      users.update(record.id, {
        oldPassword: FRESH,
        password: BREACHED,
        passwordConfirm: BREACHED,
      }),
    );
    expect(change.data.password?.code).toBe("validation_breached_password");

    await users.requestPasswordReset("ann@example.com");
    await Promise.all(pending.splice(0));
    const token = /token=([\w.-]+)/.exec(sent.at(-1)?.text ?? "")?.[1] ?? "";
    const reset = await failure(
      users.confirmPasswordReset(token, BREACHED, BREACHED),
    );
    expect(reset.data.password?.code).toBe("validation_breached_password");
  });

  it("accepts the password when the service is down or answers something else", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    answer = () => new Response("unavailable", { status: 503 });
    expect(await signUp("bo@example.com", BREACHED)).not.toBeNull();
    // A captive portal answering 200 with a page of its own.
    answer = () => new Response("<html>Sign in to the Wi-Fi</html>");
    expect(await signUp("cy@example.com", BREACHED)).not.toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("is off by default", async () => {
    const before = asked.length;
    const plain = new NextBase({ database: t.pool });
    await plain.client().collection("users").signUp({
      email: "dee@example.com",
      password: BREACHED,
      passwordConfirm: BREACHED,
    });
    expect(asked.length).toBe(before);
  });
});
