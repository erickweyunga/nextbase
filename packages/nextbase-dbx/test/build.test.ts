import { describe, expect, it } from "vitest";
import {
  and,
  between,
  DB,
  type Expression,
  exists,
  exp,
  hash,
  isIn,
  like,
  not,
  notBetween,
  notExists,
  notIn,
  notLike,
  or,
  orLike,
  orNotLike,
  type Params,
  type Pool,
} from "../src/index.ts";

// Records statements instead of running them, so SQL and values can be checked
// without a database.
function recordingDB(): {
  db: DB;
  calls: { text: string; values: unknown[] }[];
} {
  const calls: { text: string; values: unknown[] }[] = [];
  const pool: Pool = {
    async query({ text, values }) {
      calls.push({ text, values });
      return { rows: [], rowCount: 0 };
    },
    connect() {
      throw new Error("not used");
    },
  };
  return { db: new DB(pool), calls };
}

const { db } = recordingDB();

function build(e: Expression): { sql: string; params: Params } {
  const params: Params = {};
  return { sql: e.build(db, params), params };
}

describe("named parameters", () => {
  it("numbers placeholders and reuses the number of a repeated name", async () => {
    const { db, calls } = recordingDB();
    await db
      .newQuery("SELECT * FROM t WHERE a={:a} OR b={:b} OR c={:a}")
      .bind({ a: 1, b: 2 })
      .execute();
    expect(calls).toEqual([
      { text: "SELECT * FROM t WHERE a=$1 OR b=$2 OR c=$1", values: [1, 2] },
    ]);
  });

  it("quotes {{table}} and [[column]]", () => {
    const query = db.newQuery(
      "SELECT [[p.title]], [[id]] FROM {{nextbase.posts}} p",
    );
    expect(query.rawSQL).toBe(
      'SELECT "p"."title", "id" FROM "nextbase"."posts" p',
    );
    // After a name, `[[` is SQL.
    expect(db.newQuery("SELECT ARRAY[[1]], ARRAY[[2, 3]]").rawSQL).toBe(
      "SELECT ARRAY[[1]], ARRAY[[2, 3]]",
    );
    // After ARRAY and whitespace too, and a nested array is never a name.
    expect(
      db.newQuery("SELECT ARRAY [[1]], array\n\t[[x]], ARRAY[[[2]]]").rawSQL,
    ).toBe("SELECT ARRAY [[1]], array\n\t[[x]], ARRAY[[[2]]]");
    expect(
      db.newQuery("SELECT [[a]], x AS [[b]], my_array [[c]], ([[d]])").rawSQL,
    ).toBe('SELECT "a", x AS "b", my_array "c", ("d")');
  });

  it("merges bindings", () => {
    const query = db.newQuery("{:a} {:b}").bind({ a: 1 }).bind({ b: 2, a: 3 });
    expect(query.params).toEqual({ a: 3, b: 2 });
  });

  it("rejects a missing parameter without querying", async () => {
    const { db, calls } = recordingDB();
    await expect(db.newQuery("SELECT {:x}").all()).rejects.toThrow(
      "named parameter not found: x",
    );
    expect(calls).toEqual([]);
  });
});

describe("quoting", () => {
  it("quotes prefixed names and escapes embedded quotes", () => {
    expect(db.quoteTableName("nextbase.posts")).toBe('"nextbase"."posts"');
    expect(db.quoteColumnName("s.t.col")).toBe('"s"."t"."col"');
    expect(db.quoteColumnName('a"b')).toBe('"a""b"');
    expect(db.quoteColumnName("t.*")).toBe('"t".*');
  });

  it("passes SQL expressions through", () => {
    expect(db.quoteColumnName("count(*)")).toBe("count(*)");
    expect(db.quoteTableName("{{posts}}")).toBe("{{posts}}");
  });
});

