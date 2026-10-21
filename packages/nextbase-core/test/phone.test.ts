import { ClientError, type NextBaseClient } from "@nextbasejs/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migrate } from "../src/db/migrations.ts";
import { type MailMessage, NextBase, type SmsMessage } from "../src/index.ts";
import { call } from "./http.ts";
import { createTestDatabase, type TestDatabase } from "./postgres.ts";

const PASSWORD = "password 123 456";

describe("phone sign-in", () => {
  let t: TestDatabase;
  let nextbase: NextBase;
  let admin: NextBaseClient;
  const texts: SmsMessage[] = [];
  const mails: MailMessage[] = [];
  const pending: Promise<unknown>[] = [];

  const flush = async (): Promise<void> => {
    await Promise.all(pending.splice(0));
  };
  /** The code in the last text to `phone`. */
  const codeFor = async (phone: string): Promise<string> => {
    await flush();
    const text = texts.filter((m) => m.to === phone).at(-1)?.text ?? "";
    const code = /\b(\d{6})\b/.exec(text)?.[1];
    if (!code) throw new Error(`No code texted to ${phone}.`);
    return code;
  };
  const textsTo = async (phone: string): Promise<SmsMessage[]> => {
    await flush();
    return texts.filter((m) => m.to === phone);
  };
  const failure = async (promise: Promise<unknown>): Promise<ClientError> => {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClientError);
    return error as ClientError;
  };
  const users = () => nextbase.client().collection("users");
  /** Requests a code and signs in with it. */
  const signIn = async (phone: string) => {
    const nb = nextbase.client();
    await nb.collection("users").requestPhoneCode(phone);
    const auth = await nb
      .collection("users")
      .signInWithPhoneCode(phone, await codeFor(phone));
    return { nb, ...auth };
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    nextbase = new NextBase({
      database: t.pool,
      sms: {
        countries: ["TZ"],
        send: async (message) => {
          texts.push(message);
        },
      },
      mail: {
        from: "app@example.com",
        appUrl: "https://app.example.com",
        send: async (message) => {
          mails.push(message);
        },
      },
      waitUntil: (promise) => pending.push(promise),
    });
    admin = nextbase.client({ superuser: true });
    await admin.collections.create({
      name: "users",
      type: "auth",
      phoneSignIn: true,
      identityFields: ["email", "phone"],
      createRule: "",
      listRule: "",
      viewRule: "",
      updateRule: "id = @request.auth.id",
    });
  });
  afterAll(() => t.close());

  it("lists phone sign-in for collections that enable it", async () => {
    expect((await users().listAuthMethods()).phone).toEqual({ enabled: true });
    await admin.collections.create({ name: "plain", type: "auth" });
    const plain = nextbase.client().collection("plain");
    expect((await plain.listAuthMethods()).phone).toEqual({ enabled: false });
    const error = await failure(plain.requestPhoneCode("+255712345678"));
    expect(error.status).toBe(400);
  });

  it("signs up a new phone with a code, with no email needed", async () => {
    // Any common notation works; texts go to the number in E.164.
    await users().requestPhoneCode("+255 712 345 678");
    const { record, token } = await users().signInWithPhoneCode(
      "+255 712-345-678",
      await codeFor("+255712345678"),
    );
    expect(record).toMatchObject({
      phone: "+255712345678",
      phoneVerified: true,
      email: "",
      emailVerified: false,
    });
    expect(token).not.toBe("");
    // The text says what the code is for, and nothing else.
    expect((await textsTo("+255712345678"))[0]?.text).toMatch(
      /^\d{6} is your sign-in code\./,
    );
  });

  it("signs the same phone in to the same account, and accepts each code once", async () => {
    const phone = "+255754000001";
    const first = await signIn(phone);
    await users().requestPhoneCode(phone);
    const code = await codeFor(phone);
    const again = await users().signInWithPhoneCode(phone, code);
    expect(again.record.id).toBe(first.record.id);
    const reused = await failure(users().signInWithPhoneCode(phone, code));
    expect(reused.data.code?.code).toBe("validation_invalid_code");
  });

  it("limits guesses per phone across codes, and discards a code guessed too often", async () => {
    const phone = "+255713000002";
    await users().requestPhoneCode(phone);
    const code = await codeFor(phone);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      await failure(users().signInWithPhoneCode(phone, wrong));
    }
    // Five wrong guesses discard the code, even the right one fails now.
    expect(
      (await failure(users().signInWithPhoneCode(phone, code))).status,
    ).toBe(400);
    // A new code does not reset the phone's count of failed guesses.
    await users().requestPhoneCode(phone);
    const fresh = await codeFor(phone);
    for (let i = 0; i < 4; i++) {
      await failure(users().signInWithPhoneCode(phone, wrong));
    }
    const locked = await failure(users().signInWithPhoneCode(phone, fresh));
    expect(locked.status).toBe(429);
  });

  it("refuses an expired code", async () => {
    const phone = "+255713000003";
    await users().requestPhoneCode(phone);
    const code = await codeFor(phone);
    await t.pool.query(
      "UPDATE nextbase._phone_codes SET expires = now() - interval '1 second' WHERE phone = $1",
      [phone],
    );
    expect(
      (await failure(users().signInWithPhoneCode(phone, code))).data.code?.code,
    ).toBe("validation_invalid_code");
  });

  it("limits texts per phone, and to the allowed countries", async () => {
    const phone = "+255713000005";
    for (let i = 0; i < 5; i++) await users().requestPhoneCode(phone);
    const limited = await failure(users().requestPhoneCode(phone));
    expect(limited.status).toBe(429);
    expect(await textsTo(phone)).toHaveLength(5);

    const kenya = await failure(users().requestPhoneCode("+254712345678"));
    expect(kenya.data.phone?.code).toBe("validation_country_not_allowed");
    for (const invalid of ["0712345678", "+255", "phone"]) {
      const error = await failure(users().requestPhoneCode(invalid));
      expect(error.data.phone?.code).toBe("validation_invalid_phone");
    }
  });

  it("sends no code where it cannot be used, answering the same", async () => {
    // No account has this phone, so a password reset code would be useless.
    await users().requestPasswordResetByPhone("+255713000006");
    expect(await textsTo("+255713000006")).toEqual([]);
    // Nobody may sign up to a collection with a null create rule.
    await admin.collections.update("users", { createRule: null });
    await users().requestPhoneCode("+255713000007");
    expect(await textsTo("+255713000007")).toEqual([]);
    await admin.collections.update("users", { createRule: "" });
  });

  it("resets a password with a code, ending every session, then signs in by phone and password", async () => {
    const phone = "+255713000004";
    const { nb } = await signIn(phone);
    await users().requestPasswordResetByPhone(phone);
    const code = await codeFor(phone);
    expect((await textsTo(phone)).at(-1)?.text).toMatch(/password reset/);
    await users().confirmPasswordResetByPhone(phone, code, PASSWORD, PASSWORD);
    expect((await failure(nb.getSession())).status).toBe(401);
    // The phone is an identity field, in any common notation.
    const { record } = await users().signInWithPassword(
      "+255 713 000 004",
      PASSWORD,
    );
    expect(record.phone).toBe(phone);
    // The code was for a reset, not for signing in.
    const misused = await failure(users().signInWithPhoneCode(phone, code));
    expect(misused.status).toBe(400);
  });

  it("verifies and changes the signed-in account's phone, telling the old phone and email", async () => {
    const nb = nextbase.client();
    await nb.collection("users").signUp({
      email: "ann@example.com",
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    const other = nextbase.client();
    await other
      .collection("users")
      .signInWithPassword("ann@example.com", PASSWORD);

    const first = "+255713100001";
    await nb.collection("users").requestPhoneVerification(first);
    await nb
      .collection("users")
      .confirmPhoneVerification(first, await codeFor(first));
    const session = await nb.getSession();
    expect(session?.record).toMatchObject({
      phone: first,
      phoneVerified: true,
    });
    // A new way to sign in ends the account's other sessions.
    expect((await failure(other.getSession())).status).toBe(401);

    const second = "+255713100002";
    await nb.collection("users").requestPhoneVerification(second);
    await nb
      .collection("users")
      .confirmPhoneVerification(second, await codeFor(second));
    expect((await nb.getSession())?.record.phone).toBe(second);
    expect((await textsTo(first)).at(-1)?.text).toMatch(/was just changed/);
    await flush();
    expect(
      mails.filter((m) => m.to === "ann@example.com").at(-1)?.subject,
    ).toBe("Your phone number was changed");
  });

  it("refuses to verify a phone another account has", async () => {
    const taken = "+255713100003";
    await signIn(taken);
    const nb = nextbase.client();
    await nb.collection("users").signUp({
      email: "bo@example.com",
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    await nb.collection("users").requestPhoneVerification(taken);
    const error = await failure(
      nb
        .collection("users")
        .confirmPhoneVerification(taken, await codeFor(taken)),
    );
    expect(error.data.phone?.code).toBe("validation_not_unique");
    // A code for one account does not verify the phone for another.
    await nb.collection("users").requestPhoneVerification("+255713100004");
    const code = await codeFor("+255713100004");
    const someoneElse = (await signIn("+255713100005")).nb;
    expect(
      (
        await failure(
          someoneElse
            .collection("users")
            .confirmPhoneVerification("+255713100004", code),
        )
      ).status,
    ).toBe(400);
  });

  it("only lets superusers set a phone directly", async () => {
    const created = await failure(
      users().create({
        email: "cy@example.com",
        phone: "+255713100006",
        password: PASSWORD,
        passwordConfirm: PASSWORD,
      }),
    );
    expect(created.data.phone?.code).toBe("validation_forbidden");
    const { nb, record } = await signIn("+255713100007");
    const updated = await failure(
      nb.collection("users").update(record.id, { phone: "+255713100008" }),
    );
    expect(updated.data.phone?.code).toBe("validation_forbidden");
    const bySuperuser = await admin.collection("users").create({
      phone: "+255713100009",
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    expect(bySuperuser).toMatchObject({ phone: "+255713100009", email: "" });
  });

  it("shows a phone only to its owner and superusers, and keeps filters from finding it", async () => {
    const owner = await signIn("+255713200001");
    const stranger = (await signIn("+255713200002")).nb;
    const seen = await stranger.collection("users").getOne(owner.record.id);
    expect(seen.phone).toBe("");
    const found = await stranger
      .collection("users")
      .getList(1, 10, { filter: 'phone = "+255713200001"' });
    expect(found.items).toEqual([]);
    expect(
      (
        await failure(
          stranger.collection("users").getList(1, 10, { sort: "phone" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await owner.nb.collection("users").getOne(owner.record.id)).phone,
    ).toBe("+255713200001");
    expect(
      (await admin.collection("users").getOne(owner.record.id)).phone,
    ).toBe("+255713200001");
  });

  it("needs an email without phone sign-in", async () => {
    const error = await failure(
      admin.collection("plain").create({
        phone: "+255713200003",
        password: PASSWORD,
        passwordConfirm: PASSWORD,
      }),
    );
    expect(error.data.email?.code).toBe("validation_required");
  });

  it("needs SMS set up in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const plain = new NextBase({ database: t.pool });
      const error = await failure(
        plain.client().collection("users").requestPhoneCode("+255713200004"),
      );
      expect(error.data.sms?.code).toBe("sms_not_configured");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("adds the phone fields to auth collections made before them", async () => {
    // Rewinds the database to before phone sign-in, as an older release left it.
    const { rows } = await t.pool.query(
      "SELECT id, name FROM nextbase._collections WHERE type = 'auth'",
    );
    for (const { id, name } of rows) {
      await t.pool.query(
        `ALTER TABLE nextbase."${name}" DROP COLUMN "phone", DROP COLUMN "phoneVerified"`,
      );
      await t.pool.query(
        `UPDATE nextbase._collections
         SET fields = (SELECT jsonb_agg(f) FROM jsonb_array_elements(fields) f WHERE f->>'id' NOT IN ('_phone', '_phoneVerified')),
             options = options - 'phoneSignIn'
         WHERE id = $1`,
        [id],
      );
    }
    await t.pool.query("DROP TABLE nextbase._phone_codes");
    await t.pool.query(
      "DELETE FROM nextbase._migrations WHERE name = '0006_phone'",
    );

    await migrate(t.db);
    const upgraded = new NextBase({ database: t.pool });
    const collection = await upgraded
      .client({ superuser: true })
      .collections.getOne("users");
    expect(collection.fields.map((f) => f.name).slice(0, 6)).toEqual([
      "id",
      "email",
      "emailVisibility",
      "emailVerified",
      "phone",
      "phoneVerified",
    ]);
    expect(collection).toMatchObject({ phoneSignIn: false });
    const reply = await call(
      upgraded,
      "GET",
      "/collections/users/auth-methods",
    );
    expect(reply.body.phone).toEqual({ enabled: false });
  });
});
