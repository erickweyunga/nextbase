import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CompositePKError,
  DB,
  exp,
  hash,
  isIn,
  type LogEvent,
  like,
  MissingPKError,
  NoRowsError,
  notIn,
  Tx,
  TxAbortedError,
  TxDoneError,
} from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "./postgres.ts";

interface Customer {
  id?: number;
  email: string;
  name: string | null;
  status?: number;
}

let test: TestDatabase;
let db: DB;

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.db;
  await db
    .createTable("customer", {
      id: "serial PRIMARY KEY",
      email: "text NOT NULL UNIQUE",
      name: "text",
      status: "int NOT NULL DEFAULT 1",
    })
    .execute();
});

afterAll(() => test.close());

beforeEach(async () => {
  await db.newQuery("TRUNCATE customer RESTART IDENTITY").execute();
  await db
    .newQuery(
      "INSERT INTO customer (email, name, status) VALUES ('a@x.io', 'Ann', 1), ('b@x.io', 'Bob', 2), ('c@x.io', NULL, 1)",
    )
    .execute();
});

describe("queries", () => {
  it("returns rows, one row, a column and a row of values", async () => {
    const all = await db
      .select("id", "email")
      .from("customer")
      .orderBy("id")
      .all<{ id: number; email: string }>();
    expect(all).toEqual([
      { id: 1, email: "a@x.io" },
      { id: 2, email: "b@x.io" },
      { id: 3, email: "c@x.io" },
    ]);

    const one = await db
      .select()
      .from("customer")
      .where(hash({ email: "b@x.io" }))
      .one<Customer>();
    expect(one).toEqual({ id: 2, email: "b@x.io", name: "Bob", status: 2 });

    const emails = await db
      .select("email")
      .from("customer")
      .where(isIn("status", 1))
      .orderBy("email DESC")
      .column<string>();
    expect(emails).toEqual(["c@x.io", "a@x.io"]);

    const row = await db
      .newQuery("SELECT count(*)::int, max(id) FROM customer")
      .row<[number, number]>();
    expect(row).toEqual([3, 3]);
  });

  it("throws NoRowsError when one() or row() finds nothing", async () => {
    const query = db
      .select()
      .from("customer")
      .where(hash({ id: 99 }));
    await expect(query.one()).rejects.toBeInstanceOf(NoRowsError);
    await expect(query.row()).rejects.toBeInstanceOf(NoRowsError);
    await expect(query.all()).resolves.toEqual([]);
  });

  it("binds a repeated parameter once", async () => {
    const [sum] = await db
      .newQuery("SELECT {:a}::int + {:a}::int")
      .bind({ a: 2 })
      .row<[number]>();
    expect(sum).toBe(4);
  });

  it("matches LIKE wildcards literally", async () => {
    await db
      .insert("customer", { email: "100%@x.io", name: "Percent" })
      .execute();
    const names = await db
      .select("name")
      .from("customer")
      .where(like("email", "0%@"))
      .column();
    expect(names).toEqual(["Percent"]);
  });

  it("matches NULL inside IN and NOT IN", async () => {
    const ids = (exp: ReturnType<typeof isIn>) =>
      db.select("id").from("customer").where(exp).orderBy("id").column();
    await expect(ids(isIn("name", "Ann", null))).resolves.toEqual([1, 3]);
    await expect(ids(notIn("name", "Ann", null))).resolves.toEqual([2]);
    await expect(ids(isIn("name", null))).resolves.toEqual([3]);
  });

  it("matches case-insensitively with ILIKE", async () => {
    await expect(
      db
        .select("id")
        .from("customer")
        .where(like("name", "ANN").caseInsensitive())
        .column(),
    ).resolves.toEqual([1]);
  });

  it("filters by NULL", async () => {
    const ids = await db
      .select("id")
      .from("customer")
      .where(hash({ name: null }))
      .column();
    expect(ids).toEqual([3]);
  });
});

