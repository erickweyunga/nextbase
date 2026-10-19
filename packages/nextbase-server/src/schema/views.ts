import type { Collection, Field, ViewCollection } from "@nextbase/client";
import type { Builder, Tx } from "@nextbase/dbx";
import { SCHEMA, table } from "../db/system.ts";
import { ApiError } from "../errors.ts";
import { LOWER_ALPHANUMERIC, randomString } from "../random.ts";
import { fieldNameProblem } from "./fields.ts";

// View collections run their query as a dedicated database role with the
// least privilege that serves them: SELECT on collection tables, minus the
// password and tokenKey columns of auth collections, and nothing else. So
// Postgres itself keeps views from secrets, NextBase's system tables (sessions,
// secrets), other schemas and privileged functions. The role owns the views,
// which makes Postgres check their tables against its privileges, and every
// read of a view runs as it (SET LOCAL ROLE), because functions in a view run
// with the privileges of whoever queries it.

/** Auth columns the view role is never granted. */
const SECRET_COLUMNS: ReadonlySet<string> = new Set(["password", "tokenKey"]);

/** The view role, or null before the first view collection. */
export async function readViewRole(q: Builder): Promise<string | null> {
  const [role] = await q
    .newQuery(`SELECT view_role FROM {{${table("_meta")}}}`)
    .column<string | null>();
  return role ?? null;
}

/**
 * The view role, created on first use. Roles belong to the whole Postgres
 * cluster, so its name is random, and creating it needs the CREATEROLE
 * attribute; without it, view collections are unavailable.
 */
export async function ensureViewRole(tx: Tx): Promise<string> {
  const existing = await readViewRole(tx);
  if (existing) return existing;
  const role = `nextbase_views_${randomString(16, LOWER_ALPHANUMERIC)}`;
  const quoted = tx.quoteSimpleColumnName(role);
  try {
    await tx.transaction(async () => {
      await tx.newQuery(`CREATE ROLE ${quoted} NOLOGIN NOINHERIT`).execute();
      // Lets NextBase SET ROLE to it. A CREATEROLE user may grant roles it
      // created; a superuser may grant any.
      await tx.newQuery(`GRANT ${quoted} TO CURRENT_USER`).execute();
    });
  } catch (error) {
    throw new ApiError(
      400,
      `View collections need a database role of their own, which NextBase could not create: ${(error as Error).message}. Give NextBase's database user the CREATEROLE attribute, or have an administrator run: CREATE ROLE ${quoted} NOLOGIN NOINHERIT; GRANT ${quoted} TO <NextBase's user>; UPDATE ${SCHEMA}._meta SET view_role = '${role}';`,
    );
  }
  await tx
    .newQuery(`UPDATE {{${table("_meta")}}} SET view_role = {:role}`)
    .bind({ role })
    .execute();
  return role;
}

/**
 * Grants the view role SELECT on every base and auth collection table, minus
 * auth secrets, after a schema change. Views it owns keep their own access.
 */
export async function grantViewRole(
  tx: Tx,
  role: string,
  collections: readonly Collection[],
): Promise<void> {
  const quoted = tx.quoteSimpleColumnName(role);
  const exec = (sql: string): Promise<unknown> => tx.newQuery(sql).execute();
  await exec(`GRANT USAGE ON SCHEMA {{${SCHEMA}}} TO ${quoted}`);
  for (const collection of collections) {
    if (collection.type === "view") continue;
    const t = `{{${table(collection.name)}}}`;
    await exec(`REVOKE ALL ON TABLE ${t} FROM ${quoted}`);
    if (collection.type === "base") {
      await exec(`GRANT SELECT ON TABLE ${t} TO ${quoted}`);
      continue;
    }
    const columns = collection.fields
      .filter((f) => !SECRET_COLUMNS.has(f.name))
      .map((f) => tx.quoteSimpleColumnName(f.name));
    // Column grants survive a table-level REVOKE, so secrets are revoked by name.
    await exec(
      `REVOKE SELECT ("password", "tokenKey") ON TABLE ${t} FROM ${quoted}`,
    );
    await exec(
      `GRANT SELECT (${columns.join(", ")}) ON TABLE ${t} TO ${quoted}`,
    );
  }
}

