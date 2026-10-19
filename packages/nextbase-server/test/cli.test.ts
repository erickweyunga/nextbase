import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NextBaseClient,
  type RecordModel,
  type RecordService,
} from "@nextbase/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Io, run } from "../src/cli/run.ts";
import { NextBase } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "./postgres.ts";

describe("nextbase CLI", () => {
  let t: TestDatabase;
  let dir: string;

  /** Runs a command; `answers` are what the prompts receive, in order. */
  const cli = async (
    argv: string[],
    {
      env = {},
      answers = [],
    }: { env?: Record<string, string>; answers?: string[] } = {},
  ) => {
    const out: string[] = [];
    const err: string[] = [];
    const prompts: { question: string; hidden: boolean }[] = [];
    const io: Io = {
      env: { DATABASE_URL: t.url, ...env },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      prompt: async (question, hidden) => {
        prompts.push({ question, hidden });
        return answers.shift() ?? "";
      },
    };
    const code = await run(argv, io);
    return { code, out: out.join("\n"), err: err.join("\n"), prompts };
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    dir = await mkdtemp(join(tmpdir(), "nextbase-cli-"));
  });
  afterAll(async () => {
    await t.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("prints help, and rejects unknown commands and options", async () => {
    expect((await cli([])).out).toContain("Usage: nextbase <command>");
    expect((await cli(["help"])).code).toBe(0);
    const unknown = await cli(["destroy"]);
    expect(unknown).toMatchObject({ code: 2 });
    expect(unknown.err).toContain("Unknown command: destroy");
    expect((await cli(["migrate", "--force"])).code).toBe(2);
  });

  it("needs a database", async () => {
    const result = await cli(["migrate"], { env: { DATABASE_URL: "" } });
    expect(result).toMatchObject({ code: 1 });
    expect(result.err).toContain("No database");
  });

  it("migrates", async () => {
    const result = await cli(["migrate"]);
    expect(result).toMatchObject({
      code: 0,
      out: "NextBase's tables are up to date.",
    });
    expect(
      await t.db.select("name").from("nextbase._migrations").column(),
    ).toContain("0001_init");
  });

  it("adds a superuser, asking for the password twice without echoing it", async () => {
    const added = await cli(["superuser", "--email", "root@example.com"], {
      answers: ["a long secret password", "a long secret password"],
    });
    expect(added).toMatchObject({
      code: 0,
      out: "Added the superuser root@example.com.",
    });
    expect(added.prompts.every((p) => p.hidden)).toBe(true);
    const nb = new NextBase({ database: t.pool }).client();
    await nb
      .collection("_superusers")
      .signInWithPassword("root@example.com", "a long secret password");
    expect(nb.authStore.isSuperuser).toBe(true);

    const mismatch = await cli(["superuser", "--email", "b@example.com"], {
      answers: ["a long secret password", "another long password"],
    });
    expect(mismatch).toMatchObject({
      code: 1,
      err: "The passwords do not match.",
    });

    // Scripts pass the password in the environment; problems name the field.
    const weak = await cli(["superuser", "--email", "c@example.com"], {
      env: { NEXTBASE_SUPERUSER_PASSWORD: "short" },
    });
    expect(weak.code).toBe(1);
    expect(weak.err).toMatch(/password: Must be 15 to/);
    expect((await cli(["superuser"])).code).toBe(2);
  });

  it("writes types for every collection", async () => {
    const admin = new NextBase({ database: t.pool }).client({
      superuser: true,
    });
    const users = await admin.collections.create({
      name: "users",
      type: "auth",
      fields: [{ name: "name", type: "text" }],
    });
    await admin.collections.create({
      name: "blog_posts",
      fields: [
        { name: "title", type: "text" },
        { name: "views", type: "number" },
        { name: "published", type: "bool" },
        { name: "tags", type: "select", values: ["a", "b"], maxSelect: 2 },
        {
          name: "author",
          type: "relation",
          collectionId: users.id,
          maxSelect: 1,
        },
        { name: "meta", type: "json" },
        { name: "secret", type: "text", hidden: true },
        { name: "created", type: "autodate" },
      ],
    });
    const file = join(dir, "types.ts");
    const result = await cli(["typegen", "--out", file]);
    expect(result).toMatchObject({ code: 0 });
    expect(result.out).toBe(`Wrote types for 3 collections to ${file}.`);
    const types = await readFile(file, "utf8");
    expect(types).toContain(
      [
        "export interface BlogPostsRecord extends RecordModel {",
        "  id: string;",
        "  title: string;",
        "  views: number;",
        "  published: boolean;",
        "  tags: string[];",
        "  author: string;",
        "  meta: unknown;",
        "  created: string;",
        "}",
      ].join("\n"),
    );
    // Password hashes and token keys are hidden, so never typed.
    expect(types).toMatch(
      /interface UsersRecord extends RecordModel \{\n {2}id: string;\n {2}email: string;\n {2}emailVisibility: boolean;\n {2}verified: boolean;\n {2}name: string;/,
    );
    expect(types).not.toMatch(/password|tokenKey|secret/);
    expect(types).toContain(
      "export type Collections = {\n  _superusers: SuperusersRecord;\n  users: UsersRecord;\n  blog_posts: BlogPostsRecord;\n};",
    );
  });

  it("types collections in the SDK from a Collections type", () => {
    interface PostsRecord extends RecordModel {
      title: string;
    }
    type Collections = { posts: PostsRecord };
    const nb = new NextBaseClient<Collections>();
    // Compile-time checks: the name picks the type; others fall back.
    const posts: RecordService<PostsRecord> = nb.collection("posts");
    const other: RecordService<RecordModel> = nb.collection("anything");
    const explicit: RecordService<PostsRecord> =
      nb.collection<PostsRecord>("legacy");
    expect([posts, other, explicit]).toHaveLength(3);
  });
});