describe("type parsers", () => {
  it("parses columns with the DB's parsers, in transactions too, without changing other pools", async () => {
    const types = {
      getTypeParser: (oid: number) =>
        oid === 1184
          ? (text: string) => `parsed:${text.slice(0, 4)}`
          : (text: string) => text,
    };
    const db = new DB(test.pool, { types });
    const sql = "SELECT '2026-10-18 09:30:00+00'::timestamptz AS t";
    expect(await db.newQuery(sql).one()).toEqual({ t: "parsed:2026" });
    expect(await db.transaction((tx) => tx.newQuery(sql).column())).toEqual([
      "parsed:2026",
    ]);
    expect((await test.db.newQuery(sql).one()).t).toBeInstanceOf(Date);
  });
});

describe("data manipulation", () => {
  it("reports affected rows", async () => {
    await expect(
      db
        .update("customer", { status: exp("status+10") }, hash({ status: 1 }))
        .execute(),
    ).resolves.toEqual({ rowsAffected: 2 });
    await expect(
      db.delete("customer", hash({ status: 11 })).execute(),
    ).resolves.toEqual({ rowsAffected: 2 });
  });

  it("inserts several rows in one statement", async () => {
    await db
      .insertMany("customer", [
        { email: "d@x.io", name: "Dan" },
        { email: "e@x.io", name: null },
        // name has no default, so it is NULL.
        { email: "f@x.io" },
      ])
      .execute();
    const rows = await db
      .select("email", "name")
      .from("customer")
      .where(isIn("email", "d@x.io", "e@x.io", "f@x.io"))
      .orderBy("email")
      .all();
    expect(rows).toEqual([
      { email: "d@x.io", name: "Dan" },
      { email: "e@x.io", name: null },
      { email: "f@x.io", name: null },
    ]);
  });

  it("upserts on a conflict", async () => {
    await db
      .upsert("customer", { email: "a@x.io", name: "Annie" }, "email")
      .execute();
    await db
      .upsert("customer", { email: "d@x.io", name: "Dan" }, "email")
      .execute();
    const names = await db
      .select("name")
      .from("customer")
      .where(isIn("email", "a@x.io", "d@x.io"))
      .orderBy("email")
      .column();
    expect(names).toEqual(["Annie", "Dan"]);
  });
});