/**
 * Runs view DDL as the view role, which owns the views, with collection
 * tables first on the search path. The role holds CREATE on the schema, which
 * creating and renaming views need, only meanwhile.
 */
async function asViewRole<T>(
  tx: Tx,
  role: string,
  run: () => Promise<T>,
): Promise<T> {
  const quoted = tx.quoteSimpleColumnName(role);
  const [path] = await tx
    .newQuery("SELECT current_setting('search_path')")
    .column<string>();
  await tx
    .newQuery(`GRANT CREATE ON SCHEMA {{${SCHEMA}}} TO ${quoted}`)
    .execute();
  await tx.newQuery(`SET LOCAL ROLE ${quoted}`).execute();
  await tx
    .newQuery("SELECT set_config('search_path', {:path}, true)")
    .bind({ path: tx.quoteSimpleTableName(SCHEMA) })
    .execute();
  const result = await run();
  // Transaction-scoped, like the SET LOCAL ROLE it undoes.
  await tx.newQuery("SET LOCAL ROLE NONE").execute();
  await tx
    .newQuery("SELECT set_config('search_path', {:path}, true)")
    .bind({ path: path ?? "" })
    .execute();
  await tx
    .newQuery(`REVOKE CREATE ON SCHEMA {{${SCHEMA}}} FROM ${quoted}`)
    .execute();
  return result;
}

/**
 * Runs reads of a view collection as the view role, in their own
 * transaction: functions in a view run with the privileges of the caller.
 */
export function readAsViewRole<T>(
  db: { transaction<R>(fn: (tx: Tx) => Promise<R>): Promise<R> },
  role: string | null,
  run: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (role === null)
    throw new Error("A view collection exists without a view role.");
  return db.transaction(async (tx) => {
    await tx
      .newQuery(`SET LOCAL ROLE ${tx.quoteSimpleColumnName(role)}`)
      .execute();
    return run(tx);
  });
}

/**
 * Creates the Postgres view of a validated view collection, or with `replace`
 * redefines it, and returns its fields, derived from the query's columns.
 * Fields keep the ids of same-named fields in `previous`. Throws a 400 when
 * the query is invalid or reads what the view role may not.
 */
export async function createView(
  tx: Tx,
  role: string,
  view: ViewCollection,
  {
    previous = [],
    replace = false,
  }: { previous?: readonly Field[]; replace?: boolean } = {},
): Promise<Field[]> {
  // On its own lines, so a trailing -- comment cannot swallow what follows.
  const source = `\n${view.viewQuery.replace(/;\s*$/, "")}\n`;
  return asViewRole(tx, role, async () => {
    // First as written, under a scratch name, to learn its columns.
    const scratch = table(`_view_${view.id}`);
    await query(tx, `CREATE VIEW {{${scratch}}} AS ${source}`);
    // Reading it checks the role's privileges on everything it uses.
    await query(tx, `SELECT * FROM {{${scratch}}} LIMIT 0`);
    const columns = await tx
      .newQuery(
        `SELECT a.attname AS name, t.typname AS type, t.typcategory AS category
         FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
         WHERE a.attrelid = {:view}::regclass AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attnum`,
      )
      .bind({ view: scratch })
      .all<{ name: string; type: string; category: string }>();
    await tx.newQuery(`DROP VIEW {{${scratch}}}`).execute();
    const typed = columns.map((column) => typeColumn(column));
    if (!typed.some((c) => c.name === "id")) {
      throw invalidQuery(
        "The query needs an id column, unique per row, e.g. SELECT p.id, ...",
      );
    }

    // Then wrapped, so every column has the type its field reads.
    const select = typed
      .map(
        (c) =>
          `${c.cast(`"q".${tx.quoteSimpleColumnName(c.name)}`)} AS ${tx.quoteSimpleColumnName(c.name)}`,
      )
      .join(", ");
    const target = `{{${table(view.name)}}}`;
    const definition = `AS SELECT ${select} FROM (${source}) AS "q"`;
    if (!replace) {
      await query(tx, `CREATE VIEW ${target} ${definition}`);
    } else {
      try {
        // Keeps views that read this one, when the columns stay compatible.
        await tx.transaction(() =>
          tx
            .newQuery(`CREATE OR REPLACE VIEW ${target} ${definition}`)
            .execute(),
        );
      } catch (error) {
        // Columns removed, renamed or retyped: only a new view will do.
        if ((error as { code?: unknown }).code !== "42P16") {
          throw invalidQuery((error as Error).message);
        }
        await tx.newQuery(`DROP VIEW ${target}`).execute();
        await query(tx, `CREATE VIEW ${target} ${definition}`);
      }
    }
    const ids = new Map(previous.map((f) => [f.name, f.id]));
    return typed.map((c) =>
      c.field(ids.get(c.name) ?? randomString(10, LOWER_ALPHANUMERIC)),
    );
  });
}

