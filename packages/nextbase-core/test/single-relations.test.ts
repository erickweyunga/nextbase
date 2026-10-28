import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextBase } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "./postgres.ts";

describe("filters through a single relation", () => {
  let t: TestDatabase;
  let nextbase: NextBase;

  const titles = async (filter: string): Promise<string[]> => {
    const list = await nextbase
      .client()
      .collection("books")
      .getList(1, 30, { filter, sort: "title" });
    return list.items.map((book) => book.title as string);
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    nextbase = new NextBase({ database: t.pool });
    const admin = nextbase.client({ superuser: true });
    const authors = await admin.collections.create({
      name: "authors",
      viewRule: "hidden = false",
      fields: [
        { name: "name", type: "text" },
        { name: "hidden", type: "bool" },
      ],
    });
    await admin.collections.create({
      name: "books",
      listRule: "",
      fields: [
        { name: "title", type: "text" },
        { name: "author", type: "relation", collectionId: authors.id },
      ],
    });
    const author = async (name: string, hidden = false) =>
      (await admin.collection("authors").create({ name, hidden }))?.id;
    const books = {
      ann: await author("Ann"),
      bob: await author("Bob", true),
      cara: await author("Cara"),
      blank: await author(""),
    };
    for (const [title, id] of Object.entries(books)) {
      await admin.collection("books").create({ title, author: id });
    }
    await admin.collection("books").create({ title: "none" });
  });

  afterAll(() => t.close());

  // A book matches only through an author the caller may view, so `bob`
  // (hidden) and `none` (no author) match neither `=` nor `!=`.
  it("matches only books whose one author satisfies the condition", async () => {
    expect(await titles('author.name = "Ann"')).toEqual(["ann"]);
    expect(await titles('author.name != "Ann"')).toEqual(["blank", "cara"]);
    expect(await titles('author.name ?= "Ann"')).toEqual(["ann"]);
    expect(await titles('author.name = ""')).toEqual(["blank"]);
    expect(await titles('author.name ~ "a"')).toEqual(["ann", "cara"]);
  });
});