describe("models", () => {
  it("inserts and writes back the generated key", async () => {
    const customer: Customer = { email: "d@x.io", name: "Dan" };
    await db.model("customer", customer).insert();
    expect(customer.id).toBe(4);
    const stored = await db
      .select()
      .from("customer")
      .where(hash({ id: 4 }))
      .one<Customer>();
    expect(stored).toEqual({ id: 4, email: "d@x.io", name: "Dan", status: 1 });
  });

  it("inserts an explicit key", async () => {
    const customer: Customer = { id: 50, email: "e@x.io", name: "Eve" };
    await db.model("customer", customer).insert();
    expect(customer.id).toBe(50);
    await expect(
      db
        .select("email")
        .from("customer")
        .where(hash({ id: 50 }))
        .column(),
    ).resolves.toEqual(["e@x.io"]);
  });

  it("updates and deletes by key", async () => {
    const customer: Customer = {
      id: 1,
      email: "a2@x.io",
      name: "Changed",
      status: 9,
    };
    await db.model("customer", customer).exclude("status").update();
    await expect(
      db
        .select()
        .from("customer")
        .where(hash({ id: 1 }))
        .one(),
    ).resolves.toEqual({ id: 1, email: "a2@x.io", name: "Changed", status: 1 });

    await db.model("customer", customer).update("status");
    await expect(
      db
        .select("status")
        .from("customer")
        .where(hash({ id: 1 }))
        .column(),
    ).resolves.toEqual([9]);

    await db.model("customer", customer).delete();
    await expect(
      db.select("id").from("customer").orderBy("id").column(),
    ).resolves.toEqual([2, 3]);
  });

  it("refuses to update or delete a record without its key", async () => {
    const customer: Customer = { email: "x@x.io", name: "No key" };
    await expect(db.model("customer", customer).update()).rejects.toThrow(
      MissingPKError,
    );
    await expect(db.model("customer", customer).delete()).rejects.toThrow(
      MissingPKError,
    );
    await expect(
      db.model("customer", { ...customer, id: null }).delete(),
    ).rejects.toThrow(MissingPKError);
    expect(() => db.model("customer", customer, { pk: [] })).toThrow(
      MissingPKError,
    );
    await expect(
      db.newQuery("SELECT count(*)::int FROM customer").row(),
    ).resolves.toEqual([3]);
  });

  // Excluded columns win over the insert column list.
  it("inserts only the listed columns, minus excluded ones", async () => {
    const customer: Customer = { email: "d@x.io", name: "Dan", status: 5 };
    await db
      .model("customer", customer)
      .exclude("name")
      .insert("name", "email");
    await expect(
      db
        .select()
        .from("customer")
        .where(hash({ id: customer.id }))
        .one(),
    ).resolves.toEqual({ id: 4, email: "d@x.io", name: null, status: 1 });
  });

  it("uses a custom or composite primary key", async () => {
    await db
      .createTable("membership", { org: "text", member: "text", role: "text" })
      .execute();
    await db
      .addPrimaryKey("membership", "membership_pk", "org", "member")
      .execute();
    const row = { org: "acme", member: "ann", role: "admin" };
    const pk = ["org", "member"];
    await db.model("membership", row, { pk }).insert();
    await db.model("membership", { ...row, role: "owner" }, { pk }).update();
    await expect(
      db.select("role").from("membership").column(),
    ).resolves.toEqual(["owner"]);
    await db.model("membership", row, { pk }).delete();
    await expect(db.select().from("membership").all()).resolves.toEqual([]);

    const byEmail = { email: "a@x.io", name: "Ann by email" };
    await db.model("customer", byEmail, { pk: "email" }).update("name");
    await expect(
      db
        .select("name")
        .from("customer")
        .where(hash({ id: 1 }))
        .column(),
    ).resolves.toEqual(["Ann by email"]);
  });

  it("reads a record by primary key", async () => {
    await expect(
      db.select().from("customer").model<Customer>(2),
    ).resolves.toEqual({ id: 2, email: "b@x.io", name: "Bob", status: 2 });
    await expect(
      db
        .select("email")
        .from("customer")
        .where(hash({ status: 2 }))
        .model(2),
    ).resolves.toEqual({ email: "b@x.io" });
    await expect(
      db
        .select()
        .from("customer")
        .where(hash({ id: 1 }))
        .model(2),
    ).rejects.toBeInstanceOf(NoRowsError);
    await expect(
      db.select().from("customer").model("a@x.io", { pk: "email" }),
    ).resolves.toMatchObject({ id: 1 });
    await expect(
      db
        .select()
        .from("customer")
        .model(1, { pk: ["id", "email"] }),
    ).rejects.toBeInstanceOf(CompositePKError);
    await expect(
      db.select().from("customer").model(1, { pk: [] }),
    ).rejects.toBeInstanceOf(MissingPKError);
    await expect(db.select().model(1)).rejects.toThrow("needs from()");
  });
});

