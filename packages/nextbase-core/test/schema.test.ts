import type { AuthCollection, Collection, ErrorData } from "@nextbasejs/client";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.ts";
import { LOWER_ALPHANUMERIC, randomString } from "../src/random.ts";
import {
  type CollectionContext,
  parseCollection,
  superusersCollection,
} from "../src/schema/collection.ts";
import { Issues } from "../src/schema/input.ts";

const none: CollectionContext = { others: [] };

/** Returns the validation errors of an invalid collection. */
function errorsOf(
  input: unknown,
  context: CollectionContext = none,
): ErrorData {
  try {
    parseCollection(input, context);
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    return (error as ApiError).data;
  }
  throw new Error("Expected the collection to be invalid.");
}

function fieldNames(collection: Collection): string[] {
  return collection.fields.map((f) => f.name);
}

describe("randomString", () => {
  it("draws only from the alphabet, at the requested length", () => {
    const value = randomString(1000, LOWER_ALPHANUMERIC);
    expect(value).toMatch(/^[a-z0-9]{1000}$/);
  });

  it("covers the whole alphabet", () => {
    const seen = new Set(randomString(5000, "abc"));
    expect([...seen].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("Issues", () => {
  it("nests errors by path and keeps the first at each path", () => {
    const issues = new Issues();
    issues.add(["fields", 2, "name"], "a", "first");
    issues.add(["fields", 2, "name"], "b", "second");
    issues.add(["name"], "c", "top");
    expect(issues.data).toEqual({
      fields: { 2: { name: { code: "a", message: "first" } } },
      name: { code: "c", message: "top" },
    });
  });

  it("records nothing below a path that already failed", () => {
    const issues = new Issues();
    issues.add(["fields"], "a", "not an array");
    issues.add(["fields", 0, "name"], "b", "ignored");
    expect(issues.data).toEqual({
      fields: { code: "a", message: "not an array" },
    });
  });
});

describe("creating collections", () => {
  it("fills in a base collection's defaults", () => {
    const posts = parseCollection({ name: "posts" }, none);
    expect(posts.id).toMatch(/^[a-z0-9]{15}$/);
    expect(posts.type).toBe("base");
    expect(fieldNames(posts)).toEqual(["id", "created", "updated"]);
    expect(posts.fields[0]).toMatchObject({ system: true, primaryKey: true });
    expect(posts.listRule).toBeNull();
    expect(posts.indexes).toEqual([]);
  });

  it("gives auth collections their system fields, identity and token secrets", () => {
    const users = parseCollection(
      { name: "users", type: "auth" },
      none,
    ) as AuthCollection;
    expect(fieldNames(users)).toEqual([
      "id",
      "email",
      "emailVisibility",
      "emailVerified",
      "phone",
      "phoneVerified",
      "password",
      "tokenKey",
      "created",
      "updated",
    ]);
    // Long passwords by default: at least 15 characters.
    expect(users.fields.find((f) => f.name === "password")).toMatchObject({
      hidden: true,
      min: 15,
    });
    expect(users.identityFields).toEqual(["email"]);
    expect(users.authRule).toBe("");
    expect(users.manageRule).toBeNull();
    expect(users.tokens.auth.duration).toBe(7 * 86_400);
    expect(users.tokens.auth.secret).toMatch(/^[A-Za-z0-9]{50}$/);
    expect(users.tokens.auth.secret).not.toBe(users.tokens.file.secret);
  });

  it("parses user fields with defaults and keeps system fields when left out", () => {
    const posts = parseCollection(
      {
        name: "posts",
        fields: [
          { name: "title", type: "text", required: true },
          { name: "tags", type: "select", values: ["a", "b"], maxSelect: 2 },
          { name: "cover", type: "file" },
        ],
      },
      none,
    );
    expect(fieldNames(posts)).toEqual(["id", "title", "tags", "cover"]);
    expect(posts.fields[1]).toMatchObject({
      type: "text",
      required: true,
      min: 0,
      max: 5000,
      pattern: "",
    });
    expect(posts.fields[1]?.id).toMatch(/^[a-z0-9]{10}$/);
    expect(posts.fields[3]).toMatchObject({
      maxSelect: 1,
      maxSize: 5 * 1024 * 1024,
      protected: false,
    });
  });

  it("rejects invalid, reserved and duplicate names", () => {
    expect(errorsOf({ name: "_private" })).toMatchObject({
      name: { code: "validation_invalid_name" },
    });
    expect(errorsOf({ name: "a".repeat(64) })).toMatchObject({
      name: { code: "validation_invalid_name" },
    });
    const posts = parseCollection({ name: "posts" }, none);
    expect(errorsOf({ name: "POSTS" }, { others: [posts] })).toMatchObject({
      name: { code: "validation_not_unique" },
    });
    expect(
      errorsOf({
        name: "things",
        fields: [
          { name: "xmin", type: "text" },
          { name: "expand", type: "text" },
          { name: "title", type: "text" },
          { name: "Title", type: "text" },
          { name: "ID", type: "text" },
        ],
      }),
    ).toMatchObject({
      fields: {
        0: { name: { code: "validation_reserved_name" } },
        1: { name: { code: "validation_reserved_name" } },
        3: { name: { code: "validation_not_unique" } },
        4: { name: { code: "validation_not_unique" } },
      },
    });
  });

  it("reports every problem at once", () => {
    const errors = errorsOf({
      name: "bad name",
      fields: [
        { name: "a", type: "nope" },
        { name: "b", type: "text", min: 10, max: 5 },
        { name: "c", type: "select", values: [] },
        { name: "d", type: "relation", collectionId: "missing" },
        { name: "e", type: "text", pattern: "(" },
        { name: "f", type: "password" },
        {
          name: "g",
          type: "email",
          onlyDomains: ["a.com"],
          exceptDomains: ["b.com"],
        },
      ],
    });
    expect(errors).toMatchObject({
      name: { code: "validation_invalid_name" },
      fields: {
        0: { type: { code: "validation_invalid_value" } },
        1: { min: { code: "validation_out_of_range" } },
        2: { values: { code: "validation_required" } },
        3: { collectionId: { code: "validation_invalid_value" } },
        4: { pattern: { code: "validation_invalid_value" } },
        5: { type: { code: "validation_invalid_value" } },
        6: { exceptDomains: { code: "validation_invalid_value" } },
      },
    });
  });

  it("allows relations to itself and to existing collections", () => {
    const users = parseCollection({ name: "users", type: "auth" }, none);
    const posts = parseCollection(
      {
        id: "posts0000000000",
        name: "posts",
        fields: [
          { name: "author", type: "relation", collectionId: users.id },
          { name: "parent", type: "relation", collectionId: "posts0000000000" },
        ],
      },
      { others: [users] },
    );
    expect(posts.fields.map((f) => f.type)).toEqual([
      "text",
      "relation",
      "relation",
    ]);
  });

  it("rejects malformed input types without throwing anything but ApiError", () => {
    expect(() => parseCollection("posts", none)).toThrow(ApiError);
    expect(errorsOf({ name: 1, fields: "x", indexes: {} })).toMatchObject({
      name: { code: "validation_invalid_type" },
      fields: { code: "validation_invalid_type" },
      indexes: { code: "validation_invalid_type" },
    });
  });
});

describe("indexes", () => {
  const withTitle = (indexes: unknown, others: Collection[] = []): ErrorData =>
    errorsOf(
      {
        name: "posts",
        fields: [{ id: "title00000", name: "title", type: "text" }],
        indexes,
      },
      { others },
    );

  it("accepts indexes on field ids", () => {
    const posts = parseCollection(
      {
        name: "posts",
        fields: [{ id: "title00000", name: "title", type: "text" }],
        indexes: [
          { name: "posts_title", unique: true, fields: ["title00000"] },
        ],
      },
      none,
    );
    expect(posts.indexes).toEqual([
      {
        name: "posts_title",
        unique: true,
        fields: ["title00000"],
        type: "btree",
      },
    ]);
  });

  it("accepts trigram indexes on text fields only, never unique", () => {
    expect(
      errorsOf({
        name: "posts",
        fields: [
          { id: "title00000", name: "title", type: "text" },
          { id: "views00000", name: "views", type: "number" },
        ],
        indexes: [
          { name: "a", type: "trigram", fields: ["views00000"] },
          { name: "b", type: "trigram", unique: true, fields: ["title00000"] },
          { name: "c", type: "hash", fields: ["title00000"] },
        ],
      }),
    ).toMatchObject({
      indexes: {
        0: { fields: { 0: { code: "validation_invalid_value" } } },
        1: { unique: { code: "validation_invalid_value" } },
        2: { type: { code: "validation_invalid_value" } },
      },
    });
  });

  it("rejects unknown fields and names taken anywhere in the Postgres namespace", () => {
    const users = parseCollection(
      {
        name: "users",
        fields: [{ id: "nick000000", name: "nick", type: "text" }],
        indexes: [{ name: "users_nick", fields: ["nick000000"] }],
      },
      none,
    );
    expect(
      withTitle(
        [
          { name: "a", fields: ["missing"] },
          { name: "users", fields: ["title00000"] },
          { name: "USERS_NICK", fields: ["title00000"] },
          { name: "posts", fields: ["title00000"] },
          { name: "b", fields: [] },
        ],
        [users],
      ),
    ).toMatchObject({
      indexes: {
        0: { fields: { 0: { code: "validation_invalid_value" } } },
        1: { name: { code: "validation_not_unique" } },
        2: { name: { code: "validation_not_unique" } },
        3: { name: { code: "validation_not_unique" } },
        4: { fields: { code: "validation_required" } },
      },
    });
    expect(errorsOf({ name: "users_nick" }, { others: [users] })).toMatchObject(
      {
        name: { code: "validation_not_unique" },
      },
    );
  });
});

describe("updating collections", () => {
  const posts = parseCollection(
    {
      name: "posts",
      fields: [
        { id: "title00000", name: "title", type: "text" },
        {
          id: "owner00000",
          name: "owner",
          type: "relation",
          collectionId: "_superusers",
        },
      ],
      indexes: [{ name: "posts_title", fields: ["title00000"] }],
    },
    { others: [superusersCollection()] },
  );
  const context: CollectionContext = {
    existing: posts,
    others: [superusersCollection()],
  };

  it("keeps everything not sent", () => {
    expect(parseCollection({}, context)).toEqual(posts);
  });

  it("renames a field by keeping its id", () => {
    const updated = parseCollection(
      {
        fields: [
          { id: "title00000", name: "headline", type: "text" },
          posts.fields[2],
        ],
      },
      context,
    );
    expect(updated.fields.find((f) => f.id === "title00000")?.name).toBe(
      "headline",
    );
    expect(updated.indexes[0]?.fields).toEqual(["title00000"]);
  });

  it("forbids changing a field's type or a relation's target", () => {
    expect(
      errorsOf(
        {
          fields: [
            { id: "title00000", name: "title", type: "number" },
            {
              id: "owner00000",
              name: "owner",
              type: "relation",
              collectionId: posts.id,
            },
          ],
        },
        context,
      ),
    ).toMatchObject({
      fields: {
        0: { type: { code: "validation_type_change" } },
        1: { collectionId: { code: "validation_type_change" } },
      },
    });
  });

  it("forbids changing id or type, and reports indexes left on removed fields", () => {
    expect(
      errorsOf(
        { id: "other0000000000", type: "auth", fields: [posts.fields[2]] },
        context,
      ),
    ).toMatchObject({
      id: { code: "validation_immutable" },
      type: { code: "validation_immutable" },
      indexes: { 0: { fields: { 0: { code: "validation_invalid_value" } } } },
    });
  });

  it("keeps system fields that are left out or sent with other changes", () => {
    const users = parseCollection(
      { name: "users", type: "auth" },
      none,
    ) as AuthCollection;
    const updated = parseCollection(
      {
        fields: [
          {
            name: "email",
            type: "email",
            onlyDomains: ["Example.com"],
            hidden: true,
          },
        ],
      },
      { existing: users, others: [] },
    ) as AuthCollection;
    expect(fieldNames(updated)).toEqual([
      "id",
      "emailVisibility",
      "emailVerified",
      "phone",
      "phoneVerified",
      "password",
      "tokenKey",
      "email",
    ]);
    expect(updated.fields.at(-1)).toMatchObject({
      system: true,
      hidden: false,
      onlyDomains: ["example.com"],
    });
    expect(updated.tokens).toEqual(users.tokens);

    expect(
      errorsOf(
        { fields: [{ id: "_email", name: "mail", type: "text" }] },
        { existing: users, others: [] },
      ),
    ).toMatchObject({
      fields: {
        0: {
          name: { code: "validation_immutable" },
          type: { code: "validation_type_change" },
        },
      },
    });
  });

  it("validates identity fields and token settings", () => {
    const users = parseCollection({ name: "users", type: "auth" }, none);
    expect(
      errorsOf(
        {
          fields: [{ id: "nick000000", name: "nick", type: "text" }],
          identityFields: ["email", "nick", "emailVerified"],
          tokens: { auth: { duration: 0 }, file: { secret: "short" } },
        },
        { existing: users, others: [] },
      ),
    ).toMatchObject({
      identityFields: {
        1: { code: "validation_invalid_value" },
        2: { code: "validation_invalid_value" },
      },
      tokens: {
        auth: { duration: { code: "validation_out_of_range" } },
        file: { secret: { code: "validation_invalid_value" } },
      },
    });
  });
});

describe("_superusers", () => {
  const superusers = superusersCollection();
  const context: CollectionContext = { existing: superusers, others: [] };

  it("is a superuser-only auth collection with short-lived tokens", () => {
    expect(superusers).toMatchObject({
      id: "_superusers",
      name: "_superusers",
      type: "auth",
      system: true,
    });
    expect([
      superusers.listRule,
      superusers.viewRule,
      superusers.createRule,
    ]).toEqual([null, null, null]);
    expect(superusers.tokens.auth.duration).toBe(86_400);
  });

  it("cannot be renamed or opened up by rules", () => {
    expect(
      errorsOf({ name: "admins", listRule: "", manageRule: "" }, context),
    ).toMatchObject({
      name: { code: "validation_immutable" },
      listRule: { code: "validation_immutable" },
      manageRule: { code: "validation_immutable" },
    });
  });

  it("still allows its token lifetimes to change", () => {
    const updated = parseCollection(
      { tokens: { auth: { duration: 3600 } } },
      context,
    ) as AuthCollection;
    expect(updated.tokens.auth).toEqual({
      secret: superusers.tokens.auth.secret,
      duration: 3600,
    });
  });
});
