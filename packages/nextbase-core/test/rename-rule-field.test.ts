import type { Collection } from "@nextbasejs/client";
import { describe, expect, it } from "vitest";
import { renameRuleField } from "../src/db/rename-rule-field.ts";

const field = (name: string, extra: Record<string, unknown> = {}) => ({
  id: `f_${name}`,
  name,
  type: "text",
  system: false,
  required: false,
  hidden: false,
  ...extra,
});

const users = {
  id: "users0000000000",
  name: "users",
  type: "auth",
  fields: [
    field("verified", { type: "bool", system: true }),
    field("team", { type: "relation", collectionId: "teams0000000000" }),
  ],
} as unknown as Collection;
const teams = {
  id: "teams0000000000",
  name: "teams",
  type: "base",
  fields: [
    field("verified", { type: "bool" }),
    field("owner", { type: "relation", collectionId: "users0000000000" }),
  ],
} as unknown as Collection;
const posts = {
  id: "posts0000000000",
  name: "posts",
  type: "base",
  fields: [
    field("author", { type: "relation", collectionId: "users0000000000" }),
  ],
} as unknown as Collection;
const collections = [users, teams, posts];

const rename = (rule: string, on: Collection): string =>
  renameRuleField(
    rule,
    on,
    collections,
    "verified",
    "emailVerified",
    (c) => c.type === "auth",
  );

describe("renaming an auth field in rules", () => {
  it("renames the field on auth collections, the auth record and the body", () => {
    expect(rename("verified = true", users)).toBe("emailVerified = true");
    expect(rename("@request.auth.verified = true && id != ''", posts)).toBe(
      "@request.auth.emailVerified = true && id != ''",
    );
    expect(rename("@request.body.verified:isset = false", users)).toBe(
      "@request.body.emailVerified:isset = false",
    );
  });

  it("follows relations, back-relations and @collection", () => {
    expect(rename("author.verified = true", posts)).toBe(
      "author.emailVerified = true",
    );
    expect(rename("team.owner.verified = true", users)).toBe(
      "team.owner.emailVerified = true",
    );
    expect(rename("posts_via_author.author.verified ?= true", users)).toBe(
      "posts_via_author.author.emailVerified ?= true",
    );
    expect(rename("@collection.users:u.verified = true", posts)).toBe(
      "@collection.users:u.emailVerified = true",
    );
  });

  it("leaves fields of the same name on other collections, strings and other references alone", () => {
    expect(rename("verified = true", teams)).toBe("verified = true");
    expect(rename("team.verified = true", users)).toBe("team.verified = true");
    expect(rename("@request.body.verified = true", teams)).toBe(
      "@request.body.verified = true",
    );
    expect(rename("@request.query.verified = 'verified'", users)).toBe(
      "@request.query.verified = 'verified'",
    );
    expect(rename('email ~ "verified = true"', users)).toBe(
      'email ~ "verified = true"',
    );
    expect(rename("@collection.teams.verified = true", users)).toBe(
      "@collection.teams.verified = true",
    );
  });
});
