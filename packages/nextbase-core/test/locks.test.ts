import { afterAll, beforeAll, expect, it } from "vitest";
import { NextBase } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "./postgres.ts";

let t: TestDatabase;
let nextbase: NextBase;

beforeAll(async () => {
  t = await createTestDatabase();
  nextbase = new NextBase({ database: t.pool });
});

afterAll(() => t.close());

it("updates a record while another request creates a record that references it", async () => {
  const admin = nextbase.client({ superuser: true });
  const posts = await admin.collections.create({
    name: "posts",
    fields: [{ name: "title", type: "text" }],
  });
  await admin.collections.create({
    name: "comments",
    fields: [{ name: "post", type: "relation", collectionId: posts.id }],
  });
  const post = await admin.collection("posts").create({ title: "draft" });

  // Creating a comment holds this lock on its post until it commits.
  const client = await t.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT id FROM nextbase.posts WHERE id = $1 FOR KEY SHARE",
      [post?.id],
    );
    const update = admin
      .collection("posts")
      .update(post?.id ?? "", { title: "final" });
    const waited = new Promise((resolve) =>
      setTimeout(() => resolve("blocked"), 2_000),
    );
    const updated = await Promise.race([update, waited]);
    expect(updated).toMatchObject({ title: "final" });
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
