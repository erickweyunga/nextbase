import {
  ClientError,
  NextBaseClient,
  type RecordModel,
} from "@nextbasejs/client";
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

async function homePage(cookie?: string): Promise<string> {
  return (
    await fetch(new URL("/", server.api), {
      headers: cookie ? { cookie } : {},
    })
  ).text();
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
    password: "admin password 123",
  });
  await admin
    .collection("_superusers")
    .signInWithPassword("admin@example.com", "admin password 123");
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
  // One request: creates the account and signs it in.
  const signedUp = await nb.collection("users").signUp({
    email,
    name,
    password: "password 123 456",
    passwordConfirm: "password 123 456",
  });
  expect(signedUp?.record.email).toBe(email);
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
    const { token } = await cy.collection("users").refreshSession();
    expect(cy.authStore.token).toBe(token);

    // A second device signs in too; a password change signs it out.
    const phone = client();
    await phone
      .collection("users")
      .signInWithPassword("cy@example.com", "password 123 456");
    await cy.collection("users").update(me.id, {
      oldPassword: "password 123 456",
      password: "password 456 789",
      passwordConfirm: "password 456 789",
    });
    await expect(phone.collection("users").getOne(me.id)).rejects.toMatchObject(
      {
        status: 401,
      },
    );
    expect(phone.authStore.isValid).toBe(false);
    expect((await cy.getSession())?.record.id).toBe(me.id);
    expect(seen).toEqual(["Cy", "Cy", "Cy", "Cy"]);
  });

  it("signs in with an HttpOnly cookie that server components read", async () => {
    await signUp("dan");
    const { origin } = new URL(server.api);
    const login = await fetch(
      `${server.api}/collections/users/auth-with-password`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          identity: "dan@example.com",
          password: "password 123 456",
          cookie: true,
        }),
      },
    );
    expect(login.status).toBe(200);
    expect(((await login.json()) as { token?: string }).token).toBeUndefined();
    const setCookie = login.headers.get("set-cookie") ?? "";
    // `next start` runs in production mode: the cookie is Secure and
    // __Host- prefixed.
    expect(setCookie).toMatch(/HttpOnly; SameSite=Lax; Secure$/);
    const cookie = setCookie.split(";")[0] as string;

    expect(await homePage(cookie)).toContain("Signed in as dan@example.com.");
    // The layout seeds useSession() in client components from the server.
    expect(await homePage(cookie)).toContain("Badge: dan@example.com");
    expect(await homePage()).toContain("Badge: guest");
    expect(await homePage()).toContain("Not signed in.");

    const me = (await (
      await fetch(`${server.api}/session`, { headers: { cookie } })
    ).json()) as { record: { id: string } };
    const rename = (headers: Record<string, string>) =>
      fetch(`${server.api}/collections/users/records/${me.record.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie, ...headers },
        body: JSON.stringify({ name: "Dan" }),
      });
    expect((await rename({ origin: "https://evil.example" })).status).toBe(403);
    expect((await rename({ origin })).status).toBe(200);

    const signOut = await fetch(`${server.api}/session`, {
      method: "DELETE",
      headers: { cookie, origin },
    });
    expect(signOut.status).toBe(204);
    // Production: the __Host- prefixed name.
    expect(signOut.headers.get("set-cookie")).toMatch(
      /^__Host-nextbase_session=; Path=\/; Max-Age=0;/,
    );
    expect(await homePage(cookie)).toContain("Not signed in.");
  });

  it("redirects signed-out visitors away from protected pages in proxy.ts", async () => {
    await signUp("eve");
    const { origin } = new URL(server.api);
    const dashboard = (cookie?: string) =>
      fetch(new URL("/dashboard", server.api), {
        redirect: "manual",
        headers: cookie ? { cookie } : {},
      });

    const anonymous = await dashboard();
    expect(anonymous.status).toBe(307);
    // Next.js writes same-origin redirects as relative locations.
    expect(anonymous.headers.get("location")).toBe(
      "/sign-in?next=%2Fdashboard",
    );

    const login = await fetch(
      `${server.api}/collections/users/auth-with-password`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          identity: "eve@example.com",
          password: "password 123 456",
          cookie: true,
        }),
      },
    );
    const cookie = (login.headers.get("set-cookie") ?? "").split(
      ";",
    )[0] as string;
    const signedIn = await dashboard(cookie);
    expect(signedIn.status).toBe(200);
    expect(await signedIn.text()).toContain("Welcome, <!-- -->eve@example.com");

    // The proxy checks the session itself, not just that a cookie exists.
    await fetch(`${server.api}/session`, {
      method: "DELETE",
      headers: { cookie, origin },
    });
    expect((await dashboard(cookie)).status).toBe(307);
    expect((await dashboard("__Host-nextbase_session=made-up")).status).toBe(
      307,
    );
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
