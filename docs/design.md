# NextBase v1 design

Status: draft, 2026-10-18

NextBase is a backend toolkit that runs inside a Next.js application. One route file mounts a
complete backend at `/api/nextbase`: runtime-defined collections stored in Postgres, access rules,
authentication, file storage, auto-generated REST APIs, an admin UI and a typed client SDK.

It is built around collections, access rules, auth collections and a filter language. The implementation is designed for Postgres and for how Next.js apps are
actually deployed, including serverless platforms.

## 1. Scope

### Goals for v1

- Collections defined at runtime via the admin UI, stored in Postgres, with real tables and columns.
- Records CRUD with filtering, sorting, pagination, relation expansion and field selection.
- API rules per collection and action, written in a filter language.
- Auth collections: email/password, token refresh, email verification, password reset, email change.
- Superusers, with a safe first-run bootstrap.
- File fields backed by local disk or S3-compatible storage.
- Admin UI embedded in the package and served from the same route.
- Client SDK that works in the browser and in-process on the server.
- Schema export/import, so a schema built in development can be applied to production.

### Non-goals for v1

Realtime subscriptions, OAuth2, OTP and MFA, server-side hooks, image thumbnails, backups, a request-log UI, multi-tenancy, the Edge runtime, and databases other than
Postgres. The design leaves room for each, but none of them shape v1 code.

### Platform choices

Where Postgres or the web platform offers a native answer, NextBase uses it: ISO 8601
timestamps, `Authorization: Bearer`, SQL `NULL` for blank dates and relations, and safe
"all elements match" semantics (section 6.3).

## 2. Architecture

```
app/api/nextbase/[...path]/route.ts
        │  GET/POST/PATCH/DELETE (Web Request)
        ▼
new NextBase(options) ──► router ──► body limits ──► principal resolution ──► schema cache check
                                                                                    │
         ┌───────────────┬──────────────┬──────────────┬──────────────┬─────────────┤
         ▼               ▼              ▼              ▼              ▼             ▼
    collections API  records API    auth API      files API      admin UI     health
         │               │              │              │
         ▼               ▼              ▼              ▼
    schema sync    filter/rule      tokens,        storage driver
    (DDL)          compiler (SQL)   passwords      (local | S3)
         └───────────────┴──────┬───────┘
                                ▼
                          Postgres (pg)
```

### 2.1 Package layout

Runtime code is published as four packages, versioned together (a Changesets `fixed` group):
`@nextbase/client` (the SDK and the wire types), `@nextbase/server` (which depends on the client),
and the adapters `@nextbase/next` and `@nextbase/react`, which take the core packages, `next` and
`react` as peer dependencies. The server is framework-agnostic: `handle(request)` takes a
web-standard `Request` and returns a `Response`, and the in-process client takes any cookie store
with `get` and `set`. Paths below are within those packages.

| Module                 | Responsibility                                               |
| ---------------------- | ------------------------------------------------------------ |
| `server/`              | `NextBase` class, router, request pipeline, API handlers    |
| `server/db/`           | Pool, transactions, system migrations, SQL helpers           |
| `server/schema/`       | Collection and field model, validation, schema sync engine   |
| `server/filter/`       | Tokenizer, parser, resolver and SQL compiler for filters     |
| `server/records/`      | Value normalization, validation, CRUD, expand, serialization |
| `server/auth/`         | Tokens, password hashing, auth flows, cookies, mail          |
| `server/files/`        | Upload pipeline, storage drivers, file serving               |
| `client/`              | SDK, auth store, `filter()` helper                           |
| `next/`                | Next.js adapter: `newNextHandler()`, `serverClient()` reading `cookies()` |
| `react/`               | React bindings: `NextBaseProvider`, `useSession()`, `useNextBase()` |
| `shared/`              | Wire types shared by server and client                       |

The admin UI stays in the private `@nextbase/admin` package and is embedded at build time.

### 2.2 Runtime

- Route handlers run on the Node.js runtime, which is the Next.js default. The Edge runtime is
  unsupported because it has no TCP Postgres or filesystem access.
- `new NextBase()` is called once at module scope; the constructor never does I/O. Initialization is lazy: the first request
  connects, runs system migrations and loads the schema. Concurrent first requests share one
  initialization promise.
- In `next dev`, modules are re-evaluated on change. The pool is cached on `globalThis`, keyed by
  connection string, so hot reloads do not leak connections.
- Every database interaction is transaction-scoped: no session state, no `LISTEN`, no named
  prepared statements. That keeps NextBase compatible with PgBouncer in transaction mode and with
  serverless poolers (Neon, Supabase, RDS Proxy).

### 2.3 Configuration

```ts
// lib/nextbase.ts
import "server-only";
import { NextBase, s3Storage } from "@nextbase/server";

export const nextbase = new NextBase({
  database: process.env.DATABASE_URL, // or a pg-compatible Pool
  storage: s3Storage({ bucket, region, endpoint, accessKeyId, secretAccessKey }),
  mail: { from: "app@example.com", send: async (message) => { /* Resend, SES, SMTP... */ } },
});
```

| Option           | Default                                  | Notes                                                    |
| ---------------- | ---------------------------------------- | -------------------------------------------------------- |
| `database`       | `process.env.DATABASE_URL`               | Connection string, or a `pg.Pool`-compatible object (for example `@neondatabase/serverless`). |
| `storage`        | `localStorage({ dir: ".nextbase/storage" })` | Logs a warning at startup if local storage is used on a known serverless platform. |
| `mail`           | none                                     | `{ from, send(message), appUrl, templates? }`. Without it, endpoints that send mail return 400 `mail_not_configured` in production; in development, messages are logged instead (section 7.4). |
| `waitUntil`      | Vercel's `waitUntil`                     | Keeps background work, such as sending mail, alive after the response on serverless platforms. |
| `basePath`       | `/api/nextbase`                          | Already implemented.                                     |
| `trustedOrigins` | none                                     | Other hosts allowed to make cookie-authenticated writes, as in Next.js's `serverActions.allowedOrigins`: `app.example.com`, `*.example.com` (one label), `**.example.com` (section 7.6). |
| `trustProxy`     | `false`                                  | Take the request's host from `X-Forwarded-Host`, set by a proxy you run (section 7.6). |
| `statementTimeout` | `8000` ms                              | How long a records API statement may run (section 5.3). `0` turns it off. |

There are no other knobs. Values such as token lifetimes and size limits are per-collection
settings edited in the admin UI, not code configuration.

### 2.4 Database driver

NextBase uses `pg` (node-postgres). Reasons: it is the most widely deployed driver, serverless
drivers mirror its `Pool` interface, and it binds parameters natively, which the filter compiler
relies on.

No ORM is used. Collections are defined at runtime, so a static schema tool like Drizzle or Prisma
cannot describe them. SQL goes through the private `@nextbase/dbx` package, a Postgres-only query
builder: named `{:name}` parameters numbered as `$n`, identifier quoting, composable condition expressions,
SELECT/DML/DDL builders, record-level insert/update/delete and transactions. It is bundled into
`@nextbase/server`. Names are validated against the name regex before they reach it, and values
are never interpolated into SQL text.

## 3. Database layout

All NextBase objects live in a dedicated Postgres schema, `nextbase`, so they never collide with an
app's own tables in `public`. System tables start with `_`. Collection names cannot, so the two
never clash. Postgres 16 or newer is required (checked at startup), with `DateStyle` ISO and
`standard_conforming_strings` on (both defaults); startup refuses other settings with instructions.

