# @nextbasejs/dbx

Postgres query builder and data access on a [node-postgres](https://node-postgres.com) pool. It is a private package, bundled into `@nextbasejs/core`.

- SQL with named `{:name}` placeholders and quoted `{{table}}` and `[[column]]` names
- A SELECT builder, insert, upsert, update and delete, and record CRUD by primary key
- Composable conditions: `hash`, `isIn`, `like`, `between`, `exists`, `and`, `or`, `not`
- Transactions with isolation modes and nested savepoints
- Schema statements for tables, columns, constraints and indexes
- Statement logging

## Getting started

```ts
import pg from "pg";
import { DB, hash } from "@nextbasejs/dbx";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = new DB(pool);

const posts = await db
  .select("id", "title")
  .from("posts")
  .where(hash({ author: userId }))
  .orderBy("created DESC")
  .limit(20)
  .all();
```

The pool belongs to you: `DB` never ends it. Each statement may run on a different connection from the pool, so use [transactions](#transactions) for work that must share one.

Nothing is sent to Postgres until a query is run. Every query runs with one of these methods:

| Method | Returns |
| --- | --- |
| `execute()` | `{ rowsAffected }`; any returned rows are ignored |
| `all<T>()` | every row, as objects keyed by column name |
| `one<T>()` | the first row, or throws `NoRowsError` |
| `column<T>()` | the first column of every row |
| `row<T>()` | the first row as an array of values, or throws `NoRowsError` |

`T` is not checked at runtime.

## Raw SQL

```ts
const post = await db
  .newQuery("SELECT * FROM {{posts}} WHERE [[id]]={:id}")
  .bind({ id })
  .one();
```

- `{:name}` becomes `$1`, `$2`, ... and its value is sent separately, never written into the SQL. A name used twice reuses its number.
- `{{table}}` and `[[column]]` become quoted identifiers. A dot separates schema, table and column: `{{nextbase.posts}}`.
- These tokens are only recognized in SQL code. Text inside string literals, quoted identifiers, dollar-quoted strings and comments is left alone.
- Positional `$1` parameters are rejected; use `{:name}`.
- Running a query that has a placeholder with no bound value throws.
- SQL with several statements separated by `;` can only run without placeholders. Its result is that of the last statement.

`query.sql` is the SQL as written and `query.rawSQL` is the SQL sent to Postgres.

## SELECT

```ts
const rows = await db
  .select("p.id", "p.title", "u.name AS author")
  .from("posts p")
  .leftJoin("users u", exp("u.id = p.author"))
  .where(hash({ "p.status": "published" }))
  .andWhere(like("p.title", search))
  .orderBy("p.created DESC NULLS LAST")
  .limit(20)
  .offset(40)
  .all();
```

- `select()` with no columns selects `*`. Columns and tables may have an alias: `"name AS n"`, `"name n"` or `"posts p"`.
- `where()`, `orderBy()`, `groupBy()` and `having()` replace their clause; `andWhere()`, `orWhere()`, `andOrderBy()` and the other `and...` and `or...` methods add to it.
- `join(type, table, on?)` takes any join type, such as `"CROSS JOIN"`; `innerJoin`, `leftJoin` and `rightJoin` are shortcuts.
- `distinct(true)` writes `SELECT DISTINCT`; `selectOption()` writes any SQL after `SELECT`, such as `"DISTINCT ON (author)"`.
- `union(query)` and `unionAll(query)` append another query. Parameters bound to the same name with different values in the two queries are renamed, so neither overwrites the other.
- `one()` and `row()` add `LIMIT 1` when there is no limit and no union.
- `model(pk)` returns the row of `from()`'s table whose primary key is `pk`, combined with the WHERE clause.
- `bind()` and `andBind()` supply values for placeholders used in `exp()` conditions.
- `build()` returns the `Query` without running it.

## Conditions

Conditions are `Expression` objects, used by `where()`, `having()`, join `on`, `update()` and `delete()`.

| Function | SQL |
| --- | --- |
| `hash({ a: 1, b: null, c: [1, 2] })` | `"a"=$1 AND "b" IS NULL AND "c" IN ($2, $3)` |
| `isIn("a", 1, 2)` / `notIn(...)` | `"a" IN ($1, $2)` / `"a" NOT IN ($1, $2)` |
| `like("title", "go")` | `"title" LIKE $1` with `$1 = '%go%'` |
| `notLike`, `orLike`, `orNotLike` | the same, negated or joined by OR |
| `between("age", 18, 30)` / `notBetween(...)` | `"age" BETWEEN $1 AND $2` |
| `exists(exp("SELECT 1 ..."))` / `notExists(...)` | `EXISTS (SELECT 1 ...)` |
| `and(a, b)` / `or(a, b)` | `(a) AND (b)` / `(a) OR (b)` |
| `not(a)` | `NOT (a)` |
| `exp("age > {:min}", { min: 18 })` | raw SQL with its own parameters |

Details worth knowing:

- An `undefined` value in `hash()`, `isIn()` or `notIn()` throws. Skipping it would silently widen the condition, for example from one row to every row.
- A `null` value becomes an explicit `IS NULL` or `IS NOT NULL` test, because `= NULL` and `IN (NULL)` never match.
- `isIn()` with no values matches nothing; `notIn()` with no values has no effect.
- An Expression value in `isIn()` or `notIn()` is written as its own `IN (...)` or `NOT IN (...)`, so it may be a sub-query: `isIn("id", exp("SELECT post FROM likes"))`.
- `and()` and `or()` skip `null` and `undefined`, so optional filters can be passed directly.
- An empty expression, such as `hash({})` or `notIn("a")`, has no effect: it matches every row. So `and()` skips it, `or()` with it is empty too, and `not()` of it matches nothing.
- LIKE values are escaped and wrapped in `%`, so they match as literal substrings. `.match(left, right)` controls the `%` on each side, `.escape()` sets the escape pairs (with no arguments, values are used as patterns), and `.caseInsensitive()` uses `ILIKE`.

## Writing rows

```ts
await db.insert("posts", { title: "Hello", author: userId }).execute();

await db.upsert("tags", { name: "news", label: "News" }, "name").execute();

await db
  .update("posts", { status: "archived" }, hash({ author: userId }))
  .execute();

await db.delete("posts", hash({ id })).execute();
```

- `undefined` values are skipped. An Expression value is written as SQL, as in `exp("now()")`.
- `insert()` with no columns writes `DEFAULT VALUES`.
- `upsert(table, cols, ...constraintColumns)` writes `ON CONFLICT (...) DO UPDATE`, setting every column to its new value, or `DO NOTHING` when there are no columns.
- `update()` throws when no column is left to set.
- `update()` and `delete()` without a condition affect every row.

## Models

`model()` inserts, updates or deletes one record by its primary key. Record keys are column names.

```ts
const post = { id: null, title: "Hello" };
await db.model("posts", post).insert(); // post.id is now the generated id

post.title = "Hi";
await db.model("posts", post).update("title");

await db.model("posts", post).delete();
```

- The primary key is `id` unless `{ pk: "slug" }` or a composite `{ pk: ["a", "b"] }` is passed.
- `insert(...cols)` and `update(...cols)` limit the columns written; `exclude(...cols)` leaves columns out.
- When a single-column key is `null` or `undefined`, `insert()` leaves it to the database default and writes the generated value back to the record.
- `update()` and `delete()` throw `MissingPKError` when the key has no value, rather than matching other rows. `update()` never sets key columns.

## Transactions

```ts
await db.transaction(async (tx) => {
  await tx.insert("posts", { title: "Hello" }).execute();
  await tx.update("users", { posts: exp("posts + 1") }, hash({ id })).execute();
});
```

- `Tx` has every query method of `DB`, all running on one connection.
- `transaction()` commits when the callback resolves and rolls back when it rejects. If the rollback fails too, it rejects with an `AggregateError` holding both errors.
- Options set the transaction modes: `{ isolation: "serializable", readOnly: true, deferrable: true }`.
- `tx.transaction(fn)` runs `fn` in a savepoint. When `fn` rejects, only its changes are rolled back and the outer transaction stays usable. The same happens when `fn` resolves after a statement in it failed, and then `tx.transaction()` rejects with `TxAbortedError`.
- `commit()` rejects with `TxAbortedError` when Postgres rolled the transaction back instead, because a statement in it failed and the error was caught.
- `db.begin()` returns a `Tx` to finish yourself with `commit()` or `rollback()`. One of them must always be called, or the connection is never returned to the pool.
- After commit or rollback, every query on the `Tx` throws `TxDoneError`.

## Schema

```ts
await db
  .createTable("posts", {
    id: "uuid PRIMARY KEY DEFAULT gen_random_uuid()",
    title: "text NOT NULL",
    author: "uuid",
  })
  .execute();

await db
  .addForeignKey("posts", "posts_author_fk", ["author"], ["id"], "users", "ON DELETE CASCADE")
  .execute();
await db.createIndex("posts", "posts_title_idx", "lower(title)").execute();
```

Also available: `renameTable`, `dropTable`, `truncateTable`, `addColumn`, `dropColumn`, `renameColumn`, `alterColumn`, `addPrimaryKey`, `dropPrimaryKey`, `dropForeignKey`, `createUniqueIndex` and `dropIndex`.

Column definitions, types and statement options are SQL and used as written. Names are quoted.

## Timeouts

dbx does not cancel statements itself. Postgres's `statement_timeout` stops a statement on the
server; set it for a transaction with `SET LOCAL`, which works through transaction poolers such as
PgBouncer, or for a role with `ALTER ROLE ... SET statement_timeout`:

```ts
await db.transaction(async (tx) => {
  await tx.newQuery("SET LOCAL statement_timeout = 5000").execute();
  // ...
});
```

## Options

```ts
const db = new DB(pool, {
  queryLog: (event) => logger.debug(event),
  execLog: (event) => logger.debug(event),
  types: { getTypeParser },
});
```

| Option | Description |
| --- | --- |
| `queryLog` | Called after each `all`, `one`, `column` or `row` statement, with `{ sql, params, durationMs, rowCount?, error? }` |
| `execLog` | The same, for `execute()` |
| `types` | Result column parsers for this DB only, as node-postgres's per-query `types` |

`params` in log events holds every bound value, including secrets such as password hashes. Redact it before writing logs.

## Safety

- Values are always sent as bound parameters.
- Names given to insert, upsert, update, delete, models, conditions and schema statements are always quoted, so they are safe for any input.
- The SELECT builder's columns, tables, ORDER BY and GROUP BY, and index columns, also accept SQL expressions such as `count(*)`. A name there containing `(`, `{{` or `[[` is used as written, so only pass names you have validated.
- LIMIT and OFFSET must be integers, and transaction modes are checked before being written into SQL.

## Development

The tests run against a real Postgres. Each test file works in its own temporary schema.

```sh
createdb nextbase_test
pnpm --filter @nextbasejs/dbx test
```

`NEXTBASE_TEST_DATABASE_URL` sets the database, and defaults to `postgres://localhost/nextbase_test`.
