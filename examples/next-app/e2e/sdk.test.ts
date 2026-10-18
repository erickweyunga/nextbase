import {
  ClientError,
  NextBaseClient,
  type RecordModel,
} from "@nextbase/nextbase/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Server, startServer } from "./server.ts";

// An app's frontend code, written against the client SDK and talking to the
// built app over HTTP.

interface Recipe extends RecordModel {
  title: string;
  author: string;
  servings: number;
  tags: string[];
}

let server: Server;
let admin: NextBaseClient;

const client = (): NextBaseClient =>
  new NextBaseClient({ baseUrl: server.api });

async function setupToken(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const token = /"token":"([^"]+)"/.exec(server.output())?.[1];
    if (token) return token;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("No setup token in the server log.");
}

async function homePage(): Promise<string> {
  return (await fetch(new URL("/", server.api))).text();
}

beforeAll(async () => {
  server = await startServer();
  admin = client();

  // The home page is a server component reading through `nextbase.client()`.
  expect(await homePage()).toContain("Setup required");
  expect(await admin.setupStatus()).toEqual({ required: true });
  await admin.setup({
    token: await setupToken(),
    email: "admin@example.com",
    password: "admin password",
  });
  await admin
    .collection("_superusers")
    .authWithPassword("admin@example.com", "admin password");
  expect(admin.authStore.isSuperuser).toBe(true);
  expect(await homePage()).toContain("Ready.");

  const users = await admin.collections.create({
    name: "users",
    type: "auth",
    listRule: "",
    viewRule: "",
    createRule: "",
    updateRule: "id = @request.auth.id",
    fields: [{ name: "name", type: "text", required: true }],
  });
  await admin.collections.create({
    name: "recipes",
    listRule: "",
    viewRule: "",
    createRule: "author = @request.auth.id",
    updateRule: "author = @request.auth.id",
    deleteRule: "author = @request.auth.id",
    fields: [
      { name: "title", type: "text", required: true },
      {
        name: "author",
        type: "relation",
        collectionId: users.id,
        maxSelect: 1,
      },
      { name: "servings", type: "number", min: 1 },
      {
        name: "tags",
        type: "select",
        values: ["vegan", "quick", "dessert"],
        maxSelect: 3,
      },
    ],
  });
});

afterAll(() => server?.stop());

async function signUp(name: string): Promise<NextBaseClient> {
  const nb = client();
  const email = `${name}@example.com`;
  await nb.collection("users").create({
    email,
    name,
    password: "password 123",
    passwordConfirm: "password 123",
  });
  await nb.collection("users").authWithPassword(email, "password 123");
  return nb;
}

describe("a recipe app on the SDK", () => {
  let ana: NextBaseClient;
  let ben: NextBaseClient;

  beforeAll(async () => {
    ana = await signUp("ana");
    ben = await signUp("ben");
  });

  it("creates records and reads them back with expand and fields", async () => {
    const recipes = ana.collection<Recipe>("recipes");
    const author = ana.authStore.record?.id as string;
    const created = await recipes.create({
      title: 'Grandma\'s "best" pie \\ v2',
      author,
      servings: 8,
      tags: ["dessert"],
    });
    expect(created).toMatchObject({ servings: 8, tags: ["dessert"] });

    const page = await client()
      .collection<Recipe>("recipes")
      .getList(1, 10, {
        filter: ana.filter("title = {:title} && servings >= {:min}", {
          title: 'Grandma\'s "best" pie \\ v2',
          min: 2,
        }),
        expand: "author",
        fields: "id,title,expand.author.name",
      });
    expect(page.totalItems).toBe(1);
    expect(page.items[0]).toEqual({
      id: created?.id,
      title: 'Grandma\'s "best" pie \\ v2',
      expand: { author: { name: "ana" } },
    });
  });

  it("pages through everything and finds single records", async () => {
    const recipes = ben.collection<Recipe>("recipes");
    const author = ben.authStore.record?.id as string;
    for (let i = 1; i <= 25; i++) {
      await recipes.create({
        title: `Quick dish ${i}`,
        author,
        servings: i,
        tags: i % 2 ? ["quick", "vegan"] : ["quick"],
      });
    }
    const all = await client()
      .collection<Recipe>("recipes")
      .getFullList({
        batch: 10,
        filter: ben.filter("author = {:me}", { me: author }),
        sort: "servings",
      });
    expect(all.map((r) => r.servings)).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1),
    );
    const vegan = await recipes.getList(1, 100, {
      filter: 'tags ?= "vegan" && title ~ "dish"',
      skipTotal: true,
    });
    expect(vegan.items).toHaveLength(13);
    expect(vegan.totalItems).toBe(-1);

    const twelve = await recipes.getFirstListItem("servings = 12");
    expect(twelve.title).toBe("Quick dish 12");
    await expect(
      recipes.getFirstListItem("servings = 99"),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it("enforces rules and reports field errors through ClientError", async () => {
    const mine = await ana
      .collection<Recipe>("recipes")
      .getFirstListItem(
        ana.filter("author = {:me}", { me: ana.authStore.record?.id }),
      );

    const denied = await ben
      .collection("recipes")
      .update(mine.id, { title: "Mine now" })
      .catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(ClientError);
    expect((denied as ClientError).status).toBe(404);

    const invalid = await ana
      .collection("recipes")
      .update(mine.id, { servings: 0, tags: ["spicy"] })
      .catch((e: unknown) => e);
    expect((invalid as ClientError).status).toBe(400);
    expect(Object.keys((invalid as ClientError).data).sort()).toEqual([
      "servings",
      "tags",
    ]);

    const anonymous = await client()
      .collection("recipes")
      .create({ title: "Spam", author: mine.author })
      .catch((e: unknown) => e);
    expect((anonymous as ClientError).status).toBe(400);
  });

  it("keeps the signed-in user in sync and signs out when the token stops working", async () => {
    const cy = await signUp("cy");
    const me = cy.authStore.record as RecordModel;
    const seen: (string | undefined)[] = [];
    cy.authStore.onChange((_, record) =>
      seen.push(record?.name as string | undefined),
    );

    await cy.collection("users").update(me.id, { name: "Cy" });
    expect(cy.authStore.record?.name).toBe("Cy");
    const { token } = await cy.collection("users").authRefresh();
    expect(cy.authStore.token).toBe(token);

    // A second device keeps the old session; a password change revokes it.
    const phone = client();
    phone.authStore.save(cy.authStore.token, cy.authStore.record);
    await cy.collection("users").update(me.id, {
      oldPassword: "password 123",
      password: "password 456",
      passwordConfirm: "password 456",
    });
    await expect(phone.collection("users").getOne(me.id)).rejects.toMatchObject(
      {
        status: 401,
      },
    );
    expect(phone.authStore.isValid).toBe(false);
    expect(seen).toEqual(["Cy", "Cy", "Cy"]);
  });

  it("aborts requests through a signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await client()
      .collection("recipes")
      .getList(1, 1, { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 0, isAbort: true });
  });

  it("deletes a record and the server logged no errors", async () => {
    const recipe = await ana
      .collection<Recipe>("recipes")
      .getFirstListItem(
        ana.filter("author = {:me}", { me: ana.authStore.record?.id }),
      );
    await ana.collection("recipes").delete(recipe.id);
    await expect(
      client().collection("recipes").getOne(recipe.id),
    ).rejects.toMatchObject({
      status: 404,
    });
    expect(server.output()).not.toContain("request failed");
  });
});