```sql
CREATE SCHEMA nextbase;

CREATE TABLE nextbase._migrations (
  name    text PRIMARY KEY,
  applied timestamptz NOT NULL DEFAULT now()
);

-- Single-row table.
CREATE TABLE nextbase._meta (
  id             boolean PRIMARY KEY DEFAULT true CHECK (id),
  schema_version bigint  NOT NULL DEFAULT 1,
  setup_secret   text                -- random; signs the first-run setup token
);

CREATE TABLE nextbase._collections (
  id          text PRIMARY KEY,
  type        text NOT NULL CHECK (type IN ('base', 'auth')),
  name        text NOT NULL,
  system      boolean NOT NULL DEFAULT false,
  fields      jsonb NOT NULL,
  indexes     jsonb NOT NULL DEFAULT '[]',
  options     jsonb NOT NULL DEFAULT '{}',
  list_rule   text,
  view_rule   text,
  create_rule text,
  update_rule text,
  delete_rule text,
  created     timestamptz NOT NULL DEFAULT now(),
  updated     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON nextbase._collections (lower(name));

-- Failed password attempts, for throttling (section 7.5).
CREATE TABLE nextbase._auth_attempts (
  key        text PRIMARY KEY,      -- collectionId + ":" + lower(identity)
  failures   integer NOT NULL,
  window_end timestamptz NOT NULL
);
```

Each collection is a real table, `nextbase."<collection name>"`, with one column per field. Column
names equal field names, so the tables are readable from raw SQL or another ORM. Reading them
directly is fine. Writing them directly bypasses validation and rules, and hand-written DDL on them
is unsupported.

### 3.1 System migrations

System tables are created and upgraded by ordered, append-only migrations bundled in the package.
On initialization, NextBase runs pending migrations in one transaction, holding
`pg_advisory_xact_lock(<NextBase key>)`. That makes concurrent cold starts across instances safe.
A migration is never edited after release.

`nextbase.migrate()` exposes the same step for deploy scripts that prefer to migrate before traffic
arrives.

## 4. Collections and fields

### 4.1 Naming

- Collection and field names match `^[A-Za-z][A-Za-z0-9_]{0,62}$`. That is at most 63 bytes,
  Postgres's identifier limit, and quoting is always safe.
- Collection names are unique case-insensitively. Field names are unique case-insensitively within
  a collection.
- Reserved field names: `expand`, `collectionId`, `collectionName`, plus the system fields of the
  collection's type.

### 4.2 Collection types and system fields

| Type   | System fields                                                                 |
| ------ | ----------------------------------------------------------------------------- |
| `base` | `id`, plus `created` and `updated` (added by default, removable)               |
| `auth` | the base fields, plus `email`, `emailVisibility`, `verified`, `password`, `tokenKey` |
| `view` | none: every field comes from the query's columns (section 4.10)                |

`_superusers` is a system auth collection created by the first migration. All of its rules are
`null`, so only superusers can manage it. It cannot be deleted or renamed.

Record ids are 15 characters from `[a-z0-9]`, generated with `crypto.getRandomValues`. Clients may
supply their own id on create if it matches that pattern. Column:
`id text PRIMARY KEY CHECK (id ~ '^[a-z0-9]{15}$')`.

### 4.3 Field definitions

Field definitions are stored in `_collections.fields` as a JSON array. Each field has a stable,
random `id` that never changes. Options sit flat on the field:

```json
{ "id": "k3j2h1g9xa", "name": "title", "type": "text", "system": false,
  "required": true, "hidden": false, "min": 0, "max": 200, "pattern": "" }
```

### 4.4 Field types

Blank values are explicit. Most types are `NOT NULL` with a zero-value default, so filters work
with two-valued logic. Types where a zero value would be a lie (dates, JSON) or would break a
foreign key (single relations) use SQL `NULL` as their blank value. The API serializes blanks
uniformly (column "API blank"), and the filter compiler knows each type's blank (section 6.3).

| Type       | Column (single)                                 | Column (multiple)              | API blank | Options |
| ---------- | ----------------------------------------------- | ------------------------------ | --------- | ------- |
| `text`     | `text NOT NULL DEFAULT ''`                      | -                              | `""`      | `min`, `max` (default 5000), `pattern` |
| `number`   | `double precision NOT NULL DEFAULT 0`           | -                              | `0`       | `min`, `max`, `onlyInt` |
| `bool`     | `boolean NOT NULL DEFAULT false`                | -                              | `false`   | - |
| `email`    | `text NOT NULL DEFAULT ''`                      | -                              | `""`      | `onlyDomains`, `exceptDomains` |
| `url`      | `text NOT NULL DEFAULT ''`                      | -                              | `""`      | `onlyDomains`, `exceptDomains` |
| `date`     | `timestamptz NULL`                              | -                              | `""`      | `min`, `max` |
| `autodate` | `timestamptz NOT NULL`                          | -                              | n/a       | `onCreate`, `onUpdate` |
| `select`   | `text NOT NULL DEFAULT ''`                      | `text[] NOT NULL DEFAULT '{}'` | `""` / `[]` | `values`, `maxSelect` |
| `relation` | `text NULL REFERENCES <target>(id)`             | `text[] NOT NULL DEFAULT '{}'` | `""` / `[]` | `collectionId`, `maxSelect`, `cascadeDelete` |
| `file`     | `text NOT NULL DEFAULT ''`                      | `text[] NOT NULL DEFAULT '{}'` | `""` / `[]` | `maxSelect`, `maxSize` (default 5 MB), `mimeTypes`, `protected` |
| `json`     | `jsonb NULL`                                    | -                              | `null`    | `maxSize` (default 1 MB) |
| `password` | `text NOT NULL` (auth collections only)         | -                              | never output | `min` (default 8), `max` (default 256) |

All fields also have `required` and `hidden`. `required` means "not blank". `hidden` removes the
field from API output and from client filters and sorts. `password` and `tokenKey` are always
hidden.

Value constraints (min, max, pattern, domains, select values, MIME types) are enforced by
application validation, not `CHECK` constraints. Tightening an option should not fail a migration
because of rows that already exist. The database enforces structure: types, primary keys, foreign
keys and unique indexes.

Timestamps are serialized as ISO 8601 UTC with milliseconds: `2026-10-18T09:30:00.000Z`.

### 4.5 Relations and integrity

- **Single relations** get a real foreign key with `ON DELETE NO ACTION`. NextBase handles
  deletions itself (below) before deleting the referenced row. The foreign key is a backstop: a raw
  SQL delete fails instead of leaving a dangling reference.
- **Multiple relations** are `text[]` with a GIN index. Postgres cannot put foreign keys on array
  elements, so integrity is enforced in the transaction:
  - On write, referenced ids are checked with `SELECT id FROM target WHERE id = ANY($1) FOR KEY SHARE`.
  - On delete, the referenced row is locked.
  - The two locks conflict, so a concurrent write cannot reference a row that is being deleted.
- **Deleting a referenced record**, for each relation field that targets it:
  - `cascadeDelete: true`: referencing records are deleted, recursively, in the same transaction.
    A visited set guards against cycles.
  - Otherwise the id is removed from the referencing field (`array_remove`, or `NULL` for single
    relations). If that leaves a `required` field blank, the whole delete fails with 400.

### 4.6 Indexes

Indexes are stored as structured definitions, never as raw SQL:

```json
{ "name": "idx_posts_slug", "unique": true, "fields": ["<fieldId>"], "type": "btree" }
```

`type` is `btree` (equality, ranges, sorting) or `trigram` (`~` contains matching on text fields,
never unique). The first trigram index installs Postgres's `pg_trgm` extension, which needs the
CREATE privilege on the database; without it the change fails with a 400 naming the fix.