describe("expressions", () => {
  it("builds hash conditions", () => {
    expect(
      build(hash({ a: 1, b: null, c: [2, 3], d: exp("x>{:x}", { x: 4 }) })),
    ).toEqual({
      sql: '"a"={:p0} AND "b" IS NULL AND "c" IN ({:p1}, {:p2}) AND (x>{:x})',
      params: { p0: 1, p1: 2, p2: 3, x: 4 },
    });
    expect(build(hash({}))).toEqual({ sql: "", params: {} });
  });

  it("rejects undefined hash values", () => {
    expect(() => build(hash({ id: undefined }))).toThrow(TypeError);
  });

  it("never overwrites a bound parameter", () => {
    expect(build(and(exp("a={:p1}", { p1: "x" }), hash({ b: 1 })))).toEqual({
      sql: '(a={:p1}) AND ("b"={:p2})',
      params: { p1: "x", p2: 1 },
    });
  });

  it("joins with AND and OR, skipping empty parts", () => {
    expect(build(and(hash({ a: 1 }), undefined, hash({})))).toEqual({
      sql: '"a"={:p0}',
      params: { p0: 1 },
    });
    expect(build(or(exp("a"), and(exp("b"), exp("c"))))).toEqual({
      sql: "(a) OR ((b) AND (c))",
      params: {},
    });
    expect(build(and())).toEqual({ sql: "", params: {} });
    expect(build(not(exp("a")))).toEqual({ sql: "NOT (a)", params: {} });
    // An empty condition matches every row: OR with it does too, and its
    // negation matches none.
    expect(build(not(and()))).toEqual({ sql: "0=1", params: {} });
    expect(build(not(notIn("a")))).toEqual({ sql: "0=1", params: {} });
    expect(build(or(and(), exp("a")))).toEqual({ sql: "", params: {} });
    expect(build(or(null, exp("a"), undefined))).toEqual({
      sql: "a",
      params: {},
    });
    expect(build(or())).toEqual({ sql: "", params: {} });
  });

  it("builds IN", () => {
    expect(build(isIn("a")).sql).toBe("0=1");
    expect(build(notIn("a")).sql).toBe("");
    expect(build(isIn("a", 1)).sql).toBe('"a"={:p0}');
    expect(build(notIn("a", 1)).sql).toBe('"a"<>{:p0}');
    expect(build(isIn("a", null)).sql).toBe('"a" IS NULL');
    expect(build(notIn("a", null)).sql).toBe('"a" IS NOT NULL');
    expect(build(isIn("a", 1, 2, null)).sql).toBe(
      '("a" IN ({:p0}, {:p1}) OR "a" IS NULL)',
    );
    expect(build(notIn("a", 1, null)).sql).toBe(
      '"a"<>{:p0} AND "a" IS NOT NULL',
    );
    expect(build(hash({ a: [1, null] })).sql).toBe(
      '("a"={:p0} OR "a" IS NULL)',
    );
    expect(() => build(isIn("a", 1, undefined))).toThrow(TypeError);
  });

  it("writes an Expression IN value as its own IN (...)", () => {
    const sub = exp("SELECT id FROM t WHERE x={:x}", { x: 1 });
    expect(build(isIn("a", sub))).toEqual({
      sql: '"a" IN (SELECT id FROM t WHERE x={:x})',
      params: { x: 1 },
    });
    expect(build(notIn("a", sub)).sql).toBe(
      '"a" NOT IN (SELECT id FROM t WHERE x={:x})',
    );
    expect(build(isIn("a", 2, sub, null)).sql).toBe(
      '("a"={:p0} OR "a" IN (SELECT id FROM t WHERE x={:x}) OR "a" IS NULL)',
    );
    expect(build(notIn("a", 2, 3, sub)).sql).toBe(
      '"a" NOT IN ({:p0}, {:p1}) AND "a" NOT IN (SELECT id FROM t WHERE x={:x})',
    );
    // An empty Expression is left out, like no value at all.
    expect(build(isIn("a", exp(""))).sql).toBe("0=1");
    expect(build(notIn("a", exp(""))).sql).toBe("");
    expect(build(isIn("a", 1, exp(""))).sql).toBe('"a"={:p0}');
  });

  it("builds LIKE with escaping", () => {
    expect(build(like("name", "50%_a\\b", "x"))).toEqual({
      sql: '"name" LIKE {:p0} AND "name" LIKE {:p1}',
      params: { p0: "%50\\%\\_a\\\\b%", p1: "%x%" },
    });
    expect(build(orLike("name", "a", "b").match(false, true))).toEqual({
      sql: '"name" LIKE {:p0} OR "name" LIKE {:p1}',
      params: { p0: "a%", p1: "b%" },
    });
    expect(build(notLike("name", "a%").escape()).params).toEqual({
      p0: "%a%%",
    });
    expect(build(like("name")).sql).toBe("");
    expect(build(like("name", "a").caseInsensitive()).sql).toBe(
      '"name" ILIKE {:p0}',
    );
    expect(build(orNotLike("name", "a", "b").caseInsensitive()).sql).toBe(
      '"name" NOT ILIKE {:p0} OR "name" NOT ILIKE {:p1}',
    );
    expect(() => like("name").escape("x")).toThrow(TypeError);
  });

  it("builds EXISTS and BETWEEN", () => {
    expect(build(exists(exp("SELECT 1"))).sql).toBe("EXISTS (SELECT 1)");
    expect(build(exists(exp(""))).sql).toBe("0=1");
    expect(build(notExists(exp(""))).sql).toBe("");
    expect(build(between("age", 1, 2))).toEqual({
      sql: '"age" BETWEEN {:p0} AND {:p1}',
      params: { p0: 1, p1: 2 },
    });
    expect(build(notBetween("age", 1, 2)).sql).toBe(
      '"age" NOT BETWEEN {:p0} AND {:p1}',
    );
  });
});