describe("safety and correctness", () => {
  it("stores and reads columns with hostile names", async () => {
    const hostile = 'x[[a]]y"; DROP TABLE customer; --{:p0}';
    await db.createTable("hostile", { [hostile]: "text" }).execute();
    await db.insert("hostile", { [hostile]: "v" }).execute();
    await expect(
      db
        .select()
        .from("hostile")
        .where(hash({ [hostile]: "v" }))
        .all(),
    ).resolves.toEqual([{ [hostile]: "v" }]);
    await db.update("hostile", { [hostile]: "w" }).execute();
    await expect(db.select().from("hostile").column()).resolves.toEqual(["w"]);
    await expect(db.select().from("customer").all()).resolves.toHaveLength(3);
  });

  it("keeps each side of a UNION bound to its own values", async () => {
    const emails = await db
      .select("email")
      .from("customer")
      .where(hash({ id: 1 }))
      .union(
        db
          .select("email")
          .from("customer")
          .where(hash({ id: 3 }))
          .build(),
      )
      .column();
    expect(emails.sort()).toEqual(["a@x.io", "c@x.io"]);
  });

  it("keeps an existing key when the insert column list leaves it out", async () => {
    const customer: Customer = { id: 70, email: "k@x.io", name: "Kim" };
    await db.model("customer", customer).insert("email", "name");
    expect(customer.id).toBe(70);
  });

  it("sorts NULLs last", async () => {
    await expect(
      db.select("id").from("customer").orderBy("name DESC NULLS LAST").column(),
    ).resolves.toEqual([2, 1, 3]);
  });

  it("runs a query with thousands of bound values", async () => {
    const ids = Array.from({ length: 20_000 }, (_, i) => i + 1);
    await expect(
      db
        .select("id")
        .from("customer")
        .where(isIn("id", ...ids))
        .orderBy("id")
        .column(),
    ).resolves.toEqual([1, 2, 3]);
  });
});

describe("reads and values", () => {
  it("reruns a query with new bindings", async () => {
    const query = db.newQuery("SELECT email FROM customer WHERE id={:id}");
    await expect(query.bind({ id: 1 }).column()).resolves.toEqual(["a@x.io"]);
    await expect(query.bind({ id: 20 }).one()).rejects.toBeInstanceOf(
      NoRowsError,
    );
    await expect(query.bind({ id: 3 }).row()).resolves.toEqual(["c@x.io"]);
  });

  it("round-trips dates and nulls", async () => {
    await db
      .createTable("event", {
        id: "serial PRIMARY KEY",
        created: "timestamptz NOT NULL",
        updated: "timestamptz",
      })
      .execute();
    const created = new Date("2026-01-02T03:04:05.678Z");
    const event: { id?: number; created: Date; updated: Date | null } = {
      created,
      updated: null,
    };
    await db.model("event", event).insert();
    expect(event.id).toBe(1);
    await expect(db.select().from("event").model(1)).resolves.toEqual({
      id: 1,
      created,
      updated: null,
    });
  });

  it("returns joined columns by name", async () => {
    await expect(
      db
        .select("c.email", "o.email AS other")
        .from("customer c")
        .innerJoin("customer o", exp("o.id = c.id + 1"))
        .orderBy("c.id")
        .all(),
    ).resolves.toEqual([
      { email: "a@x.io", other: "b@x.io" },
      { email: "b@x.io", other: "c@x.io" },
    ]);
  });

  it("reads the first column of a multi-column query", async () => {
    await expect(
      db.newQuery("SELECT email, id FROM customer ORDER BY id").column(),
    ).resolves.toEqual(["a@x.io", "b@x.io", "c@x.io"]);
  });
});