Referencing fields by id keeps indexes valid across renames. The DDL is generated as
`CREATE [UNIQUE] INDEX <name> ON nextbase."<table>" (<columns>)`. System indexes are always
present:

- auth collections: `UNIQUE (lower(email)) WHERE email <> ''`, and `UNIQUE (tokenKey)`
- a btree index on every single relation, which rules, back-relations and cascades look up by
- a GIN index on every multiple relation, select and file column
- `(created, id)` when the collection has a `created` autodate field, which serves the default
  `-created` list order (the `id` tiebreaker follows the last sort column's direction)

Expression and partial indexes for user-defined indexes are deferred.

### 4.7 Schema sync

Every create, update or delete of a collection, and every import, runs through one sync engine, in
one transaction. Postgres DDL is transactional, so the metadata and the tables can never disagree:

1. `pg_advisory_xact_lock(<schema key>)` serializes schema changes across instances.
2. Load the current definition with `SELECT ... FOR UPDATE`.
3. Validate the new definition:
   - names and options
   - type rules (below)
   - index field ids
   - every rule of every collection compiles against the new schema
4. Diff fields by `id`:
   - added → `ADD COLUMN`
   - removed → `DROP COLUMN`
   - renamed → `RENAME COLUMN`
   - single ↔ multiple toggles for `select`, `relation` and `file` → `ALTER COLUMN ... TYPE ... USING`,
     which converts the data and swaps the foreign key or GIN index
   - any other type change is rejected with 400; changing a type means deleting the field and adding a new one
5. Diff indexes by name, then drop and create.
6. Rename the table if the collection name changed.
7. Write `_collections`, then `UPDATE _meta SET schema_version = schema_version + 1`.
8. Commit. Files of dropped file fields or collections are deleted afterwards (section 8.4).

Rules are stored as text that references field names, so the invariant in step 3 matters: a rename
that would break any rule, including another collection's rule that reaches this collection through
a relation or `@collection`, is rejected with a field error naming the rule. The admin UI offers to
rewrite the affected rules in the same save.

A collection cannot be deleted while relation fields in other collections reference it.

### 4.8 Schema cache

Each instance keeps the parsed schema and compiled rule ASTs in memory, tagged with
`schema_version`. Each request reads `SELECT schema_version FROM nextbase._meta`, a primary-key
lookup on a one-row table, and reloads the cache if the version changed.

A stale cache is a security problem: a rule tightened on one instance must take effect on all of
them. TTLs and `LISTEN/NOTIFY` either allow staleness or do not work behind transaction poolers and
on serverless. The per-request check is correct everywhere. If measurements later justify it,
long-lived servers can add `LISTEN` as an optimization on top.

### 4.9 Export and import

- `GET /collections/export` returns all non-system collections as JSON.
- `PUT /collections/import` applies such a document through the sync engine: matching by
  collection id, creating, updating and optionally deleting collections. It runs as one transaction
  with a dry-run mode that returns the planned changes.

This is the v1 path from a dev schema to production. Generated migration files are a later
addition.

### 4.10 View collections

A view collection's records are the rows of a SQL query over other collections, such as posts
with their comment counts. It is listed, viewed and filtered like any collection, under its list
and view rules, and is read-only: its create, update and delete rules must be `null`, and writes
are refused even for superusers.

```json
{ "name": "post_stats", "type": "view", "listRule": "",
  "viewQuery": "SELECT p.id, p.title, count(c.id) AS comments FROM posts p LEFT JOIN comments c ON c.post = p.id GROUP BY p.id" }
```

- **Storage:** a Postgres view, `nextbase.<name>`. Unqualified names in the query resolve to
  collection tables. The query needs a text `id` column; its ids can be any text.
- **Fields:** derived from the query's columns: text, number, bool, date (`timestamp` and `date`
  are read as UTC) and json. Every column is wrapped in a cast to its field's storage type. Other
  types are refused with a hint to cast them. Field ids stay stable across query changes for
  columns with the same name. Columns can be NULL, so filters treat every view field as nullable.
  Views have no indexes, and relations cannot point at a view.