describe("select", () => {
  it("builds every clause in order", () => {
    const query = db
      .select("id", "name AS n", "p.title t", "count(*) total")
      .distinct(true)
      .from("users u", "nextbase.posts AS p")
      .innerJoin("profiles pr", exp("pr.user_id=u.id"))
      .where(hash({ status: 1 }))
      .andWhere(like("name", "a"))
      .groupBy("id")
      .having(exp("count(*)>{:min}", { min: 2 }))
      .orderBy("id", "name desc")
      .limit(10)
      .offset(20)
      .build();
    expect(query.sql).toBe(
      'SELECT DISTINCT "id", "name" AS "n", "p"."title" AS "t", count(*) AS "total" ' +
        'FROM "users" "u", "nextbase"."posts" "p" ' +
        'INNER JOIN "profiles" "pr" ON pr.user_id=u.id ' +
        'WHERE ("status"={:p0}) AND ("name" LIKE {:p1}) ' +
        'GROUP BY "id" HAVING count(*)>{:min} ' +
        'ORDER BY "id", "name" desc LIMIT 10 OFFSET 20',
    );
    expect(query.params).toEqual({ p0: 1, p1: "%a%", min: 2 });
    expect(query.rawSQL).toContain('"status"=$1');
  });

  it("selects * with no columns and omits empty clauses", () => {
    expect(db.select().from("t").where(and()).build().sql).toBe(
      'SELECT * FROM "t"',
    );
    expect(db.select().from("t").offset(5).build().sql).toBe(
      'SELECT * FROM "t" OFFSET 5',
    );
  });

  it("builds unions and merges their params", () => {
    const query = db
      .select("id")
      .from("a")
      .where(hash({ x: 1 }))
      .union(db.newQuery("SELECT id FROM b WHERE y={:y}").bind({ y: 2 }))
      .unionAll(db.select("id").from("c").build())
      .build();
    expect(query.sql).toBe(
      '(SELECT "id" FROM "a" WHERE "x"={:p0}) UNION (SELECT id FROM b WHERE y={:y}) UNION ALL (SELECT "id" FROM "c")',
    );
    expect(query.params).toEqual({ p0: 1, y: 2 });
  });

  it("rejects non-integer limits", () => {
    expect(() => db.select().limit(1.5)).toThrow(RangeError);
    expect(() => db.select().offset(Number.NaN)).toThrow(RangeError);
    expect(() =>
      db.select().limit("1; DROP TABLE t" as unknown as number),
    ).toThrow(RangeError);
  });
});