describe("transactions", () => {
  const count = async (): Promise<number> => {
    const [n] = await db
      .newQuery("SELECT count(*)::int FROM customer")
      .row<[number]>();
    return n;
  };

  it("commits when the callback resolves", async () => {
    const result = await db.transaction(async (tx) => {
      await tx.insert("customer", { email: "t@x.io" }).execute();
      // Not visible outside the transaction until it commits.
      expect(await count()).toBe(3);
      return "done";
    });
    expect(result).toBe("done");
    expect(await count()).toBe(4);
  });

  it("rolls back and rethrows when the callback rejects", async () => {
    const failure = new Error("boom");
    await expect(
      db.transaction(async (tx) => {
        await tx.insert("customer", { email: "t@x.io" }).execute();
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await count()).toBe(3);
  });

  it("rolls back when a statement fails", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.insert("customer", { email: "t@x.io" }).execute();
        await tx.insert("customer", { email: "a@x.io" }).execute();
      }),
    ).rejects.toThrow(/duplicate key/);
    expect(await count()).toBe(3);
  });

  it("rejects a commit that Postgres turned into a rollback", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.insert("customer", { email: "t@x.io" }).execute();
        // The caught error still aborts the transaction.
        await tx
          .insert("customer", { email: "a@x.io" })
          .execute()
          .catch(() => {});
      }),
    ).rejects.toBeInstanceOf(TxAbortedError);
    expect(await count()).toBe(3);
    expect(test.pool.idleCount).toBe(test.pool.totalCount);
  });

  it("nests transactions as savepoints", async () => {
    await db.transaction(async (tx) => {
      await tx.insert("customer", { email: "outer@x.io" }).execute();
      // A failed nested transaction undoes only its own changes, even after
      // a failed statement, and leaves the outer one usable.
      await expect(
        tx.transaction(async (inner) => {
          await inner.insert("customer", { email: "inner@x.io" }).execute();
          await inner.insert("customer", { email: "a@x.io" }).execute();
        }),
      ).rejects.toThrow(/duplicate key/);
      const kept = await tx.transaction(async (inner) => {
        await inner.insert("customer", { email: "kept@x.io" }).execute();
        return tx.transaction(async () => "deep");
      });
      expect(kept).toBe("deep");
    });
    const emails = await db
      .newQuery(
        "SELECT email FROM customer WHERE email LIKE '%@x.io' AND email NOT IN ('a@x.io', 'b@x.io', 'c@x.io') ORDER BY email",
      )
      .column();
    expect(emails).toEqual(["kept@x.io", "outer@x.io"]);
    await db
      .newQuery(
        "DELETE FROM customer WHERE email IN ('kept@x.io', 'outer@x.io')",
      )
      .execute();
  });

  it("lets the callback roll back itself", async () => {
    await db.transaction(async (tx) => {
      await tx.insert("customer", { email: "t@x.io" }).execute();
      await tx.rollback();
    });
    expect(await count()).toBe(3);
  });

  it("rethrows after the callback rolled back itself", async () => {
    const failure = new Error("boom");
    await expect(
      db.transaction(async (tx) => {
        await tx.delete("customer", hash({ id: 2 })).execute();
        await tx.rollback();
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await count()).toBe(3);
  });

  it("wraps a connection with a transaction already started", async () => {
    const client = await test.pool.connect();
    await client.query("BEGIN");
    const tx = new Tx(client);
    await tx.insert("customer", { email: "w@x.io" }).execute();
    await tx.commit();
    expect(await count()).toBe(4);
  });

  it("applies isolation level and access mode", async () => {
    const settings = await db.transaction(
      (tx) =>
        tx
          .newQuery(
            "SELECT current_setting('transaction_isolation'), current_setting('transaction_read_only'), current_setting('transaction_deferrable')",
          )
          .row(),
      { isolation: "serializable", readOnly: true, deferrable: true },
    );
    expect(settings).toEqual(["serializable", "on", "on"]);
    await expect(
      db.transaction(
        (tx) => tx.insert("customer", { email: "r@x.io" }).execute(),
        { readOnly: true },
      ),
    ).rejects.toThrow(/read-only transaction/);
    await expect(
      db.begin({ isolation: "snapshot" as "serializable" }),
    ).rejects.toThrow(RangeError);
    expect(test.pool.idleCount).toBe(test.pool.totalCount);
  });

  it("sets the timeout and runs the start query with BEGIN, in one round trip", async () => {
    const client = await test.pool.connect();
    const sent: string[] = [];
    const counted = new DB({
      connect: async () => ({
        query: (config) => {
          sent.push(config.text);
          return client.query(config);
        },
        release: (destroy) => client.release(destroy),
      }),
      query: () => Promise.reject(new Error("not used")),
    });
    const tx = await counted.begin({
      readOnly: true,
      statementTimeout: 1500,
      startQuery: "SELECT 1 AS one, 2 AS two",
    });
    expect(sent).toHaveLength(1);
    expect(tx.startRows).toEqual([{ one: 1, two: 2 }]);
    expect(
      await tx.newQuery("SELECT current_setting('statement_timeout')").column(),
    ).toEqual(["1500ms"]);
    await tx.commit();
    // SET LOCAL ends with the transaction.
    expect(
      await db.newQuery("SELECT current_setting('statement_timeout')").column(),
    ).toEqual(["0"]);
    const plain = await db.begin();
    expect(plain.startRows).toEqual([]);
    await plain.rollback();
  });

  it("cancels a statement that runs past the timeout", async () => {
    await expect(
      db.transaction((tx) => tx.newQuery("SELECT pg_sleep(1)").execute(), {
        statementTimeout: 50,
      }),
    ).rejects.toMatchObject({ code: "57014" });
    await expect(db.begin({ statementTimeout: 1.5 })).rejects.toThrow(
      RangeError,
    );
    await expect(db.begin({ statementTimeout: -1 })).rejects.toThrow(
      RangeError,
    );
    expect(test.pool.idleCount).toBe(test.pool.totalCount);
  });

  it("rejects use after commit and returns the connection", async () => {
    const tx = await db.begin();
    await tx.model("customer", { email: "t@x.io" } as Customer).insert();
    await tx.commit();
    expect(tx.done).toBe(true);
    await expect(tx.select().from("customer").all()).rejects.toBeInstanceOf(
      TxDoneError,
    );
    await expect(tx.commit()).rejects.toBeInstanceOf(TxDoneError);
    expect(await count()).toBe(4);
    expect(test.pool.idleCount).toBe(test.pool.totalCount);
  });
});

