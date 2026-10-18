import { DB, type Params } from "@nextbase/dbx";
import { describe, expect, it } from "vitest";
import type { Principal } from "../src/server/auth/principal.ts";
import {
  compileFilter,
  type FilterContext,
  ruleProblem,
} from "../src/server/filter/compiler.ts";
import { FilterError, parseFilter } from "../src/server/filter/parser.ts";
import { Schema } from "../src/server/schema/cache.ts";
import { parseCollection } from "../src/server/schema/collection.ts";
import type { AuthCollection, Collection } from "../src/shared/schema.ts";

const users = parseCollection(
  {
    id: "users0000000000",
    name: "users",
    type: "auth",
    viewRule: "id = @request.auth.id",
    fields: [
      { name: "name", type: "text" },
      { name: "secret", type: "text", hidden: true },
    ],
  },
  { others: [] },
) as AuthCollection;
const posts = parseCollection(
  {
    id: "posts0000000000",
    name: "posts",
    fields: [
      { name: "title", type: "text" },
      { name: "views", type: "number" },
      { name: "published", type: "bool" },
      { name: "publishedAt", type: "date" },
      { name: "tags", type: "select", values: ["a", "b"], maxSelect: 2 },
      { name: "author", type: "relation", collectionId: users.id },
      {
        name: "editors",
        type: "relation",
        collectionId: users.id,
        maxSelect: 5,
      },
      { name: "meta", type: "json" },
    ],
  },
  { others: [users] },
);
const comments = parseCollection(
  {
    id: "comments0000000",
    name: "comments",
    fields: [
      { name: "text", type: "text" },
      { name: "post", type: "relation", collectionId: posts.id },
    ],
  },
  { others: [users, posts] },
);
const schema = new Schema(1, [users, posts, comments]);
const db = new DB({
  query: () => Promise.reject(new Error("no database")),
  connect: () => Promise.reject(new Error("no database")),
});

const anonymous: Principal = { superuser: false };
const ann: Principal = {
  superuser: false,
  collection: users,
  record: { id: "ann000000000000", verified: true },
};

function compile(
  source: string,
  options: {
    mode?: FilterContext["mode"];
    principal?: Principal;
    body?: Record<string, unknown>;
    collection?: Collection;
  } = {},
): { sql: string; params: Params } {
  const expression = compileFilter(source, options.collection ?? posts, "t0", {
    schema,
    principal: options.principal ?? anonymous,
    request: {
      method: "GET",
      query: {},
      headers: {},
      body: options.body ?? {},
    },
    mode: options.mode ?? "filter",
  });
  if (!expression) return { sql: "", params: {} };
  const params: Params = {};
  return { sql: expression.build(db, params), params };
}

const fails = (
  source: string,
  message: RegExp,
  options?: Parameters<typeof compile>[1],
): void => {
  expect(() => compile(source, options)).toThrow(FilterError);
  expect(() => compile(source, options)).toThrow(message);
};

describe("parseFilter", () => {
  it("parses precedence, parentheses, literals and modifiers", () => {
    expect(parseFilter('a = 1 || b ?~ "x" && (c != null)')).toEqual({
      kind: "logical",
      op: "||",
      left: {
        kind: "comparison",
        op: "=",
        any: false,
        left: { kind: "identifier", path: ["a"], modifier: undefined },
        right: { kind: "literal", value: 1 },
      },
      right: {
        kind: "logical",
        op: "&&",
        left: {
          kind: "comparison",
          op: "~",
          any: true,
          left: { kind: "identifier", path: ["b"], modifier: undefined },
          right: { kind: "literal", value: "x" },
        },
        right: {
          kind: "comparison",
          op: "!=",
          any: false,
          left: { kind: "identifier", path: ["c"], modifier: undefined },
          right: { kind: "literal", value: null },
        },
      },
    });
    expect(parseFilter("tags:length > -1")).toMatchObject({
      left: { modifier: "length" },
      right: { value: -1 },
    });
    expect(parseFilter(`title = 'it\\'s'`)).toMatchObject({
      right: { value: "it's" },
    });
    expect(parseFilter("   ")).toBeUndefined();
  });

  it("rejects bad syntax and enforces its limits", () => {
    for (const [source, message] of [
      ['title = "open', /Unterminated/],
      ["title =", /Expected a value/],
      ["title = 1 title = 2", /Expected &&/],
      ["(title = 1", /Expected "\)"/],
      ["title # 1", /Unexpected character/],
      ["x".repeat(3501), /at most 3500/],
      [`${"(".repeat(7)}a = 1${")".repeat(7)}`, /nest at most 6/],
      [
        Array.from({ length: 201 }, () => "a = 1").join(" && "),
        /at most 200 comparisons/,
      ],
    ] as const) {
      expect(() => parseFilter(source)).toThrow(message);
    }
  });
});