describe("data manipulation", () => {
  it("builds INSERT, skipping undefined values", () => {
    const query = db.insert("nextbase.users", {
      name: "a",
      skipped: undefined,
      created: exp("now()"),
    });
    expect(query.sql).toBe(
      'INSERT INTO "nextbase"."users" ("name", "created") VALUES ({:p0}, now())',
    );
    expect(query.params).toEqual({ p0: "a" });
    expect(db.insert("t", {}).sql).toBe('INSERT INTO "t" DEFAULT VALUES');
  });

  it("builds one INSERT of several rows", () => {
    const query = db.insertMany("nextbase.users", [
      { name: "a", skipped: undefined, created: exp("now()") },
      { name: "b", created: exp("now()") },
    ]);
    expect(query.sql).toBe(
      'INSERT INTO "nextbase"."users" ("name", "created") VALUES ({:p0}, now()), ({:p1}, now())',
    );
    expect(query.params).toEqual({ p0: "a", p1: "b" });
    expect(() => db.insertMany("t", [])).toThrow(/no rows/);
    expect(() => db.insertMany("t", [{}])).toThrow(/no columns/);
    // A column one row leaves out gets its default there.
    expect(
      db.insertMany("t", [{ a: 1 }, { b: 2, a: 3 }, { c: undefined }]).sql,
    ).toBe(
      'INSERT INTO "t" ("a", "b") VALUES ({:p0}, DEFAULT), ({:p1}, {:p2}), (DEFAULT, DEFAULT)',
    );
  });

  it("builds UPSERT", () => {
    expect(
      db.upsert("t", { id: 1, name: "a", n: exp("t.n+1") }, "id").sql,
    ).toBe(
      'INSERT INTO "t" ("id", "name", "n") VALUES ({:p0}, {:p1}, t.n+1) ON CONFLICT ("id") DO UPDATE SET "id"=EXCLUDED."id", "name"=EXCLUDED."name", "n"=t.n+1',
    );
    expect(db.upsert("t", {}, "a", "b").sql).toBe(
      'INSERT INTO "t" DEFAULT VALUES ON CONFLICT ("a", "b") DO NOTHING',
    );
  });

  it("builds UPDATE and DELETE", () => {
    const update = db.update(
      "t",
      { name: "a", n: exp("n+1") },
      hash({ id: 2 }),
    );
    expect(update.sql).toBe(
      'UPDATE "t" SET "name"={:p0}, "n"=n+1 WHERE "id"={:p1}',
    );
    expect(update.params).toEqual({ p0: "a", p1: 2 });
    expect(db.update("t", { a: 1 }).sql).toBe('UPDATE "t" SET "a"={:p0}');
    expect(() => db.update("t", { a: undefined })).toThrow(TypeError);
    expect(db.delete("t", hash({ id: 1 })).sql).toBe(
      'DELETE FROM "t" WHERE "id"={:p0}',
    );
    expect(db.delete("t").sql).toBe('DELETE FROM "t"');
  });
});

describe("schema manipulation", () => {
  it("builds DDL", () => {
    expect(
      db.createTable(
        "t",
        { id: "serial PRIMARY KEY", name: "text" },
        "WITH (fillfactor=70)",
      ).sql,
    ).toBe(
      'CREATE TABLE "t" ("id" serial PRIMARY KEY, "name" text) WITH (fillfactor=70)',
    );
    expect(db.renameTable("s.a", "b").sql).toBe(
      'ALTER TABLE "s"."a" RENAME TO "b"',
    );
    expect(db.alterColumn("t", "n", "bigint").sql).toBe(
      'ALTER TABLE "t" ALTER COLUMN "n" TYPE bigint',
    );
    expect(
      db.addForeignKey("t", "fk", ["a"], ["id"], "r", "ON DELETE CASCADE").sql,
    ).toBe(
      'ALTER TABLE "t" ADD CONSTRAINT "fk" FOREIGN KEY ("a") REFERENCES "r" ("id") ON DELETE CASCADE',
    );
    expect(db.dropIndex("t", "idx").sql).toBe('DROP INDEX "idx"');
    expect(db.dropIndex("s.t", "idx").sql).toBe('DROP INDEX "s"."idx"');
  });
});

