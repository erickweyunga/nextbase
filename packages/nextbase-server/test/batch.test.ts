import { ClientError, type NextBaseClient } from "@nextbasejs/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextBase } from "../src/index.ts";
import { call } from "./http.ts";
import { createTestDatabase, type TestDatabase } from "./postgres.ts";

describe("batch API", () => {
  let t: TestDatabase;
  let nextbase: NextBase;
  let admin: NextBaseClient;
  let ann: NextBaseClient;
  let bob: NextBaseClient;

  const count = async (collection: string): Promise<number> =>
    (await admin.collection(collection).getList(1, 1)).totalItems;
  const failure = async (promise: Promise<unknown>): Promise<ClientError> => {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClientError);
    return error as ClientError;
  };
  const newId = (): string =>
    Array.from(
      { length: 15 },
      () =>
        "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)],
    ).join("");

  beforeAll(async () => {
    t = await createTestDatabase();
    nextbase = new NextBase({ database: t.pool });
    admin = nextbase.client({ superuser: true });
    const users = await admin.collections.create({
      name: "users",
      type: "auth",
      createRule: "",
      viewRule: "",
    });
    const orders = await admin.collections.create({
      name: "orders",
      listRule: "owner = @request.auth.id",
      viewRule: "owner = @request.auth.id",
      createRule: "owner = @request.auth.id",
      updateRule: "owner = @request.auth.id",
      deleteRule: "owner = @request.auth.id",
      fields: [
        { id: "ordercode0", name: "code", type: "text", required: true },
        {
          name: "owner",
          type: "relation",
          collectionId: users.id,
          maxSelect: 1,
        },
      ],
      indexes: [{ name: "orders_code", unique: true, fields: ["ordercode0"] }],
    });
    await admin.collections.create({
      name: "items",
      listRule: "order.owner = @request.auth.id",
      viewRule: "order.owner = @request.auth.id",
      createRule: "order.owner = @request.auth.id",
      updateRule: "order.owner = @request.auth.id",
      deleteRule: "order.owner = @request.auth.id",
      fields: [
        {
          name: "order",
          type: "relation",
          collectionId: orders.id,
          maxSelect: 1,
          required: true,
          cascadeDelete: true,
        },
        { name: "sku", type: "text", required: true },
        { name: "quantity", type: "number", min: 1, onlyInt: true },
      ],
    });
    const signUp = async (name: string): Promise<NextBaseClient> => {
      const nb = nextbase.client();
      await nb.collection("users").create({
        email: `${name}@example.com`,
        password: "password 123 456",
        passwordConfirm: "password 123 456",
      });
      await nb
        .collection("users")
        .signInWithPassword(`${name}@example.com`, "password 123 456");
      return nb;
    };
    ann = await signUp("ann");
    bob = await signUp("bob");
  });
  afterAll(() => t.close());

  it("creates an order and its items together", async () => {
    const order = newId();
    const owner = ann.authStore.record?.id;
    const batch = ann.createBatch();
    batch.collection("orders").create({ id: order, code: "A-1", owner });
    for (const sku of ["apple", "pear", "plum"]) {
      batch
        .collection("items")
        .create(
          { order, sku, quantity: 2 },
          { expand: "order", fields: "sku,expand.order.code" },
        );
    }
    const results = await batch.send();
    expect(results).toHaveLength(4);
    expect(results[0]).toMatchObject({
      status: 200,
      body: { id: order, code: "A-1" },
    });
    expect(results[1]).toEqual({
      status: 200,
      body: { sku: "apple", expand: { order: { code: "A-1" } } },
    });
    expect(await count("items")).toBe(3);

    // Updates and deletes mix too; deleting the order cascades to its items.
    const items = await ann.collection("items").getFullList({ sort: "sku" });
    const mixed = await ann
      .createBatch()
      .collection("items")
      .update(items[0]?.id as string, { "quantity+": 3 })
      .collection("items")
      .delete(items[1]?.id as string)
      .send();
    expect(mixed).toEqual([
      expect.objectContaining({
        status: 200,
        body: expect.objectContaining({ quantity: 5 }),
      }),
      { status: 204 },
    ]);
    await ann.createBatch().collection("orders").delete(order).send();
    expect(await count("orders")).toBe(0);
    expect(await count("items")).toBe(0);
  });

  it("saves nothing when any write fails, and names that write", async () => {
    const order = newId();
    const owner = ann.authStore.record?.id;
    const batch = ann.createBatch();
    batch.collection("orders").create({ id: order, code: "B-1", owner });
    batch.collection("items").create({ order, sku: "apple", quantity: 1 });
    batch.collection("items").create({ order, sku: "", quantity: 0 });
    const error = await failure(batch.send());
    expect(error.status).toBe(400);
    expect(error.message).toMatch(
      /^Request 3 of the batch failed with 400: .* Nothing was saved\.$/,
    );
    expect(error.data).toEqual({
      requests: {
        2: {
          sku: { code: "validation_required", message: expect.any(String) },
          quantity: expect.objectContaining({ code: expect.any(String) }),
        },
      },
    });
    expect(await count("orders")).toBe(0);
    expect(await count("items")).toBe(0);
  });

  it("rolls back on a unique violation within the batch", async () => {
    const owner = ann.authStore.record?.id;
    const batch = ann.createBatch();
    batch.collection("orders").create({ code: "DUP", owner });
    batch.collection("orders").create({ code: "DUP", owner });
    const error = await failure(batch.send());
    expect(error.data).toEqual({
      requests: {
        1: {
          code: { code: "validation_not_unique", message: "Must be unique." },
        },
      },
    });
    expect(await count("orders")).toBe(0);
  });

  it("applies every write's rules as the caller, including on records the batch created", async () => {
    const order = newId();
    await ann
      .createBatch()
      .collection("orders")
      .create({ id: order, code: "C-1", owner: ann.authStore.record?.id })
      .send();

    // Bob cannot add to Ann's order, nor create one for her.
    const batch = bob.createBatch();
    batch
      .collection("orders")
      .create({ code: "C-2", owner: bob.authStore.record?.id });
    batch.collection("items").create({ order, sku: "x", quantity: 1 });
    const error = await failure(batch.send());
    expect(error.message).toMatch(/^Request 2 of the batch failed with 400/);
    const update = await failure(
      bob
        .createBatch()
        .collection("orders")
        .update(order, { code: "mine" })
        .send(),
    );
    expect(update.message).toMatch(/failed with 404: Record not found/);
    expect(await count("orders")).toBe(1);

    // A later write sees an earlier one: the new order passes the items' rule.
    const own = newId();
    const results = await bob
      .createBatch()
      .collection("orders")
      .create({ id: own, code: "C-3", owner: bob.authStore.record?.id })
      .collection("items")
      .create({ order: own, sku: "y", quantity: 1 })
      .send()
      .catch((e: unknown) => e);
    expect(results).toHaveLength(2);
  });

  it("rejects malformed batches before writing anything", async () => {
    const batch = async (body: unknown) =>
      call(nextbase, "POST", "/batch", { body, token: ann.authStore.token });
    const requests = (reply: { body: Record<string, unknown> }) =>
      (reply.body.data as Record<string, unknown>).requests;

    for (const body of [
      {},
      { requests: [] },
      { requests: "x" },
      {
        requests: Array(51).fill({
          method: "DELETE",
          url: "/collections/orders/records/x",
        }),
      },
    ]) {
      const reply = await batch(body);
      expect(reply.status).toBe(400);
      expect(requests(reply)).toMatchObject({ code: "validation_invalid" });
    }
    const cases: [unknown, RegExp][] = [
      [null, /object/],
      [{ method: "GET", url: "/collections/orders/records" }, /method/],
      [{ method: "POST", url: "collections/orders/records" }, /url/],
      [{ method: "POST", url: "/collections" }, /POST creates records/],
      [
        { method: "PATCH", url: "/collections/orders/records" },
        /needs a record/,
      ],
      [{ method: "DELETE", url: "/setup" }, /needs a record/],
      [
        { method: "POST", url: "/collections/orders/records", body: [] },
        /body/,
      ],
    ];
    for (const [request, message] of cases) {
      const reply = await batch({
        requests: [
          {
            method: "POST",
            url: "/collections/orders/records",
            body: { code: "never" },
          },
          request,
        ],
      });
      expect(reply.status).toBe(400);
      expect(
        (requests(reply) as Record<string, { message: string }>)[1]?.message,
      ).toMatch(message);
    }
    const unknown = await batch({
      requests: [
        { method: "POST", url: "/collections/nope/records", body: {} },
      ],
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.message).toMatch(/failed with 404/);
    expect(await count("orders")).toBe(2);
  });
});