describe("compileFilter", () => {
  it("binds every value and quotes every name", () => {
    const { sql, params } = compile(
      'title = "x\\" OR 1=1 --" && views >= 10 && published = true',
    );
    expect(sql).toBe(
      '(("t0"."title" = {:f0}::text AND "t0"."views" >= {:f1}::double precision) AND "t0"."published" = {:f2}::boolean)',
    );
    expect(params).toEqual({ f0: 'x" OR 1=1 --', f1: 10, f2: true });
  });

  it("matches text with ~ case-insensitively, escaping LIKE wildcards unless the value has %", () => {
    expect(compile('title ~ "50%_off"').params).toEqual({ f0: "50%_off" });
    expect(compile('title ~ "a_b"')).toEqual({
      sql: `"t0"."title" ILIKE {:f0}::text ESCAPE '\\'`,
      params: { f0: "%a\\_b%" },
    });
    expect(compile('title !~ "x"').sql).toMatch(/^"t0"."title" NOT ILIKE/);
    // A column that can be NULL keeps its NULL rows in !~.
    expect(compile('author !~ "x"').sql).toMatch(
      /^COALESCE\("t0"."author", ''\) NOT ILIKE/,
    );
  });

  it("compares blanks as each type's blank value", () => {
    expect(compile('title = ""').params).toEqual({ f0: "" });
    expect(compile("views = null").params).toEqual({ f0: 0 });
    expect(compile('publishedAt = ""')).toEqual({
      sql: '"t0"."publishedAt" IS NULL',
      params: {},
    });
    expect(compile('author != ""')).toEqual({
      sql: '"t0"."author" IS NOT NULL',
      params: {},
    });
    // Nullable columns keep NULL-safe comparisons for non-blank values.
    expect(compile('author != "x00000000000000"').sql).toBe(
      '"t0"."author" IS DISTINCT FROM {:f0}::text',
    );
    expect(compile('author = "x00000000000000"').sql).toBe(
      '"t0"."author" = {:f0}::text',
    );
    expect(compile('tags = ""').sql).toBe('cardinality("t0"."tags") = 0');
    expect(compile("tags != null").sql).toBe('cardinality("t0"."tags") > 0');
  });

  it("compiles values of multi-valued fields: ?op is any, op is all of a non-empty set", () => {
    expect(compile('tags ?= "a"').sql).toBe(
      'EXISTS (SELECT 1 FROM unnest("t0"."tags") AS "f1"("v") WHERE "f1"."v" = {:f0}::text)',
    );
    expect(compile('tags = "a"').sql).toBe(
      '(EXISTS (SELECT 1 FROM unnest("t0"."tags") AS "f1"("v") WHERE TRUE) AND NOT EXISTS (SELECT 1 FROM unnest("t0"."tags") AS "f1"("v") WHERE NOT COALESCE("f1"."v" = {:f0}::text, false)))',
    );
    expect(compile("tags:length > 1").sql).toBe(
      'cardinality("t0"."tags") > {:f0}::double precision',
    );
  });

  it("walks relations in subqueries, limited to records the caller may view", () => {
    const { sql, params } = compile('author.name ?= "Ann"', {
      principal: ann,
      collection: posts,
    });
    expect(sql).toContain('FROM {{nextbase.users}} "f1"');
    expect(sql).toContain('"f1"."id" = "t0"."author"');
    // users' viewRule, `id = @request.auth.id`, applies to the related records.
    expect(sql).toContain('"f1"."id" = {:f0}::text');
    expect(Object.values(params)).toEqual(
      expect.arrayContaining(["ann000000000000", "Ann"]),
    );
    expect(compile('editors.name ?= "x"').sql).toContain(
      '"f1"."id" = ANY("t0"."editors")',
    );
  });

  it("stops filters at collections whose view rule is null", () => {
    const locked = { ...users, viewRule: null };
    const lockedSchema = new Schema(1, [locked, posts]);
    const expression = compileFilter('author.name = "x"', posts, "t0", {
      schema: lockedSchema,
      principal: anonymous,
      request: { method: "GET", query: {}, headers: {}, body: {} },
      mode: "filter",
    });
    expect(expression?.build(db, {})).toContain("FALSE");
  });

  it("keeps hidden fields, secrets and @request values out of client filters", () => {
    fails("author.secret = 'x'", /Unknown field "author.secret"/);
    fails("author.password = 'x'", /cannot be used/);
    fails("author.tokenKey = 'x'", /cannot be used/);
    fails("@request.auth.id = ''", /Filters cannot read @request/);
    expect(compile("author.secret = 'x'", { mode: "rule" }).sql).toContain(
      '"secret"',
    );
  });

  it("hides emails a viewer may not see", () => {
    expect(compile("email = 'a@b.co'", { collection: users }).sql).toContain(
      'CASE WHEN "t0"."emailVisibility"',
    );
    expect(
      compile("email = 'a@b.co'", { collection: users, mode: "rule" }).sql,
    ).not.toContain("CASE");
  });

  it("resolves @request values in rules, with blanks for missing ones", () => {
    expect(compile('@request.auth.id != ""', { mode: "rule" }).params).toEqual({
      f0: "",
      f1: "",
    });
    expect(
      compile('@request.auth.id != ""', { mode: "rule", principal: ann })
        .params,
    ).toEqual({ f0: "ann000000000000", f1: "" });
    expect(
      compile("author = @request.auth.id", { mode: "rule", principal: ann })
        .params,
    ).toEqual({ f0: "ann000000000000" });
    expect(
      compile("author = @request.auth.id", { mode: "rule" }).params,
    ).toEqual({});
    expect(compile("author = @request.auth.id", { mode: "rule" }).sql).toBe(
      '"t0"."author" IS NULL',
    );
    expect(
      compile("@request.auth.verified = true", { mode: "rule" }).params,
    ).toEqual({ f0: false, f1: true });
    expect(
      compile("@request.body.title:isset = false", {
        mode: "rule",
        body: { title: "x" },
      }).params,
    ).toEqual({ f0: true, f1: false });
    expect(
      compile("views < @request.body.views", {
        mode: "rule",
        body: { views: 3 },
      }).params,
    ).toEqual({ f0: 3 });
    expect(compile("publishedAt <= @now", { mode: "rule" }).params.f0).toMatch(
      /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}\+00$/,
    );
  });

  it("rejects unknown fields, wrong types and unsupported references", () => {
    fails("nope = 1", /Unknown field "nope"/);
    fails("title.x = 1", /not a relation/);
    fails('views = "lots"', /not a valid number/);
    fails("published > true", /does not apply to booleans/);
    fails('publishedAt = "someday"', /not a valid date/);
    fails("views ~ 1", /applies to text/);
    fails("meta = 1", /whole JSON field/);
    fails("meta.when > @now", /JSON values cannot be compared with dates/, {
      mode: "rule",
    });
    fails("title:length = 1", /:length applies/);
    fails("tags = editors", /at most one/);
    fails("@collection.users.name = 'x'", /Filters cannot read @collection/);
    fails("@collection.nope.id = 'x'", /Unknown collection "nope"/, {
      mode: "rule",
    });
    fails("title:lower.x = 1", /Unexpected ":lower"/);
    fails(
      "comments_via_title.text = 'x'",
      /Unknown field "comments_via_title"/,
    );
  });
});