- **What a view may read:** Postgres decides, through privileges, rather than NextBase inspecting
  the query. View collections run as a dedicated role with least privilege, the approach
  [PostgREST](https://docs.postgrest.org/en/v14/explanations/db_authz.html) documents for exposing
  views:
  - The role, `nextbase_views_<random>` (roles belong to the whole cluster), is created with the
    first view and stored in `_meta.view_role`. It is `NOLOGIN NOINHERIT`, granted to NextBase's
    user so NextBase can `SET ROLE` to it.
  - It holds `USAGE` on the schema and `SELECT` on base collection tables and on auth collection
    tables minus `password` and `tokenKey` (column privileges). Grants are refreshed after every
    schema change, so new fields are granted and secrets never are. It has nothing on system
    tables, other schemas, or privileged functions, which Postgres reserves for superusers and
    roles such as `pg_read_server_files`.
  - It owns the views, so Postgres checks their tables against its privileges, and creating,
    renaming and dropping them runs as it (holding `CREATE` on the schema only meanwhile).
  - Every read of a view runs as it too (`SET LOCAL ROLE` in a transaction, which is safe behind
    transaction poolers), because [functions in a view run with the privileges of whoever queries
    it](https://www.postgresql.org/docs/current/sql-createview.html). For the same reason rules
    cannot read views through `@collection`.
  - Saving a view reads it once (`LIMIT 0`) as the role, so most privilege problems are a 400 at
    save time; a function that fails only when evaluated (such as `query_to_xml` over `_meta`) fails
    the read with a 500 that leaks nothing and is logged.
  - Creating the role needs the `CREATEROLE` attribute, which Neon's owner role and the RDS/Aurora
    `postgres` user have. Without it, creating a view is a 400 explaining how an administrator can
    create the role; everything else works.

  A view sees what the role can: emails of auth collections are readable, and a view does not
  apply `emailVisibility`. Catalogs readable by everyone, such as `pg_class`, are readable too.
- **Schema changes:** a new query is checked under a scratch name, then applied with
  `CREATE OR REPLACE VIEW`, so views reading this one survive when its columns stay compatible.
  Renaming a collection or field a view reads keeps the view working; dropping or retyping it, or
  deleting a view other views read, is refused with a 400 naming the dependency.

## 5. HTTP API

All paths are relative to `basePath`. Requests and responses are JSON unless noted.

### 5.1 Endpoints

| Method | Path                                          | Who                                  |
| ------ | --------------------------------------------- | ------------------------------------ |
| GET    | `/health`                                     | anyone                               |
| GET    | `/_`, `/_/`                                   | anyone (admin UI shell)              |
| GET    | `/setup`                                      | anyone (reports whether setup is needed) |
| POST   | `/batch`                                      | each write's own rule                |
| POST   | `/setup`                                      | holder of the setup token            |
| GET/POST | `/collections`                              | superuser                            |
| GET/PATCH/DELETE | `/collections/{nameOrId}`           | superuser                            |
| GET    | `/collections/export`                         | superuser                            |
| PUT    | `/collections/import`                         | superuser                            |
| GET    | `/collections/{c}/records`                    | list rule                            |
| GET    | `/collections/{c}/records/{id}`               | view rule                            |
| POST   | `/collections/{c}/records`                    | create rule                          |
| PATCH  | `/collections/{c}/records/{id}`               | update rule                          |
| DELETE | `/collections/{c}/records/{id}`               | delete rule                          |
| GET    | `/collections/{c}/auth-methods`               | anyone                               |
| POST   | `/collections/{c}/auth-with-password`         | anyone                               |
| POST   | `/collections/{c}/sign-up`                    | create rule                          |
| POST   | `/collections/{c}/auth-refresh`               | the authenticated record             |
| GET    | `/session`                                    | anyone (the caller's session, or null) |
| DELETE | `/session`                                    | anyone (logs out, removes the cookie) |
| GET    | `/sessions`                                   | any signed-in record (its sessions)  |
| DELETE | `/sessions/{id}`                              | any signed-in record (its own sessions) |
| POST   | `/collections/{c}/request-verification`       | anyone                               |
| POST   | `/collections/{c}/confirm-verification`       | token holder                         |
| POST   | `/collections/{c}/request-password-reset`     | anyone                               |
| POST   | `/collections/{c}/confirm-password-reset`     | token holder                         |
| POST   | `/collections/{c}/request-email-change`       | the authenticated record             |
| POST   | `/collections/{c}/confirm-email-change`       | token holder                         |
| POST   | `/files/token`                                | any authenticated record             |
| GET    | `/files/{collectionId}/{recordId}/{filename}` | public, or file token plus view rule |

### 5.2 Errors

Every error uses one shape:

```json
{ "status": 400, "message": "Failed to create record.",
  "data": { "title": { "code": "validation_required", "message": "Cannot be blank." } } }
```

- Field error codes are stable strings (`validation_required`, `validation_not_unique`, ...)
  listed in `shared/`.
- Postgres errors are mapped and never leaked:
  - `23505` (unique violation) → 400 `validation_not_unique` on the fields of the violated index,
    looked up by index name.
  - `23503` (foreign key violation) → 400 on the relation field.
  - Anything else → 500 with a generic message. The detail is logged server-side.
- Malformed JSON → 400, an unsupported content type → 415, a body over the size limit → 413.
- Serialization failures and deadlocks (`40001`, `40P01`) → 409, which the Postgres docs say a
  retry of the whole transaction fixes. A missing table or column (`42P01`, `42703`) → 409 only
  when a concurrent schema change happened since the request read the schema; otherwise it is a
  bug, logged as a 500.
- A path that exists answers other methods with 405 and an `Allow` header (RFC 9110). A 401
  carries `WWW-Authenticate: Bearer`.
- Every API response carries `Cache-Control: no-store`, since responses depend on the caller,
  including through the session cookie that shared caches do not account for, and
  `X-Content-Type-Options: nosniff` (OWASP REST Security Cheat Sheet).

### 5.3 Request pipeline

1. Match the route. Unknown routes return 404.
2. Enforce the body size limit while streaming (section 5.5).
3. Resolve the principal from the token (section 7.3): anonymous, auth record or superuser. A
   token that is present but invalid or expired returns 401. Silently downgrading to anonymous
   hides client bugs behind confusingly empty results.
4. Check the schema version (section 4.8).
5. Run the handler, inside a transaction for writes.
6. Serialize records (section 6.6) and map errors.

**Statement timeout.** A records API request (list, view, create, update, delete, batch) runs in
one transaction that starts with `set_config('statement_timeout', <ms>, true)`, which is
`SET LOCAL`: Postgres stops any of its statements that run past `statementTimeout` (default 8
seconds, the default [Supabase documents](https://supabase.com/docs/guides/database/postgres/timeouts)
for signed-in API requests), so an expensive client filter cannot hold the database. A
transaction-scoped setting works through transaction poolers, which reject session settings and
the startup parameter node-postgres would send for its own `statement_timeout`
([PgBouncer](https://www.pgbouncer.org/config.html) accepts only parameters it tracks). Writes run
as savepoints inside it. A stopped statement (`57014`) is a 500, as
[PostgREST](https://docs.postgrest.org/en/v14/references/errors.html) answers it, and is logged.
Schema changes and migrations are not limited: DDL on large tables can take long.


## 6. Records

### 6.1 List

`GET /collections/{c}/records?page=1&perPage=30&sort=-created,title&filter=...&expand=author&fields=id,title&skipTotal=1`

```json
{ "page": 1, "perPage": 30, "totalItems": 125, "totalPages": 5, "items": [ ... ] }
```

- `perPage` defaults to 30, maximum 1000.
- `skipTotal=1` skips the `COUNT(*)` query and returns `-1` for both totals.
- `sort` accepts visible, non-multiple fields with an optional `-` prefix. `id` is always appended
  as a final tiebreaker so pagination is stable. With no `sort`, the default is `-created` if that
  field exists, otherwise `id`.
- Pagination is offset-based. Cursor pagination can be added later without breaking the
  response shape.

### 6.2 Writes

- **Body formats:** JSON or `multipart/form-data`. In multipart, an optional `@jsonPayload` part
  carries a JSON object that is merged with the regular parts. Non-file values go there, and file
  parts are sent alongside it.
- **Update modifiers:**
  - multiple fields: `tags+` appends, `+tags` prepends, `tags-` removes
  - numbers: `count+` increments, `count-` decrements
  - file fields: `files-` removes named files
- **Order of operations for a write:**
  1. Normalize the input to typed values.
  2. Apply modifiers against the current row.
  3. Validate every field and collect all field errors before failing.
  4. Check relation targets (section 4.5).
  5. Upload new files (section 8).
  6. Execute the SQL.
- **Write protection for auth fields:**
  - `tokenKey` is never writable.
  - `password` is required on create. On update, it requires `oldPassword` unless the caller is a
    superuser or passes the manage rule.
  - `email` and `verified` can only be changed directly by a superuser or the manage rule; users
    change their own email through the email-change flow.
  - A password or email change regenerates `tokenKey`, which revokes all of that record's
    existing tokens.
- **Write responses:** a create or update returns the record if the caller passes the view rule,
  otherwise `204 No Content`.
- **Batch:** `POST /batch` with `{ "requests": [{ "method": "POST", "url": "/collections/orders/records", "body": {...} }, ...] }`
  runs up to 50 creates (POST), updates (PATCH) and deletes (DELETE) in one transaction, each with
  its own rules, in order, so later writes see earlier ones (an order created first passes its
  items' create rule). Urls are records paths below the base path and may carry `expand` and
  `fields`. It returns one `{ status, body }` per write, or a 400 naming the first failed write,
  with its field errors at `data.requests.<index>`; then nothing was saved. Each write runs in a
  savepoint of the batch's transaction, so the same code serves single and batched writes. The SDK
  queues writes with `nb.createBatch().collection("orders").create({...}).send()`.

### 6.3 Filter language

The same language serves client `filter` parameters and admin-written rules.

```
expr       := or
or         := and ( "||" and )*
and        := primary ( "&&" primary )*
primary    := "(" expr ")" | comparison
comparison := operand op operand
op         := "=" | "!=" | ">" | ">=" | "<" | "<=" | "~" | "!~"      (and each prefixed with "?")
operand    := string | number | "true" | "false" | "null"
            | path | macro
path       := segment ( "." segment )* modifier?
segment    := field | collection "_via_" field                 (a back-relation)
            | key                                              (inside a JSON field)
            | "@request.auth." path
            | "@request.body." field modifier?
            | "@request.query." name | "@request.headers." name | "@request.method"
            | "@collection." name ( ":" alias )? "." path
modifier   := ":isset" | ":length" | ":lower"
macro      := "@now" | "@todayStart" | "@todayEnd" | "@monthStart" | "@monthEnd" | "@yearStart" | "@yearEnd"
```

Compilation has three stages:

1. **Parse:** a hand-written tokenizer and recursive-descent parser produce an AST.
2. **Resolve:** every path segment is resolved against the schema to a field and type. Relation
   segments switch the current collection. Unknown fields are errors. In client filters, `@request`
   and `@collection` are rejected.
3. **Compile:** the resolved AST becomes a SQL fragment plus parameters. Every literal,
   `@request.*` value and date macro becomes a bound parameter with an explicit cast taken from the
   other operand's type, for example `$3::timestamptz`. An uncastable literal is a 400 filter error,
   never a SQL error.

Semantics:

- `=`, `!=`: plain `=` and `<>`, which btree indexes can serve. Only where NULL is possible (a
  blank date, single relation or missing JSON value) does `!=` use `IS DISTINCT FROM`, so NULL
  counts as different. Comparing with `""` or `null` compiles to that type's blank: `= ''`, `= 0`,
  `= false`, `IS NULL` or `cardinality(...) = 0`.
- `~`, `!~`: case-insensitive "contains" via `ILIKE ... ESCAPE '\'`. The value's `%`, `_` and `\`
  are escaped and it is wrapped in `%...%`, unless the user wrote a `%` explicitly.
- **Relation paths** compile to correlated `EXISTS` subqueries, never joins. The main query never
  multiplies rows, so it needs no `DISTINCT`, and single and multiple relations compile the same
  way.
- **Multi-valued operands** (multiple relations, select or file fields, back through relations):
  - `?op` means at least one element matches: `EXISTS (... WHERE cond)`.
  - A plain `op` means the set is non-empty and every element matches:
    `EXISTS (...) AND NOT EXISTS (... WHERE NOT cond)`.

  This deliberately differs from vacuous truth. Under vacuous truth, a rule like
  `allowed.id = @request.auth.id` would grant access to everyone when `allowed` is empty.
- **Both sides multi-valued** (`tags ?= wanted`, `reviewers ?= team.members`): one subquery walks
  both sides and compares every pair of values. `?op` holds when some pair matches; a plain `op`
  when both sides are non-empty and every pair matches. Relation paths on both sides work the same
  way, each with its own view rule in client filters.
- **Back-relations:** `comments_via_post` walks from a post to the comments whose `post` field
  points at it, and is always multi-valued. `comments_via_post:length` counts them.
- **`@collection`:** each `@collection.<name>` (or `@collection.<name>:<alias>`) is one row variable
  joined to the whole expression, which holds when some combination of rows satisfies it, so
  `@collection.members.user = @request.auth.id && @collection.members.team = team` means one
  membership row matches both. An empty collection contributes a row of NULLs. Rules only.
- **JSON:** `meta.address.city` reads a value by key (keys are bound parameters). It is compared
  as the type of the other side; a value of another JSON type, or a missing key, reads as NULL.
  Compared with a date (a date field or a macro such as `@now`), a JSON string is parsed by
  `nextbase.parse_timestamptz`, which accepts ISO 8601 only (no zone means UTC) and returns NULL
  for anything else, including impossible dates, instead of failing the query. A string literal is
  text, so `meta.due < "2026-01-01"` compares text.
- **Unauthenticated callers:** `@request.auth.*` resolves to blank values, so `@request.auth.id != ""`
  is the idiomatic "signed in" check.
- **Limits:** 3500 characters, 200 comparisons, nesting depth 6, relation path depth 6.

Extra safety for client filters (rules are written by superusers and trusted):

- Hidden fields cannot be used in client filters or sorts.
- A relation path in a client filter ANDs the target collection's view rule into its subquery, and a
  `null` view rule makes that path superuser-only. Otherwise a filter like `author.salary > 100000`
  would be an oracle on records the caller cannot view.
- An `email` field of an auth collection compiles to
  `CASE WHEN "emailVisibility" OR id = $auth THEN email ELSE '' END` for non-superusers, matching
  output visibility.

Client SDK users build filters with `nb.filter("title ~ {:q} && created > {:d}", { q, d })`, which
quotes values safely.

### 6.4 Rule enforcement

Each collection has five rules: list, view, create, update and delete.

- `null`: superusers only. Anyone else gets 403.
- `""`: anyone, including anonymous callers.
- An expression: compiled as in section 6.3.

Superusers bypass all rules.

| Action | How the rule is applied | On failure |
| ------ | ----------------------- | ---------- |
| list   | ANDed with the client filter in the `WHERE` clause | rows are filtered out |
| view   | `WHERE id = $1 AND (rule)` | 404 |
| update | `SELECT ... WHERE id = $1 AND (rule) FOR UPDATE`. Bare fields refer to the stored row, `@request.body.*` to the submitted values. | 404 |
| delete | `WHERE id = $1 AND (rule)`, then the delete runs on the locked row | 404 |
| create | `WITH __new AS (SELECT $1::text AS id, $2::text AS title, ...) SELECT 1 FROM __new WHERE (rule)`, evaluated before the insert | 400 |

The create check runs against a synthetic row, before the insert, so a caller without permission
never learns from a unique-constraint error that a value exists. The compiler takes the row source
(table alias or `__new`) as a parameter, so one compiler serves all five actions.

For auth collections, two more rules live in `options`:

- **authRule:** checked on login and refresh. A typical value is `verified = true`.
- **manageRule:** grants changing another record's password, email or verified flag without the
  old password.

### 6.5 Expand

`expand=author,comments.author` loads related records recursively, up to depth 6, batched per level
with `id = ANY($1)`. Each expanded record must pass its own collection's view rule for the caller;
records that fail are omitted. Back-relations expand too: `expand=comments_via_post` lists up to 1000
related records per record, always as an array.

### 6.6 Serialization

```json
{ "collectionId": "c1a2...", "collectionName": "posts", "id": "abc...", "title": "Hi",
  "created": "2026-10-18T09:30:00.000Z", "expand": { "author": { ... } } }
```

- Hidden fields, `password` and `tokenKey` are never output.
- `email` is output only when `emailVisibility` is true, or to the record itself, or to a
  superuser.
- `fields=id,title,expand.author.name` selects the output fields, including inside `expand`, and is
  applied after visibility rules.

## 7. Authentication

### 7.1 Passwords

- Hashing uses scrypt from `node:crypto`, so there are no native dependencies. Parameters
  N=2^14, r=8, p=5 (16 MiB) are in OWASP's recommended set and modest enough for small serverless
  instances.
- Hashes are stored in PHC format (`$scrypt$ln=14,r=8,p=5$<salt>$<hash>`), so parameters can be
  raised later: hashes with old parameters are rehashed on successful login.
- Comparison is constant-time.
- Following [NIST SP 800-63B rev 4](https://pages.nist.gov/800-63-4/sp800-63b.html): passwords
  are normalized with NFC before hashing, lengths count Unicode code points, and the default
  minimum is 15 characters, since NextBase has no second factor.
- When the identity is unknown, a dummy hash is still verified, so response timing does not reveal
  which accounts exist.

### 7.2 Sessions and tokens

Signing in creates a **session**: a row in `_sessions`, like a server-side session store, rather
than a self-contained JWT. A JWT cannot be revoked before it expires, so logging out would only
forget it on the client.

- **Token:** 32 random bytes, base64url. Only its SHA-256 hash is stored, so a database leak hands
  out no live sessions. The token is shown once, at sign-in.
- **Lookup:** every authenticated request finds the session by token hash (unique index), then
  loads the record.
- **Lifetime:** `options.tokens.auth.duration`, by default 7 days (superusers: 1 day). A session in
  use is extended to the full duration once it is a day old (or half its duration, if shorter), so
  active users stay signed in at the cost of at most one write per session per day. However active,
  a session ends 30 days after sign-in: OWASP requires "an absolute timeout, regardless of session
  activity", and NIST SP 800-63B rev 4 sets 30 days as the longest reauthentication interval at
  AAL1. Only HTTP requests extend sessions, since only their responses can renew the cookie too
  (section 7.6).
- **Revocation:**
  - Logging out deletes the session. `GET /sessions` lists a record's sessions, and
    `DELETE /sessions/{id}` ends one, such as a lost device.
  - Each session stores `key_hash = sha256(record.tokenKey + ":" + tokens.auth.secret)`, checked on
    every lookup. Regenerating the record's `tokenKey` (password or email change) or rotating the
    collection's auth secret therefore ends sessions without any bookkeeping, and so does a deleted
    record whose id is reused.
  - On a password or email change, the record's other sessions are deleted, and the caller's own
    session, if it is that record's, is re-keyed so it stays signed in.
  - A cookie sign-in ends the session in the cookie it replaces.
  - Expired sessions are deleted when new ones are created.

Other token types stay HS256 JWTs, created and verified with `jose`, because they travel in links
and need no lookup:

| Type                | Claims                                   | Default lifetime |
| ------------------- | ---------------------------------------- | ---------------- |
| `verification`      | `id`, `collectionId`, `email`            | 3 days |
| `passwordReset`     | `id`, `collectionId`, `email`            | 30 minutes |
| `emailChange`       | `id`, `collectionId`, `email`, `newEmail`| 30 minutes |
| `file`              | `id`, `collectionId`                     | 2 minutes |

- **Signing key:** `record.tokenKey + collection.options.tokens[type].secret`. Secrets are 50
  random characters generated when the collection is created, and the admin UI can rotate them.
- **Revocation:** rotating a collection secret revokes all tokens of that type. Regenerating a
  record's `tokenKey` revokes all of that record's tokens, which also makes reset and email-change
  tokens single-use.
- **Verification:** `algorithms: ["HS256"]` pinned, and the `type` claim and `exp` checked.

### 7.3 Transport

- Clients send `Authorization: Bearer <token>`, or the HttpOnly session cookie (section 7.6).
- If both are present, the header wins.
- An invalid Bearer token is a 401, so API clients notice. An invalid cookie is removed and the
  request continues anonymously, so a revoked session never breaks public pages.

### 7.4 Flows

- **auth-with-password**
  - Input: `{ identity, password }`.
  - `identity` is matched against `options.identityFields`, which defaults to `["email"]`. Other
    identity fields must be text fields with a unique index.
  - Checks the authRule.
  - Creates a session and returns `{ token, record }`, or with `{ cookie: true }` sets the session
    cookie and returns `{ record }`.
- **sign-up:** creates the record under the create rule, then signs it in, in one request: the
  same `{ token, record }` (or cookie) as auth-with-password. The id is chosen before the insert,
  so the record can be signed in even when the caller may not view it. When the authRule does not
  let it sign in yet, such as before verifying its email, the account stays created and the answer
  is 202 Accepted with no session.
- **auth-refresh:** re-checks the authRule, extends the session to its full lifetime, and returns
  the fresh record. A Bearer caller also gets its token back; a cookie caller gets a renewed cookie
  and never the token.
- **session:** `GET /session` returns the caller's session and record, or `null`. `DELETE /session`
  logs out: it deletes the session and removes the cookie.
- **auth-methods:** `GET` answers `{ password: { enabled, identityFields } }`, for a login page.

The email flows follow the
[OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html):

- **request-verification, request-password-reset, request-email-change** answer 204 whether or not
  the account exists. Mail is sent in the background after the response is decided, kept alive
  past it by `waitUntil` (Vercel's by default, a no-op elsewhere; `after` from `next/server` works
  too), so timing does not reveal accounts. Each address gets at most 10 emails per 15 minutes,
  counted like login attempts, so no one can flood an inbox. request-email-change needs the
  signed-in record; whether another record has the new address is checked on confirming, so the
  request reveals nothing.
- **Tokens** are the JWTs of section 7.2, of type `verification`, `passwordReset` or
  `emailChange`, signed with the record's `tokenKey` and the collection's secret for that type,
  and carrying the email they were issued for: a token for an address the record no longer has is
  rejected. A reset or email change rotates `tokenKey`, which makes its token single-use and ends
  every session.
- **confirm-verification** marks the record verified; confirming again is harmless.
- **confirm-password-reset** sets the password under the field's usual rules, marks the record
  verified (the user proved control of the address), ends every session, clears its login
  lockout, both the per-account and per-identity counts (OWASP: no lockout changes before a valid
  token, and recovery should end a lockout), and emails a "password changed" notice. It does not
  sign the user in.
- **confirm-email-change** needs the current password, counted against the account's login limit,
  then moves the record to the new address (a unique violation is a 400), marks it verified, ends
  every session and tells the old address.
- **Links** come from `mail.appUrl` (`/verify-email`, `/reset-password`, `/confirm-email-change`,
  each with `?token=`), never from the Host header, which an attacker can set to steal reset
  tokens. `appUrl` must be HTTPS, except on localhost.
- **Messages** have default subjects and texts; `mail.templates` replaces any of them, getting the
  collection, recipient, link and token. Templates are code, in the `mail` option, rather than
  per-collection settings: there is no admin UI to edit them yet.
- **Without `mail`**, these endpoints answer 400 `mail_not_configured` in production; in
  development the messages, tokens included, are logged instead.

### 7.5 Brute-force protection

Password attempts are counted in `_auth_attempts`, in a fixed 15-minute window, both per typed
identity (which may match no account) and per account, so several identity fields do not multiply
the limit. Each attempt is counted before the password is checked, in one atomic
`INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, so parallel guesses cannot all pass a check made
before any is counted; a correct password clears the counts. Over 10 attempts, requests get 429
with `Retry-After` set to the seconds left in the window.

The `oldPassword` of a password change goes through the same per-account count. It is checked
after the update rule passed, so a caller the rule rejects can neither guess it nor lock the
account, and counted outside the update's transaction, so a rejected change still counts.

This works across serverless instances without trusting client-IP headers. The cost is that an
attacker can temporarily lock out one known account. IP-level limits belong at the edge (platform
firewall or proxy), and the docs will say so. This trade-off is listed as an open question.

### 7.6 Session cookies (Next.js integration)

The browser sends cookies with every request, including page loads; it never sends a token kept in
`localStorage`. A cookie is what lets server components, server actions and `proxy.ts` know the
user, and an HttpOnly cookie is also out of reach of injected scripts. Signing in with
`{ cookie: true }` sets:

```
__Host-nextbase_session=<token>; Path=/; Max-Age=<seconds left>; HttpOnly; SameSite=Lax; Secure
```

- `Secure` is set when the request is HTTPS or `NODE_ENV` is `production`, so `next dev` on plain
  HTTP works. With it comes the `__Host-` prefix, which browsers accept only on a Secure,
  host-only cookie on `Path=/`, so a sibling subdomain cannot set or shadow it (OWASP Session
  Management Cheat Sheet). Plain HTTP uses `nextbase_session`.
- A request that extends a cookie session renews the cookie's `Max-Age`. Logging out, revoking the
  current session, or presenting an invalid cookie removes it.

Cookie authentication opens a CSRF surface, which is closed as follows:

- `SameSite=Lax` keeps the cookie off cross-site sub-requests.
- Any write (non-GET) that authenticates through the cookie is checked as the
  [OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
  describes: by `Sec-Fetch-Site` where the browser sends it (`same-origin` and `none` pass;
  `same-site` and `cross-site` get 403), and otherwise by an `Origin` header that must name the
  request's host or one in `trustedOrigins`, or it gets 403. Hosts are compared rather than
  full origins, as Next.js does for server actions, because proxies often change the scheme the
  app sees.
- The request's host is `Host`, which platforms such as Vercel
  [set to the domain the client used](https://vercel.com/docs/headers/request-headers).
  `X-Forwarded-Host` is read only with `trustProxy`, since OWASP says to use it "only from trusted
  proxies".
- A cookie sign-in is checked the same way, so another site cannot sign the browser in to an
  account of its choosing.
- GET handlers have no side effects. In-process requests from `client()` are server code and are
  not checked.

[Next.js does not support setting cookies while rendering server components](https://nextjs.org/docs/app/api-reference/functions/cookies).
So in-process requests from `client()` neither extend sessions nor remove a stale cookie; only HTTP
requests do, where the response renews the cookie in step with the database. Signing in and out
in server actions and route handlers writes the cookie through the store's `set`.

A GET request may renew the cookie and the session's expiry. Next.js calls setting cookies on GET
an escape hatch that needs auditing; here the renewal is idempotent and only extends the caller's
own session, and responses carry no CORS headers, so other origins cannot read them.

### 7.7 First superuser

When `_superusers` is empty:

1. The admin UI shows a setup screen.
2. `POST /setup` requires a setup token: a short-lived JWT signed with `_meta.setup_secret`.
3. NextBase logs a setup URL containing that token on every request handled while no superuser
   exists, rate-limited to once per minute per instance.
4. Once a superuser exists, `/setup` returns 404 permanently.

This prevents a stranger from claiming a freshly deployed instance by visiting `/api/nextbase/_`
before the owner does.

Scripts can call `nextbase.createSuperuser(email, password)` instead.

## 8. Files

### 8.1 Storage drivers

```ts
interface Storage {
  put(key: string, body: ReadableStream | Uint8Array, contentType: string): Promise<void>;
  get(key: string, range?: { start: number; end?: number }): Promise<StoredFile | null>;
  deletePrefix(prefix: string): Promise<void>;
  delete(keys: string[]): Promise<void>;
}
```

Two drivers ship:

- `localStorage({ dir })`: writes to a temporary file and renames it into place, so readers never
  see partial files.
- `s3Storage({...})`: any S3-compatible service (AWS, R2, MinIO, Backblaze). It uses `aws4fetch`
  for SigV4 signing over `fetch` instead of the multi-megabyte AWS SDK.

The interface is public so users can write other drivers, but v1 adds no more.

### 8.2 Upload pipeline

- **Input:** files arrive as multipart parts on record create and update.
- **Validation:**
  - count against `maxSelect` and size against `maxSize`, while streaming
  - type from sniffing the content with `file-type`, never from the client's `Content-Type`
  - the sniffed type is checked against `mimeTypes`
- **Stored name:**
  - The original name is sanitized to `[a-z0-9_]` and truncated to 100 characters.
  - `_` plus 10 random `[a-z0-9]` characters is appended.
  - The extension is lowercased and comes from the sniffed type when one is known.
  - Example: `My Photo.JPG` → `my_photo_x8k2m1q9za.jpg`.
- **Storage key:** `<collectionId>/<recordId>/<filename>`.

### 8.3 Body limits

`request.formData()` buffers the whole body in memory, so the body is read through a counting
stream first. The limit is computed from the collection: the sum of each file field's
`maxSize × maxSelect`, plus a 1 MB allowance for other values. A request exceeding it is aborted
with 413 before it is fully read. No global setting is needed.

Serverless platforms cap request bodies (Vercel: 4.5 MB), and NextBase cannot lift that cap. Direct
browser-to-S3 uploads with presigned URLs are the planned answer for large files, after v1. The
docs will state the limit prominently.

### 8.4 Consistency between the database and storage

The invariant: every filename stored in the database exists in storage.

- New files are uploaded before the transaction commits.
- If the transaction fails, the uploaded files are deleted, best effort.
- Replaced or removed files, deleted records (`deletePrefix(<collectionId>/<recordId>/)`), and
  dropped fields or collections are deleted only after commit, best effort.
- A failed deletion leaves an orphan, which costs storage but is never a broken reference.
- An orphan sweep can be added later.

### 8.5 Serving

`GET /files/{collectionId}/{recordId}/{filename}`

- **Lookup:** the record must exist and currently reference `filename` in a file field. Replaced
  files are never served, even before cleanup.
- **Access:**
  - Non-protected fields: anyone with the URL. Filenames are unguessable.
  - `protected` fields: require `?token=<file token>`, and the token's record must pass the view
    rule. Superusers always pass.
- **Response headers:**
  - `Content-Type` is derived from the stored extension.
  - `Content-Disposition: inline` only for an allow-list: raster images, PDF, audio, video and
    plain text. Everything else, including SVG and HTML, is sent as `attachment`. `?download=1`
    forces `attachment`.
  - `Content-Security-Policy: default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox`
  - `X-Content-Type-Options: nosniff`
  - `Cache-Control: public, max-age=2592000` for public files; `private, no-store` for protected
    ones.
- **Range requests** are supported, for video.

## 9. Admin UI

- **Framework:** Preact with JSX, built by Vite into the single HTML file the scaffold already
  embeds.
  - Preact keeps the embedded bundle small. Its React-compatible API is familiar to the Next.js
    developers who are the likely contributors.
  - Routing uses the URL hash, so the server only ever serves `/_`.
- **Data access:** the UI uses the public HTTP API through the NextBase client SDK, with a
  superuser token kept in `localStorage`. It has no private endpoints, so the API and SDK are
  exercised by the UI on every change.
- **Content Security Policy:**
  - At module initialization, the server hashes the inline script and style of the embedded HTML
    once.
  - It serves `default-src 'none'; script-src 'sha256-…'; style-src 'sha256-…'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`.
  - A strict CSP is what makes `localStorage` token storage acceptable.
- **v1 screens:**
  - setup and login
  - collections list
  - collection editor: fields, rules with live validation, indexes, auth options
  - records browser: filter, sort, paginate, create, edit, delete, upload files
  - superusers
  - export and import

## 10. Client SDK

```ts
import { NextBaseClient } from "@nextbase/client";

const nb = new NextBaseClient(); // baseUrl defaults to "/api/nextbase"

await nb.collection("users").signInWithPassword("a@b.co", "secret");
const page = await nb.collection<Post>("posts").getList(1, 20, {
  filter: nb.filter("published = true && title ~ {:q}", { q }),
  sort: "-created",
  expand: "author",
});
await nb.collection("posts").create({ title: "Hi" });
nb.authStore.onChange((token, record) => {});
```

- **Records:** `getList`, `getFullList` (batches of up to 1000), `getFirstListItem` (a 404 when
  nothing matches), `getOne`, `create`, `update` and `delete`. `create` and `update` return `null`
  when the write succeeded but the caller may not view the result (the server's 204).
- **Auth:** `signUp` creates an account and signs it in, in one request (null when the authRule does not let it sign in yet). `signInWithPassword` and `refreshSession` save the token and record in the auth store; with
  `{ cookie: true }` the session lives in the HttpOnly cookie and the store keeps only the record.
  `getSession()` returns the current session (and updates the store), `signOut()` ends it, and
  `listSessions()` and `revokeSession(id)` manage the record's devices. The remaining flows of
  section 7.4 are added with them.
- **Collections:** `nb.collections` wraps the superuser-only collections API. `setupStatus()` and
  `setup()` drive first-run setup.
- **Options:** every method takes fetch's own options (`signal`, `cache`, and Next.js's `next`),
  plus `query` and `headers`. `send(path, options)` reaches any endpoint.
- **Errors:** every failure is a `ClientError` with `status`, `message` and `data`. Requests that
  get no response (network failures, aborts) have status 0, and aborts set `isAbort`.
- **`filter()`:** replaces each `{:name}` with a quoted literal: strings and dates as strings,
  numbers in plain decimal notation (the filter language has no exponents), nullish values as
  `null`, other objects as JSON strings. A missing parameter throws instead of being left in place.
- **Auth store:**
  - Kept in memory, and persisted to `localStorage` in the browser (detected by `document`, since
    Node.js has a `localStorage` of its own). Other tabs' sign-ins and sign-outs apply through the
    `storage` event.
  - A 401 to a request sent with the stored token clears it, since the server no longer accepts it.
  - Updating the signed-in record refreshes it in the store; deleting it signs out.
  - `isValid` means the client holds a token or a cookie session's record; the server decides, and
    a 401 clears the store.
- **Types:** collections are typed with generics in v1. The collection model's types are exported
  from `shared/`, where the server's own definitions live. Generating record types from the live
  schema is a later addition.

### 10.1 Server-side use

```ts
// Server component or server action: acts as the user of the session cookie.
// serverClient (from @nextbase/next) reads Next.js's cookies(); elsewhere, pass any
// cookie store: nextbase.client({ cookies }).
const nb = await serverClient(nextbase);
const session = await nb.getSession();

// Trusted server code: acts as a superuser. Never expose it to user input.
const admin = nextbase.client({ superuser: true });
```

`nextbase.client()` returns the same SDK, wired to an in-process `fetch` and a memory-only auth
store. Requests go through the full pipeline (routing, validation, rules, serialization) without a
network hop, so server-side access gets exactly the same authorization as HTTP access. Create one
per request: a signed-in client must never be shared between users. In server actions and route
handlers, `signInWithPassword(..., { cookie: true })` and `signOut()` write the cookie through the
store's `set`; in server components, where Next.js forbids it, renewals are skipped.

**Protecting pages.** `nextbase.getSession(request)` returns the session of a request's cookie
or Bearer token, checked against the database, or `null`, without extending it, for `proxy.ts` to
redirect signed-out visitors before a page renders (proxy runs on the Node.js runtime in Next.js
16, so a database check is possible). `hasSessionCookie(request)` is the cookie-only check the
[Next.js authentication guide](https://nextjs.org/docs/app/guides/authentication) recommends for
proxy, which runs on every matched request, prefetches included. Either way proxy is a redirect,
not the security boundary: the guide says proxy "should not be your only line of defense" and
that checks belong "as close as possible to your data source", and server actions are POSTs to
the page route, so a matcher change can skip them. NextBase's collection rules are that boundary
for every read and write through `client()` or the API, so pages need no auth checks of their own.

The superuser principal is passed through an internal `dispatch(request, principal)` that HTTP
cannot reach. `handle(request)` always derives the principal from the request's own credentials.
In-process requests never log the setup token, which names a URL to call.

## 10.2 CLI

`npx nextbase` (the package's `bin`) runs on Node's own `util.parseArgs` and `process.loadEnvFile`,
with no dependencies:

| Command | Does |
| --- | --- |
| `migrate` | Creates or upgrades NextBase's tables, for deploy scripts. |
| `superuser --email E` | Adds a superuser through `createSuperuser`. The password is read without echo (raw-mode stdin and keypress events, documented Node APIs), asked twice, or taken from `NEXTBASE_SUPERUSER_PASSWORD` in scripts. Replaces finding the setup token in the logs for operators with a shell. |
| `typegen [--out F]` | Writes a record type per collection and a `Collections` map. Hidden fields are left out; view columns are nullable. |

`DATABASE_URL` comes from the environment, then `.env.local`, then `.env` (`loadEnvFile` keeps
variables already set, so loading in that order gives that precedence, as in Next.js), or from
`--database`. The CLI uses a pool of its own and ends it, so the process exits promptly.

`NextBaseClient<Schema>` takes the generated `Collections`: `collection("posts")` is then typed
by name, and other names, or an explicit `collection<T>(name)`, fall back as before.

## 11. Security summary

| Threat                            | Defense |
| --------------------------------- | ------- |
| SQL injection via filters or names | Identifier regex plus quoting, schema-resolved paths, and bound parameters for every value (sections 2.4, 6.3) |
| Data oracle through filters       | Hidden fields rejected, related collections' view rules applied, email visibility enforced (section 6.3) |
| Existence leaks                   | 404 for view, update and delete rule failures; the create rule is checked before the insert; enumeration-safe auth flows (sections 6.4, 7.4) |
| Stale rules across instances      | Per-request schema version check (section 4.8) |
| Token forgery or confusion        | Pinned HS256, a `type` claim, per-record and per-collection keys (section 7.2) |
| Password brute force              | scrypt, per-identity throttling, edge limits recommended (sections 7.1, 7.5) |
| CSRF on cookie sessions           | SameSite=Lax plus an `Origin` check on writes (section 7.6) |
| Instance takeover on first deploy | Setup token printed in server logs (section 7.7) |
| Stored XSS via uploads            | Sniffed types, an inline allow-list, a sandbox CSP, nosniff (section 8.5) |
| XSS in the admin UI               | Hash-based strict CSP, `frame-ancestors 'none'` (section 9) |
| Resource exhaustion               | Streaming body limits, perPage and filter complexity limits, expand depth limit |
| Broken file references            | Upload before commit, delete after commit (section 8.4) |

## 12. Testing

- **Unit tests** for the tokenizer, parser and compiler: golden SQL-and-parameter snapshots, error
  cases, and every limit.
- **Property tests** (`fast-check`) for the filter compiler: random filter strings never produce a
  SQL error and never put a parameter value into the SQL text.
- **Integration tests** against real Postgres. Each test file gets a fresh database cloned from a
  migrated template (`CREATE DATABASE ... TEMPLATE`), so files run in parallel without
  interfering.
  - Location: `NEXTBASE_TEST_DATABASE_URL`, defaulting to the local `nextbase_test`.
  - Coverage: schema sync (renames, toggles, rejected changes, rollback on failure), CRUD,
    relations and cascades, auth flows, files with a temporary local storage directory.
- **A rule matrix suite:** for each action and rule shape, test anonymous, owner, other user and
  superuser access, asserting status codes and visible rows.
- **CI:** runs against Postgres 16, the oldest supported version, and 18, the newest.

## 13. Implementation plan

Each milestone ends with `pnpm check` passing and its tests in place.

1. **Database foundation:** pool, transactions, SQL helpers, system migrations, `_meta`, CI Postgres.
2. **Schema:** collection and field model, validation, sync engine, schema cache, the
   `_superusers` collection.
3. **Superuser auth:** password hashing, tokens, principal resolution, setup flow, collections API.
4. **Filter and rule compiler:** parser, resolver, SQL compiler, limits, property tests.
5. **Records API:** CRUD, modifiers, list, sort, pagination, expand, fields, serialization, rule
   enforcement, the rule matrix.
6. **Auth collections:** all flows, mail, throttling, session cookies, CSRF checks.
7. **Files:** storage drivers, upload pipeline, body limits, serving, cleanup.
8. **Client SDK:** full surface, `nextbase.client()`, auth store.
9. **Admin UI:** the screens in section 9.
10. **Export and import, docs, example app.**

## 14. Open questions

1. **Brute-force policy:** per-identity throttling with temporary lockout (as proposed), or IP-based
   limits with a configurable trusted-proxy header, or both?
2. **Admin UI framework:** Preact (proposed) or Svelte.
3. **Session cookies in v1:** proposed as v1 because server components are the main reason to embed
   a backend in Next.js. They could ship later, with Bearer-only auth at first.
4. **License:** MIT, held by "NextBase contributors", is a placeholder.