describe("more builder cases", () => {
  it("processes placeholders and quoted names", () => {
    const cases: [string, string, string[]][] = [
      [
        "INSERT INTO employee (id, name, age) VALUES ({:id}, {:name}, {:age})",
        "INSERT INTO employee (id, name, age) VALUES ($1, $2, $3)",
        ["id", "name", "age"],
      ],
      [
        "SELECT * FROM employee WHERE first_name LIKE {:keyword} OR last_name LIKE {:keyword}",
        "SELECT * FROM employee WHERE first_name LIKE $1 OR last_name LIKE $1",
        ["keyword"],
      ],
      [
        'SELECT * FROM employee WHERE first_name LIKE "{:key?word}" OR last_name LIKE {:keyword}',
        'SELECT * FROM employee WHERE first_name LIKE "{:key?word}" OR last_name LIKE $1',
        ["keyword"],
      ],
      [
        "SELECT * FROM {{public.user}} WHERE [[user.id]]=1",
        'SELECT * FROM "public"."user" WHERE "user"."id"=1',
        [],
      ],
    ];
    for (const [sql, expected, placeholders] of cases) {
      expect(db.processSQL(sql)).toEqual({ sql: expected, placeholders });
    }
  });

  it("quotes table and column names", () => {
    expect(db.quoteTableName("users")).toBe('"users"');
    expect(db.quoteTableName("(select)")).toBe("(select)");
    expect(db.quoteTableName("public.db1.users")).toBe(
      '"public"."db1"."users"',
    );
    expect(db.quoteColumnName("*")).toBe("*");
    expect(db.quoteColumnName("users.*")).toBe('"users".*');
    expect(db.quoteColumnName("name")).toBe('"name"');
    expect(db.quoteColumnName("(select)")).toBe("(select)");
    expect(db.quoteColumnName("{{name}}")).toBe("{{name}}");
    expect(db.quoteColumnName("[[name]]")).toBe("[[name]]");
    expect(db.quoteColumnName("public.db1.users")).toBe(
      '"public"."db1"."users"',
    );
  });

  it("quotes literals and simple names", () => {
    expect(db.quote("abc")).toBe("'abc'");
    expect(db.quote("I'm")).toBe("'I''m'");
    expect(db.quote("")).toBe("''");
    expect(db.quoteSimpleTableName("abc")).toBe('"abc"');
    expect(db.quoteSimpleTableName("{{abc}}")).toBe('"{{abc}}"');
    expect(db.quoteSimpleTableName("a.bc")).toBe('"a.bc"');
    expect(db.quoteSimpleColumnName("a.bc")).toBe('"a.bc"');
    expect(db.quoteSimpleColumnName("*")).toBe("*");
  });

  it("creates a query", () => {
    const query = db.newQuery("SELECT * FROM users WHERE id={:id}");
    expect(query.sql).toBe("SELECT * FROM users WHERE id={:id}");
    expect(query.rawSQL).toBe("SELECT * FROM users WHERE id=$1");
    expect(query.params).toEqual({});
    expect(query.bind({ id: 1 }).params).toEqual({ id: 1 });
  });

  it("ignores unused params", async () => {
    const { db, calls } = recordingDB();
    await db
      .newQuery("SELECT {:id}, {:name}")
      .bind({ id: 1, name: "xyz", age: 30 })
      .all();
    await db.newQuery("SELECT 1").bind({ id: 1 }).all();
    expect(calls.map((call) => call.values)).toEqual([[1, "xyz"], []]);
  });

  it("builds raw expressions", () => {
    const params: Params = { k2: "v2" };
    expect(exp("s1").build(db, params)).toBe("s1");
    expect(params).toEqual({ k2: "v2" });
    expect(exp("s2", { k1: "v1" }).build(db, params)).toBe("s2");
    expect(params).toEqual({ k1: "v1", k2: "v2" });
  });

  it("builds hash expressions with existing params", () => {
    const params: Params = { k0: "v0" };
    const sql = hash({
      k1: null,
      k2: exp("s1", { ka: "va" }),
      k3: 1.1,
      k4: "abc",
      k5: [1, 2],
    }).build(db, params);
    expect(sql).toBe(
      '"k1" IS NULL AND (s1) AND "k3"={:p2} AND "k4"={:p3} AND "k5" IN ({:p4}, {:p5})',
    );
    expect(Object.keys(params)).toHaveLength(6);
    expect(params.p5).toBe(2);
  });

  it("builds NOT", () => {
    expect(build(not(exp("s1"))).sql).toBe("NOT (s1)");
    expect(build(not(exp(""))).sql).toBe("0=1");
  });

  it("builds AND and OR with params", () => {
    expect(
      build(and(exp("s1", { k1: "v1" }), exp(""), exp("s2", { k2: "v2" }))),
    ).toEqual({ sql: "(s1) AND (s2)", params: { k1: "v1", k2: "v2" } });
    expect(build(or(exp("s1"), exp("s2"))).sql).toBe("(s1) OR (s2)");
    expect(build(and(exp("s1"))).sql).toBe("s1");
    expect(build(and(exp("s1"), null)).sql).toBe("s1");
  });

  it("builds IN with several values", () => {
    expect(build(isIn("age", 1, 2, 3))).toEqual({
      sql: '"age" IN ({:p0}, {:p1}, {:p2})',
      params: { p0: 1, p1: 2, p2: 3 },
    });
    expect(build(notIn("age", 1, 2, 3)).sql).toBe(
      '"age" NOT IN ({:p0}, {:p1}, {:p2})',
    );
  });

  it("builds every LIKE variant", () => {
    expect(build(like("name", "a", "b", "c")).sql).toBe(
      '"name" LIKE {:p0} AND "name" LIKE {:p1} AND "name" LIKE {:p2}',
    );
    expect(build(notLike("name", "a", "b", "c")).sql).toBe(
      '"name" NOT LIKE {:p0} AND "name" NOT LIKE {:p1} AND "name" NOT LIKE {:p2}',
    );
    expect(build(orNotLike("name", "a", "b", "c")).sql).toBe(
      '"name" NOT LIKE {:p0} OR "name" NOT LIKE {:p1} OR "name" NOT LIKE {:p2}',
    );
    expect(build(like("name", "a_\\%")).params).toEqual({
      p0: "%a\\_\\\\\\%%",
    });
    expect(build(like("name", "a").match(true, false)).params).toEqual({
      p0: "%a",
    });
    expect(build(like("name", "a").match(false, false)).params).toEqual({
      p0: "a",
    });
    expect(
      build(like("name", "%a").match(false, false).escape()).params,
    ).toEqual({ p0: "%a" });
  });

  it("builds NOT EXISTS", () => {
    expect(build(notExists(exp("s1"))).sql).toBe("NOT EXISTS (s1)");
  });

  it("builds SELECT and FROM with aliases", () => {
    expect(
      db.select().distinct(true).selectOption("CALC_ROWS").build().sql,
    ).toBe("SELECT DISTINCT CALC_ROWS *");
    expect(
      db.select("name As Name", "users.last_name", "u.first1 first").build()
        .sql,
    ).toBe(
      'SELECT "name" AS "Name", "users"."last_name", "u"."first1" AS "first"',
    );
    expect(db.select().from("users u", "posts as p").build().sql).toBe(
      'SELECT * FROM "users" "u", "posts" "p"',
    );
    expect(db.select().from("pub.users p.u", "posts AS p1").build().sql).toBe(
      'SELECT * FROM "pub"."users" "p.u", "posts" "p1"',
    );
  });

  it("builds WHERE and HAVING", () => {
    const query = db
      .select()
      .where(hash({ age: 30, dept: "marketing" }))
      .having(exp(""))
      .build();
    expect(query.sql).toBe('SELECT * WHERE "age"={:p0} AND "dept"={:p1}');
    expect(query.params).toEqual({ p0: 30, p1: "marketing" });
    expect(
      db
        .select()
        .where(exp(""))
        .having(hash({ a: 1 }))
        .build().sql,
    ).toBe('SELECT * HAVING "a"={:p0}');
  });

  it("builds LIMIT and OFFSET", () => {
    const limit = (limit: number, offset: number): string =>
      db.select().limit(limit).offset(offset).build().sql;
    expect(limit(10, -1)).toBe("SELECT * LIMIT 10");
    expect(limit(10, 0)).toBe("SELECT * LIMIT 10");
    expect(limit(10, 2)).toBe("SELECT * LIMIT 10 OFFSET 2");
    expect(limit(0, 2)).toBe("SELECT * LIMIT 0 OFFSET 2");
    expect(limit(-1, 2)).toBe("SELECT * OFFSET 2");
    expect(limit(-1, 0)).toBe("SELECT *");
    expect(db.select().orderBy("name").limit(10).offset(2).build().sql).toBe(
      'SELECT * ORDER BY "name" LIMIT 10 OFFSET 2',
    );
  });

  it("builds joins with and without ON", () => {
    const query = db
      .select()
      .from("t")
      .leftJoin("users u", exp("id=u.id", { id: 1 }))
      .build();
    expect(query.sql).toBe(
      'SELECT * FROM "t" LEFT JOIN "users" "u" ON id=u.id',
    );
    expect(query.params).toEqual({ id: 1 });
    expect(
      db.select().from("t").innerJoin("users").leftJoin("posts").build().sql,
    ).toBe('SELECT * FROM "t" INNER JOIN "users" LEFT JOIN "posts"');
  });

  it("builds a select with every clause", () => {
    const query = db
      .select("id", "name")
      .andSelect("age")
      .distinct(true)
      .selectOption("CALC")
      .from("users")
      .where(exp("age>30"))
      .andWhere(exp("status=1"))
      .orWhere(exp("type=2"))
      .innerJoin("profile", exp("user.id=profile.id"))
      .leftJoin("team")
      .rightJoin("dept")
      .orderBy("age DESC", "type")
      .andOrderBy("id")
      .groupBy("id")
      .andGroupBy("age")
      .having(exp("id>10"))
      .andHaving(exp("id<20"))
      .orHaving(exp("type=3"))
      .limit(10)
      .offset(20)
      .bind({ id: 1 })
      .andBind({ age: 30 })
      .build();
    expect(query.sql).toBe(
      'SELECT DISTINCT CALC "id", "name", "age" FROM "users" INNER JOIN "profile" ON user.id=profile.id LEFT JOIN "team" RIGHT JOIN "dept" WHERE ((age>30) AND (status=1)) OR (type=2) GROUP BY "id", "age" HAVING ((id>10) AND (id<20)) OR (type=3) ORDER BY "age" DESC, "type", "id" LIMIT 10 OFFSET 20',
    );
    expect(query.params).toEqual({ id: 1, age: 30 });
    expect(db.select().andBind({ id: 1 }).build().params).toEqual({ id: 1 });
  });

  it("builds UPDATE and DELETE with raw conditions", () => {
    expect(
      db.update("users", { name: "James", age: 30 }, exp("id=10")).sql,
    ).toBe('UPDATE "users" SET "name"={:p0}, "age"={:p1} WHERE id=10');
    expect(db.delete("users", exp("id=10")).sql).toBe(
      'DELETE FROM "users" WHERE id=10',
    );
  });

  it("builds an upsert with EXCLUDED values", () => {
    const query = db.upsert("users", { name: "James", age: 30 }, "id");
    expect(query.rawSQL).toBe(
      'INSERT INTO "users" ("name", "age") VALUES ($1, $2) ON CONFLICT ("id") DO UPDATE SET "name"=EXCLUDED."name", "age"=EXCLUDED."age"',
    );
    expect(query.params).toEqual({ p0: "James", p1: 30 });
  });

  it("builds schema statements", () => {
    expect(db.dropTable("users").sql).toBe('DROP TABLE "users"');
    expect(db.truncateTable("users").sql).toBe('TRUNCATE TABLE "users"');
    expect(db.addColumn("users", "age", "int").sql).toBe(
      'ALTER TABLE "users" ADD "age" int',
    );
    expect(db.dropColumn("users", "age").sql).toBe(
      'ALTER TABLE "users" DROP COLUMN "age"',
    );
    expect(db.renameColumn("users", "name", "username").sql).toBe(
      'ALTER TABLE "users" RENAME COLUMN "name" TO "username"',
    );
    expect(db.renameTable("users", "user").sql).toBe(
      'ALTER TABLE "users" RENAME TO "user"',
    );
    expect(db.addPrimaryKey("users", "pk", "id1", "id2").sql).toBe(
      'ALTER TABLE "users" ADD CONSTRAINT "pk" PRIMARY KEY ("id1", "id2")',
    );
    expect(db.dropPrimaryKey("users", "pk").sql).toBe(
      'ALTER TABLE "users" DROP CONSTRAINT "pk"',
    );
    expect(
      db.addForeignKey(
        "users",
        "fk",
        ["p1", "p2"],
        ["f1", "f2"],
        "profile",
        "opt",
      ).sql,
    ).toBe(
      'ALTER TABLE "users" ADD CONSTRAINT "fk" FOREIGN KEY ("p1", "p2") REFERENCES "profile" ("f1", "f2") opt',
    );
    expect(db.dropForeignKey("users", "fk").sql).toBe(
      'ALTER TABLE "users" DROP CONSTRAINT "fk"',
    );
    expect(db.createIndex("users", "idx", "id1", "id2").sql).toBe(
      'CREATE INDEX "idx" ON "users" ("id1", "id2")',
    );
    expect(db.createUniqueIndex("users", "idx", "id1", "id2").sql).toBe(
      'CREATE UNIQUE INDEX "idx" ON "users" ("id1", "id2")',
    );
  });
});