describe("ruleProblem", () => {
  it("reports rules that no longer fit the schema", () => {
    expect(ruleProblem(null, posts, schema)).toBeUndefined();
    expect(
      ruleProblem("author = @request.auth.id", posts, schema),
    ).toBeUndefined();
    expect(ruleProblem("status = 'live'", posts, schema)).toMatch(
      /Unknown field "status"/,
    );
  });
});

describe("back-relations, @collection and JSON", () => {
  it("walks back-relations and counts them", () => {
    const { sql } = compile('comments_via_post.text ?= "hi"', { mode: "rule" });
    expect(sql).toContain(
      'FROM {{nextbase.comments}} "f1" WHERE "f1"."post" = "t0"."id"',
    );
    // comments has a null view rule: a client filter cannot count them.
    expect(compile("comments_via_post:length > 2").sql).toContain("AND FALSE");
    expect(compile("comments_via_post:length > 2", { mode: "rule" })).toEqual({
      sql: '(SELECT count(*) FROM {{nextbase.comments}} "f1" WHERE "f1"."post" = "t0"."id") > {:f0}::double precision',
      params: { f0: 2 },
    });
    expect(
      compile('comments_via_post ?= "c00000000000001"', { mode: "rule" }).sql,
    ).toContain('"f1"."id" = {:f0}::text');
  });

  it("reads JSON values by key, typed by what they are compared with", () => {
    expect(compile('meta.address.city = "Oslo"')).toEqual({
      sql: 'jsonb_extract_path_text("t0"."meta", {:f0}::text, {:f1}::text) = {:f2}::text',
      params: { f0: "address", f1: "city", f2: "Oslo" },
    });
    expect(compile("meta.count > 5").sql).toBe(
      `(CASE WHEN jsonb_typeof(jsonb_extract_path("t0"."meta", {:f0}::text)) = 'number' THEN (jsonb_extract_path_text("t0"."meta", {:f0}::text))::double precision END) > {:f1}::double precision`,
    );
    expect(compile("meta.items.0 = 'x'").params).toEqual({
      f0: "items",
      f1: "0",
      f2: "x",
    });
    expect(compile('meta.missing = ""').sql).toBe(
      'jsonb_extract_path_text("t0"."meta", {:f0}::text) IS NULL',
    );
  });

  it("joins @collection rows, sharing one row per collection and alias", () => {
    const shared = compile(
      "@collection.users.name = 'a' && @collection.users.verified = true",
      { mode: "rule" },
    ).sql;
    expect(shared).toMatch(
      /^EXISTS \(SELECT 1 FROM \(SELECT 1\) AS "nb_one" LEFT JOIN \{\{nextbase\.users\}\} "c1" ON TRUE WHERE /,
    );
    expect(shared).not.toContain('"c2"');
    const separate = compile(
      "@collection.users:a.name = 'a' && @collection.users:b.name = 'b'",
      { mode: "rule" },
    ).sql;
    expect(separate).toContain(
      '"c1" ON TRUE LEFT JOIN {{nextbase.users}} "c2" ON TRUE',
    );
  });
});