/** Renames a view collection's Postgres view. */
export async function renameView(
  tx: Tx,
  role: string,
  from: string,
  to: string,
): Promise<void> {
  await asViewRole(tx, role, () =>
    tx
      .newQuery(
        `ALTER VIEW {{${table(from)}}} RENAME TO ${tx.quoteSimpleTableName(to)}`,
      )
      .execute(),
  );
}

/** Drops a view collection's Postgres view. */
export async function dropView(
  tx: Tx,
  role: string,
  name: string,
): Promise<void> {
  await asViewRole(tx, role, () =>
    tx.newQuery(`DROP VIEW {{${table(name)}}}`).execute(),
  );
}

/** Runs part of a view's definition; Postgres's errors are the query's fault. */
async function query(tx: Tx, sql: string): Promise<void> {
  try {
    await tx.newQuery(sql).execute();
  } catch (error) {
    throw invalidQuery((error as Error).message);
  }
}

function invalidQuery(message: string): ApiError {
  return new ApiError(400, "Failed to validate the collection.", {
    viewQuery: { code: "validation_invalid_query", message },
  });
}

interface TypedColumn {
  name: string;
  /** The column's SQL in the wrapping view, cast to its field's storage type. */
  cast(sql: string): string;
  field(id: string): Field;
}

/** Maps a query column to a field, or throws for names and types views cannot expose. */
function typeColumn(column: {
  name: string;
  type: string;
  category: string;
}): TypedColumn {
  const { name, type, category } = column;
  const problem = fieldNameProblem(name);
  if (problem) {
    throw invalidQuery(
      `Column "${name}": ${problem} Name every column with AS, e.g. count(c.id) AS comments.`,
    );
  }
  const base = { name, system: false, required: false, hidden: false };
  if (category === "S" || type === "uuid" || type === "name") {
    return {
      name,
      cast: (sql) => `${sql}::text`,
      field: (id) => ({
        ...base,
        id,
        type: "text",
        min: 0,
        max: 0,
        pattern: "",
        primaryKey: false,
      }),
    };
  }
  if (name === "id") {
    throw invalidQuery(
      `The id column must be text, not ${type}; cast it, e.g. id::text.`,
    );
  }
  if (category === "N" && type !== "oid") {
    return {
      name,
      cast: (sql) => `${sql}::double precision`,
      field: (id) => ({
        ...base,
        id,
        type: "number",
        min: null,
        max: null,
        onlyInt: false,
      }),
    };
  }
  if (category === "B") {
    return {
      name,
      cast: (sql) => sql,
      field: (id) => ({ ...base, id, type: "bool" }),
    };
  }
  if (type === "timestamptz" || type === "timestamp" || type === "date") {
    return {
      name,
      // A date or timestamp without a zone is read as UTC, as NextBase stores dates.
      cast: (sql) =>
        type === "timestamptz" ? sql : `(${sql}::timestamp AT TIME ZONE 'UTC')`,
      field: (id) => ({ ...base, id, type: "date", min: "", max: "" }),
    };
  }
  if (type === "jsonb" || type === "json") {
    return {
      name,
      cast: (sql) => `${sql}::jsonb`,
      field: (id) => ({ ...base, id, type: "json", maxSize: 0 }),
    };
  }
  throw invalidQuery(
    `Column "${name}" has type ${type}, which views cannot expose. Cast it to text, a number, a timestamp or JSON, e.g. to_jsonb(${name}).`,
  );
}