describe("SQL safety", () => {
  it("rewrites tokens only in SQL code", () => {
    const sql = [
      "SELECT {:a}, '{:no} [[no]] it''s', E'\\'{:no}', \"{{no}}\"",
      "$$ {:no} $$, $tag$ [[no]] $tag$",
      "-- {:no}",
      "/* {:no} /* nested {:no} */ {:no} */ [[yes]] FROM {{t}} WHERE x={:a}",
    ].join("\n");
    expect(db.processSQL(sql)).toEqual({
      sql: [
        "SELECT $1, '{:no} [[no]] it''s', E'\\'{:no}', \"{{no}}\"",
        "$$ {:no} $$, $tag$ [[no]] $tag$",
        "-- {:no}",
        '/* {:no} /* nested {:no} */ {:no} */ "yes" FROM "t" WHERE x=$1',
      ].join("\n"),
      placeholders: ["a"],
    });
  });

  it("rejects positional parameters outside literals", () => {
    expect(() => db.newQuery("SELECT $1")).toThrow(SyntaxError);
    expect(() => db.newQuery("SELECT {:a} + $2")).toThrow(SyntaxError);
    expect(db.newQuery("SELECT col$1, '$1' -- $1").rawSQL).toBe(
      "SELECT col$1, '$1' -- $1",
    );
  });

  it("never reinterprets names taken from data", async () => {
    const { db, calls } = recordingDB();
    const record = { 'x[[a]]y"': 1, "{:p0}": 2, "(select 1)": 3 };
    await db.insert("s.t", record).execute();
    await db.update("t", record, hash(record)).execute();
    await db.model("t", { id: 1, "[[x]]": 4 }).delete();
    await db.select().from("t").where(isIn("(select 1)", 5)).all();
    expect(calls.map((call) => call.text)).toEqual([
      'INSERT INTO "s"."t" ("x[[a]]y""", "{:p0}", "(select 1)") VALUES ($1, $2, $3)',
      'UPDATE "t" SET "x[[a]]y"""=$1, "{:p0}"=$2, "(select 1)"=$3 WHERE "x[[a]]y"""=$4 AND "{:p0}"=$5 AND "(select 1)"=$6',
      'DELETE FROM "t" WHERE "id"=$1',
      'SELECT * FROM "t" WHERE "(select 1)"=$1',
    ]);
    expect(calls[0]?.values).toEqual([1, 2, 3]);
  });

  it("keeps separately built parameters apart", () => {
    const query = db
      .select()
      .from("a")
      .where(and(hash({ x: 1 }), exp("y={:p0} OR z={:p0}", { p0: 2 })))
      .union(
        db
          .select()
          .from("b")
          .where(hash({ x: 3 }))
          .build(),
      )
      .build();
    expect(query.sql).toBe(
      '(SELECT * FROM "a" WHERE ("x"={:p0}) AND (y={:p1} OR z={:p1})) UNION (SELECT * FROM "b" WHERE "x"={:p2})',
    );
    expect(query.params).toEqual({ p0: 1, p1: 2, p2: 3 });
    // The same value under the same name is shared, not duplicated.
    expect(
      build(and(exp("a={:v}", { v: 1 }), exp("b={:v}", { v: 1 }))).params,
    ).toEqual({ v: 1 });
  });

  it("binds many values in linear time", () => {
    const values = Array.from({ length: 50_000 }, (_, i) => i);
    const started = performance.now();
    const query = db
      .select()
      .from("t")
      .where(isIn("id", ...values))
      .build();
    expect(query.rawSQL.endsWith("$50000)")).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("select", () => {
  it("fetches a single row for one(), row() and model()", async () => {
    const { db, calls } = recordingDB();
    const query = db
      .select()
      .from("t")
      .where(hash({ a: 1 }));
    await query.one().catch(() => {});
    await query.row().catch(() => {});
    await query.model(7).catch(() => {});
    await query
      .limit(5)
      .one()
      .catch(() => {});
    await db
      .select()
      .from("t")
      .union(db.newQuery("SELECT 1"))
      .one()
      .catch(() => {});
    expect(calls.map((call) => call.text)).toEqual([
      'SELECT * FROM "t" WHERE "a"=$1 LIMIT 1',
      'SELECT * FROM "t" WHERE "a"=$1 LIMIT 1',
      'SELECT * FROM "t" WHERE ("a"=$1) AND ("id"=$2) LIMIT 1',
      'SELECT * FROM "t" WHERE "a"=$1 LIMIT 5',
      '(SELECT * FROM "t") UNION (SELECT 1)',
    ]);
    // model() leaves the query unchanged.
    expect(query.build().sql).toBe('SELECT * FROM "t" WHERE "a"={:p0} LIMIT 5');
  });

  it("orders with NULLS FIRST and LAST", () => {
    expect(
      db.select().orderBy("a DESC NULLS LAST", "b nulls first", "c asc").build()
        .sql,
    ).toBe('SELECT * ORDER BY "a" DESC NULLS LAST, "b" nulls first, "c" asc');
  });
});
