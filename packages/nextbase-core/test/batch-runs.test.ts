import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "../src/auth/principal.ts";
import { NextBase } from "../src/index.ts";
import { createRuns, type PlannedCreate } from "../src/records/service.ts";
import { call, type Reply } from "./http.ts";
import { createTestDatabase, type TestDatabase } from "./postgres.ts";

/** Wraps `pool` to count the queries sent to Postgres, including those inside transactions. */
function counting(pool: pg.Pool): { pool: pg.Pool; queries: () => number } {
  let count = 0;
  const countQueries = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        if (prop === "query") {
          return (...args: unknown[]) => {
            count++;
            return value.apply(target, args);
          };
        }
        if (prop === "connect") {
          return async () => countQueries(await value.apply(target));
        }
        return value.bind(target);
      },
    });
  return {
    pool: countQueries(pool),
    queries: () => {
      const n = count;
      count = 0;
      return n;
    },
  };
}

const PASSWORD = "password 123 456";
const CREATE = "/collections/customers/records";

describe("batches of creates", () => {
  let t: TestDatabase;
  let nextbase: NextBase;
  let queries: () => number;
  const tokens: Record<"user" | "admin", string> = { user: "", admin: "" };
  const ids: Record<string, string> = {};

  const batch = (
    token: string,
    requests: { url?: string; body: Record<string, unknown> }[],
  ): Promise<Reply> =>
    call(nextbase, "POST", "/batch", {
      token,
      body: {
        requests: requests.map(({ url = CREATE, body }) => ({
          method: "POST",
          url,
          body,
        })),
      },
    });
  const customer = (name: string, extra: Record<string, unknown> = {}) => ({
    body: {
      name,
      workspace: ids.workspace,
      segments: [ids.segment],
      ...extra,
    },
  });
  const count = async (collection: string): Promise<number> => {
    const { rows } = await t.pool.query(
      `SELECT count(*)::int AS n FROM nextbase.${collection}`,
    );
    return rows[0].n as number;
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    const counted = counting(t.pool);
    queries = counted.queries;
    nextbase = new NextBase({ database: counted.pool });
    await nextbase.createSuperuser("admin@example.com", "admin password 123");
    const admin = nextbase.client({ superuser: true });
    await admin.collections.create({ name: "users", type: "auth" });
    const workspaces = await admin.collections.create({
      name: "workspaces",
      viewRule: "",
    });
    const segments = await admin.collections.create({
      name: "segments",
      viewRule: "",
    });
    await admin.collections.create({
      name: "customers",
      listRule: "",
      viewRule: "",
      // Refuses blocked names, so tests can make the rule refuse one row.
      createRule: '@request.auth.id != "" && name != "blocked"',
      fields: [
        { id: "custname00", name: "name", type: "text", required: true },
        { name: "workspace", type: "relation", collectionId: workspaces.id },
        {
          name: "segments",
          type: "relation",
          collectionId: segments.id,
          maxSelect: 5,
        },
      ],
      indexes: [
        { name: "customers_name", unique: true, fields: ["custname00"] },
      ],
    });
    const users = await admin.collections.getOne("users");
    await admin.collections.create({
      name: "memberships",
      fields: [
        { name: "user", type: "relation", collectionId: users.id },
        { name: "workspace", type: "relation", collectionId: workspaces.id },
      ],
    });
    // Membership-style: reads another collection, so creates run together.
    await admin.collections.create({
      name: "leads",
      viewRule: "",
      createRule:
        "@collection.memberships.user = @request.auth.id && @collection.memberships.workspace = workspace",
      fields: [
        { name: "workspace", type: "relation", collectionId: workspaces.id },
      ],
    });
    // Reads the collection itself, so each create runs alone.
    await admin.collections.create({
      name: "tickets",
      viewRule: "",
      createRule: '@request.auth.id != "" || @collection.tickets.id = "x"',
    });
    const folders = await admin.collections.create({
      name: "folders",
      viewRule: "",
    });
    await admin.collections.update("folders", {
      createRule: '@request.auth.id != "" || folders_via_parent.id ?= "x"',
      fields: [{ name: "parent", type: "relation", collectionId: folders.id }],
    });
    const categories = await admin.collections.create({
      name: "categories",
      createRule: "",
      viewRule: "",
    });
    await admin.collections.update("categories", {
      fields: [
        { name: "parent", type: "relation", collectionId: categories.id },
      ],
    });
    ids.workspace = (await admin.collection("workspaces").create({}))?.id ?? "";
    ids.segment = (await admin.collection("segments").create({}))?.id ?? "";
    const robin = await admin.collection("users").create({
      email: "robin@example.com",
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    await admin
      .collection("memberships")
      .create({ user: robin?.id, workspace: ids.workspace });
    const signIn = async (
      collection: string,
      email: string,
      password: string,
    ) =>
      (
        await call(
          nextbase,
          "POST",
          `/collections/${collection}/auth-with-password`,
          { body: { identity: email, password } },
        )
      ).body.token as string;
    tokens.user = await signIn("users", "robin@example.com", PASSWORD);
    tokens.admin = await signIn(
      "_superusers",
      "admin@example.com",
      "admin password 123",
    );
  });

  afterAll(() => t.close());

  it("creates 50 records with a few queries, not a few per record", async () => {
    // Warms the schema and the setup check, which are read once per process.
    await batch(tokens.user, [customer("warm")]);
    const fifty = Array.from({ length: 50 }, (_, i) => customer(`user ${i}`));
    queries();
    const reply = await batch(tokens.user, fifty);
    expect(reply.status).toBe(200);
    // The session, BEGIN, one per relation target, the create rule, the
    // insert in a savepoint (so a duplicate can be traced to its row), the
    // read back and COMMIT.
    expect(queries()).toBe(10);
    const results = reply.body as unknown as Reply[];
    expect(results.map((r) => r.status)).toEqual(fifty.map(() => 200));
    expect(results.map((r) => r.body.name)).toEqual(
      fifty.map((c) => c.body.name),
    );

    const asAdmin = Array.from({ length: 50 }, (_, i) =>
      customer(`admin ${i}`),
    );
    await batch(tokens.admin, asAdmin);
    // Superusers skip the create rule.
    expect(queries()).toBe(9);
  });

  it("creates together when the create rule reads other collections", async () => {
    const leads = (n: number) =>
      Array.from({ length: n }, () => ({
        url: "/collections/leads/records",
        body: { workspace: ids.workspace },
      }));
    queries();
    const ten = await batch(tokens.user, leads(10));
    expect(ten.status).toBe(200);
    const forTen = queries();
    await batch(tokens.user, leads(30));
    expect(queries()).toBe(forTen);
    // Not a member of this workspace: the rule refuses the lead.
    const other = await nextbase
      .client({ superuser: true })
      .collection("workspaces")
      .create({});
    const refused = await batch(tokens.user, [
      ...leads(2),
      { url: "/collections/leads/records", body: { workspace: other?.id } },
    ]);
    expect(refused.body.message).toMatch(/^Request 3 of the batch failed/);
  });

  it("creates one at a time when a rule reads the collection itself", async () => {
    for (const collection of ["tickets", "folders"]) {
      const creates = (n: number) =>
        Array.from({ length: n }, () => ({
          url: `/collections/${collection}/records`,
          body: {},
        }));
      queries();
      expect((await batch(tokens.user, creates(5))).status).toBe(200);
      const forFive = queries();
      await batch(tokens.user, creates(6));
      // The rule, the insert and the read back, for each create.
      expect(queries() - forFive).toBe(3);
    }
  });

  it("reports the first failing create, as when each is done in turn", async () => {
    const before = await count("customers");
    const fails = async (requests: ReturnType<typeof customer>[]) => {
      const reply = await batch(tokens.user, requests);
      expect(reply.status).toBe(400);
      expect(await count("customers")).toBe(before);
      return reply.body;
    };
    // A required name missing on the 3rd, the rule refusing the 5th.
    expect(
      await fails([
        customer("a1"),
        customer("a2"),
        customer(""),
        customer("a4"),
        customer("blocked"),
      ]),
    ).toMatchObject({
      message: expect.stringMatching(/^Request 3 of the batch failed/),
      data: { requests: { 2: { name: { code: "validation_required" } } } },
    });
    // The rule refusing the 2nd comes before a problem on the 4th.
    expect(
      await fails([
        customer("b1"),
        customer("blocked"),
        customer("b3"),
        customer(""),
      ]),
    ).toMatchObject({
      message: expect.stringMatching(/^Request 2 of the batch failed/),
    });
    // A missing related record, named for its row.
    expect(
      await fails([
        customer("c1"),
        customer("c2", { segments: [ids.segment, "missing00000000"] }),
      ]),
    ).toMatchObject({
      message: expect.stringMatching(/^Request 2 of the batch failed/),
      data: {
        requests: { 1: { segments: { code: "validation_missing_relation" } } },
      },
    });
  });

  it("finds the create that duplicates a unique value in the middle of a run", async () => {
    const before = await count("customers");
    const reply = await batch(tokens.user, [
      customer("d1"),
      customer("d2"),
      customer("d3"),
      customer("d2"),
      customer("d5"),
    ]);
    expect(reply.status).toBe(400);
    expect(reply.body).toMatchObject({
      message: expect.stringMatching(/^Request 4 of the batch failed/),
      data: { requests: { 3: { name: { code: "validation_not_unique" } } } },
    });
    expect(await count("customers")).toBe(before);
  });

  it("creates a record pointing at one created earlier in the batch", async () => {
    const parent = "parent000000000";
    const reply = await batch(tokens.user, [
      { url: "/collections/categories/records", body: { id: parent } },
      {
        url: "/collections/categories/records",
        body: { parent },
      },
    ]);
    expect(reply.status).toBe(200);
    const [, child] = reply.body as unknown as Reply[];
    expect(child?.body.parent).toBe(parent);
  });
});

describe("splitting creates into runs", () => {
  const principal: Principal = { superuser: false };
  const plan = (
    collection: { id: string; createRule?: string; viewRule?: string },
    input: Record<string, unknown>,
    query = "",
  ): PlannedCreate =>
    ({
      ctx: { principal },
      collection: { createRule: "", viewRule: "", ...collection },
      input,
      query: new URLSearchParams(query),
      passwordHash: undefined,
      newFiles: undefined,
    }) as unknown as PlannedCreate;
  const sizes = (plans: PlannedCreate[]) =>
    createRuns(plans).map((run) => run.length);

  it("keeps consecutive creates of one collection and query together", () => {
    const a = { id: "a" };
    expect(
      sizes([plan(a, { id: "1" }), plan(a, { id: "2" }), plan(a, { id: "3" })]),
    ).toEqual([3]);
    expect(
      sizes([
        plan(a, { id: "1" }),
        plan({ id: "b" }, { id: "2" }),
        plan(a, { id: "3" }, "expand=x"),
        plan(a, { id: "4" }, "expand=x"),
      ]),
    ).toEqual([1, 1, 2]);
  });

  it("starts a new run at a create pointing at one earlier in the run", () => {
    const a = { id: "a" };
    expect(
      sizes([
        plan(a, { id: "1" }),
        plan(a, { id: "2", parent: "1" }),
        plan(a, { id: "3", tags: ["x", "2"] }),
      ]),
    ).toEqual([1, 1, 1]);
  });
});