describe("logging", () => {
  it("reports queries, executions and failures", async () => {
    const queries: LogEvent[] = [];
    const execs: LogEvent[] = [];
    const logged = new DB(test.pool, {
      queryLog: (event) => queries.push(event),
      execLog: (event) => execs.push(event),
    });

    await logged
      .select("id")
      .from("customer")
      .where(hash({ id: 1 }))
      .all();
    await logged.update("customer", { name: "x" }, hash({ id: 1 })).execute();
    await expect(logged.newQuery("SELECT nope").all()).rejects.toThrow();

    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatchObject({
      sql: 'SELECT "id" FROM "customer" WHERE "id"={:p0}',
      params: { p0: 1 },
      rowCount: 1,
    });
    expect(queries[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(queries[1]?.error).toBeInstanceOf(Error);
    expect(execs).toEqual([
      expect.objectContaining({ params: { p0: "x", p1: 1 }, rowCount: 1 }),
    ]);
  });
});

describe("schema manipulation", () => {
  it("runs every DDL statement against Postgres", async () => {
    const table = `${test.schema}.ddl`;
    await db.createTable(table, { id: "int NOT NULL", ref: "int" }).execute();
    await db.addColumn(table, "label", "varchar(10)").execute();
    await db.alterColumn(table, "label", "text").execute();
    await db.renameColumn(table, "label", "title").execute();
    await db.addPrimaryKey(table, "ddl_pk", "id").execute();
    await db
      .addForeignKey(
        table,
        "ddl_ref_fk",
        ["ref"],
        ["id"],
        "customer",
        "ON DELETE CASCADE",
      )
      .execute();
    await db.createIndex(table, "ddl_title_idx", "title").execute();
    await db.createUniqueIndex(table, "ddl_ref_idx", "ref").execute();
    await db.dropIndex(table, "ddl_title_idx").execute();
    await db.dropIndex(table, "ddl_ref_idx").execute();
    await db.dropForeignKey(table, "ddl_ref_fk").execute();
    await db.dropPrimaryKey(table, "ddl_pk").execute();
    await db.dropColumn(table, "ref").execute();
    await db.truncateTable(table).execute();
    await db.renameTable(table, "ddl2").execute();

    const columns = await db
      .select("column_name")
      .from("information_schema.columns")
      .where(hash({ table_schema: test.schema, table_name: "ddl2" }))
      .orderBy("ordinal_position")
      .column();
    expect(columns).toEqual(["id", "title"]);

    await db.dropTable("ddl2").execute();
  });
});
