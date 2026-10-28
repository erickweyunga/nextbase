import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextBase } from "../src/index.ts";
import { call, type Reply } from "./http.ts";
import { createTestDatabase, endPool, type TestDatabase } from "./postgres.ts";

const PASSWORD = "password 123 456";

describe("changing a password", () => {
  let t: TestDatabase;
  let nextbase: NextBase;
  const ids: Record<string, string> = {};
  const tokens: Record<string, string> = {};

  const signIn = async (
    target: NextBase,
    collection: string,
    email: string,
    password = PASSWORD,
  ): Promise<string> => {
    const reply = await call(
      target,
      "POST",
      `/collections/${collection}/auth-with-password`,
      { body: { identity: email, password } },
    );
    expect(reply.status).toBe(200);
    return reply.body.token as string;
  };
  const change = (
    target: NextBase,
    collection: string,
    id: string,
    token: string,
    oldPassword: string,
    password = "new password 789 012",
  ): Promise<Reply> =>
    call(target, "PATCH", `/collections/${collection}/records/${id}`, {
      token,
      body: { oldPassword, password, passwordConfirm: password },
    });
  const attempts = async (id: string): Promise<number> => {
    const { rows } = await t.pool.query(
      "SELECT failures FROM nextbase._auth_attempts WHERE key LIKE '%:record:' || $1",
      [id],
    );
    return (rows[0]?.failures as number | undefined) ?? 0;
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    nextbase = new NextBase({ database: t.pool });
    const admin = nextbase.client({ superuser: true });
    for (const name of ["members", "editors"]) {
      await admin.collections.create({
        name,
        type: "auth",
        // editors' rule reads the body, so the old password is checked in the
        // update's transaction instead of before it.
        updateRule:
          name === "members"
            ? "id = @request.auth.id"
            : "id = @request.auth.id && @request.body.email:isset = false",
      });
    }
    for (const name of ["ann", "bob", "cara", "dan"]) {
      const record = await admin.collection("members").create({
        email: `${name}@example.com`,
        password: PASSWORD,
        passwordConfirm: PASSWORD,
      });
      ids[name] = record?.id ?? "";
      tokens[name] = await signIn(nextbase, "members", `${name}@example.com`);
    }
    const editor = await admin.collection("editors").create({
      email: "eve@example.com",
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    ids.eve = editor?.id ?? "";
    tokens.eve = await signIn(nextbase, "editors", "eve@example.com");
  });

  afterAll(() => t.close());

  it("does not hold a connection while checking the old password", async () => {
    // With two connections, four changes at once would each hold one and wait
    // for another if the check ran inside the update's transaction.
    const small = new pg.Pool({
      connectionString: t.url,
      max: 2,
      connectionTimeoutMillis: 3_000,
    });
    try {
      const other = new NextBase({ database: small });
      const replies = await Promise.all(
        ["ann", "bob", "cara", "dan"].map((name) =>
          change(
            other,
            "members",
            ids[name] as string,
            tokens[name] as string,
            PASSWORD,
          ),
        ),
      );
      // 204: changed, and the caller may not view the record.
      expect(replies.map((r) => r.status)).toEqual([204, 204, 204, 204]);
    } finally {
      await endPool(small);
    }
    expect(
      await signIn(
        nextbase,
        "members",
        "ann@example.com",
        "new password 789 012",
      ),
    ).toBeTruthy();
  });

  it("counts no attempt for a caller the update rule refuses", async () => {
    // Bob may not update Cara, so his guess is refused before it is checked.
    const token = await signIn(
      nextbase,
      "members",
      "bob@example.com",
      "new password 789 012",
    );
    const refused = await change(
      nextbase,
      "members",
      ids.cara as string,
      token,
      "a wrong guess",
    );
    expect(refused.status).toBe(404);
    expect(await attempts(ids.cara as string)).toBe(0);
  });

  it("refuses a wrong old password, and counts it", async () => {
    const token = await signIn(
      nextbase,
      "members",
      "dan@example.com",
      "new password 789 012",
    );
    const wrong = await change(
      nextbase,
      "members",
      ids.dan as string,
      token,
      "a wrong guess",
    );
    expect(wrong.status).toBe(400);
    expect(wrong.body.data).toMatchObject({
      oldPassword: { code: "validation_invalid_old_password" },
    });
    expect(await attempts(ids.dan as string)).toBe(1);
  });

  it("checks the old password in the transaction when the rule reads the body", async () => {
    const id = ids.eve as string;
    const wrong = await change(
      nextbase,
      "editors",
      id,
      tokens.eve as string,
      "a wrong guess",
    );
    expect(wrong.status).toBe(400);
    expect(await attempts(id)).toBe(1);
    const right = await change(
      nextbase,
      "editors",
      id,
      tokens.eve as string,
      PASSWORD,
    );
    expect(right.status).toBe(204);
    expect(await attempts(id)).toBe(0);
  });

  it("refuses the change if the password changed after it was checked", async () => {
    const id = ids.ann as string;
    const token = await signIn(
      nextbase,
      "members",
      "ann@example.com",
      "new password 789 012",
    );
    const other = await t.pool.connect();
    try {
      // Holds the row, so the update checks the old password, then waits.
      await other.query("BEGIN");
      await other.query(
        "SELECT 1 FROM nextbase.members WHERE id = $1 FOR UPDATE",
        [id],
      );
      const pending = change(
        nextbase,
        "members",
        id,
        token,
        "new password 789 012",
        "third password 345 678",
      );
      for (;;) {
        const { rows } = await t.pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
        );
        if (rows.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // Another request sets a new password meanwhile.
      await other.query(
        "UPDATE nextbase.members SET password = 'changed elsewhere' WHERE id = $1",
        [id],
      );
      await other.query("COMMIT");
      const reply = await pending;
      expect(reply.status).toBe(400);
      expect(reply.body.data).toMatchObject({
        oldPassword: { code: "validation_invalid_old_password" },
      });
    } finally {
      other.release();
    }
  });
});
