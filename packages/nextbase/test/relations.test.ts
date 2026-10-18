import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextBase } from "../src/server/index.ts";
import { call, type Reply } from "./http.ts";
import { createTestDatabase, type TestDatabase } from "./postgres.ts";

describe("@collection, back-relations and JSON over real data", () => {
  let t: TestDatabase;
  let nextbase: NextBase;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};

  const as = (
    who: string | undefined,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Reply> =>
    call(nextbase, method, path, {
      token: who ? tokens[who] : undefined,
      body,
    });
  const names = async (
    who: string | undefined,
    collection: string,
    filter = "",
  ): Promise<unknown[]> => {
    const query = filter
      ? `?sort=name&filter=${encodeURIComponent(filter)}`
      : "?sort=name";
    const reply = await as(
      who,
      "GET",
      `/collections/${collection}/records${query}`,
    );
    expect(reply.status).toBe(200);
    return (reply.body.items as { name: unknown }[]).map((r) => r.name);
  };
  const add = async (
    collection: string,
    body: Record<string, unknown>,
  ): Promise<string> => {
    const reply = await as(
      "admin",
      "POST",
      `/collections/${collection}/records`,
      body,
    );
    expect(reply.status).toBe(200);
    return reply.body.id as string;
  };
  const newCollection = async (
    body: Record<string, unknown>,
  ): Promise<string> => {
    const reply = await as("admin", "POST", "/collections", body);
    expect(reply.status).toBe(200);
    return reply.body.id as string;
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    nextbase = new NextBase({ database: t.pool });
    await nextbase.createSuperuser("admin@example.com", "admin password");
    const login = async (
      collection: string,
      identity: string,
      password: string,
    ): Promise<string> =>
      (
        await call(
          nextbase,
          "POST",
          `/collections/${collection}/auth-with-password`,
          { body: { identity, password } },
        )
      ).body.token as string;
    tokens.admin = await login(
      "_superusers",
      "admin@example.com",
      "admin password",
    );

    ids.users = await newCollection({
      name: "users",
      type: "auth",
      listRule: "",
      viewRule: "",
      createRule: "",
    });
    ids.teams = await newCollection({
      name: "teams",
      listRule: "",
      viewRule: "",
      fields: [{ name: "name", type: "text" }],
    });
    await newCollection({
      name: "members",
      fields: [
        { name: "user", type: "relation", collectionId: ids.users },
        { name: "team", type: "relation", collectionId: ids.teams },
      ],
    });
    const membership =
      "@collection.members.user = @request.auth.id && @collection.members.team = team";
    ids.projects = await newCollection({
      name: "projects",
      listRule: membership,
      viewRule: membership,
      fields: [
        { name: "name", type: "text" },
        { name: "team", type: "relation", collectionId: ids.teams },
        { name: "meta", type: "json" },
      ],
    });
    await newCollection({
      name: "notes",
      listRule: "",
      viewRule: "",
      fields: [
        { name: "text", type: "text" },
        { name: "project", type: "relation", collectionId: ids.projects },
      ],
    });

    for (const name of ["ann", "bob"]) {
      ids[name] = await add("users", {
        email: `${name}@example.com`,
        password: "password123",
        passwordConfirm: "password123",
      });
      tokens[name] = await login("users", `${name}@example.com`, "password123");
    }
    ids.red = await add("teams", { name: "red" });
    ids.blue = await add("teams", { name: "blue" });
    await add("members", { user: ids.ann, team: ids.red });
    await add("members", { user: ids.bob, team: ids.blue });
    ids.apollo = await add("projects", {
      name: "apollo",
      team: ids.red,
      meta: {
        stage: "beta",
        budget: 5000,
        tags: ["x"],
        flags: { public: true },
      },
    });
    ids.gemini = await add("projects", {
      name: "gemini",
      team: ids.blue,
      meta: { stage: "alpha", budget: 100 },
    });
    await add("notes", { text: "ship it", project: ids.apollo });
    await add("notes", { text: "tests pass", project: ids.apollo });
  });
  afterAll(() => t.close());

  it("@collection rules match one row satisfying every condition on it", async () => {
    expect(await names("ann", "projects")).toEqual(["apollo"]);
    expect(await names("bob", "projects")).toEqual(["gemini"]);
    expect(await names(undefined, "projects")).toEqual([]);
    expect(
      (await as("bob", "GET", `/collections/projects/records/${ids.apollo}`))
        .status,
    ).toBe(404);
  });

  it("aliases give separate rows of the same collection", async () => {
    // Ann is a member of some team, and some member row has the project's team.
    await as("admin", "PATCH", "/collections/projects", {
      listRule:
        "@collection.members:a.user = @request.auth.id && @collection.members:b.team = team",
    });
    expect(await names("ann", "projects")).toEqual(["apollo", "gemini"]);
    await as("admin", "PATCH", "/collections/projects", {
      listRule:
        "@collection.members.user = @request.auth.id && @collection.members.team = team",
    });
  });

  it("filters and counts through back-relations, within what the caller may view", async () => {
    expect(
      await names("admin", "projects", "notes_via_project:length >= 2"),
    ).toEqual(["apollo"]);
    expect(
      await names("ann", "projects", 'notes_via_project.text ?~ "ship"'),
    ).toEqual(["apollo"]);
    expect(
      await names("admin", "teams", "members_via_team:length > 0"),
    ).toEqual(["blue", "red"]);
    // members has a null view rule: Bob's filter cannot see or count them.
    expect(await names("bob", "teams", "members_via_team:length > 0")).toEqual(
      [],
    );
  });

  it("expands back-relations the caller may view", async () => {
    const project = await as(
      "ann",
      "GET",
      `/collections/projects/records/${ids.apollo}?expand=notes_via_project`,
    );
    const notes = (
      project.body.expand as { notes_via_project: { text: string }[] }
    ).notes_via_project;
    expect(notes.map((n) => n.text).sort()).toEqual(["ship it", "tests pass"]);
    const team = await as(
      "bob",
      "GET",
      `/collections/teams/records/${ids.red}?expand=members_via_team`,
    );
    expect(team.body).not.toHaveProperty("expand");
    const asAdmin = await as(
      "admin",
      "GET",
      `/collections/teams/records/${ids.red}?expand=members_via_team.user`,
    );
    expect(asAdmin.body.expand).toMatchObject({
      members_via_team: [{ user: ids.ann, expand: { user: { id: ids.ann } } }],
    });
  });

  it("filters JSON values by key, by type", async () => {
    expect(await names("admin", "projects", "meta.budget > 1000")).toEqual([
      "apollo",
    ]);
    expect(await names("admin", "projects", 'meta.stage = "alpha"')).toEqual([
      "gemini",
    ]);
    expect(await names("admin", "projects", 'meta.stage ~ "BET"')).toEqual([
      "apollo",
    ]);
    expect(
      await names("admin", "projects", "meta.flags.public = true"),
    ).toEqual(["apollo"]);
    expect(await names("admin", "projects", 'meta.tags.0 = "x"')).toEqual([
      "apollo",
    ]);
    expect(await names("admin", "projects", 'meta.flags = ""')).toEqual([
      "gemini",
    ]);
    // A string compared as a number is not a number: no match, no error.
    expect(await names("admin", "projects", "meta.stage > 1")).toEqual([]);
  });

  it("validates @collection references when rules are saved", async () => {
    const reply = await as("admin", "PATCH", "/collections/projects", {
      viewRule: "@collection.nope.x = 1",
    });
    expect(reply).toMatchObject({
      status: 400,
      body: { data: { viewRule: { code: "validation_invalid_rule" } } },
    });
  });
});
