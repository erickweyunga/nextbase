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

Realtime subscriptions, OAuth2, OTP and MFA, view collections, server-side hooks, a batch API, image
thumbnails, backups, a request-log UI, multi-tenancy, the Edge runtime, and databases other than
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

All runtime code lives in `@nextbase/nextbase`, split by entry point:

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
import { NextBase, s3Storage } from "@nextbase/nextbase/server";

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
| `mail`           | none                                     | Without it, endpoints that send mail return 400 `mail_not_configured`. In development, messages are logged instead. |
| `basePath`       | `/api/nextbase`                          | Already implemented.                                     |
| `trustedOrigins` | the request's own origin                 | Extra origins allowed to make cookie-authenticated writes (section 7.6). |

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
`@nextbase/nextbase`. Names are validated against the name regex before they reach it, and values
are never interpolated into SQL text.

## 3. Database layout

All NextBase objects live in a dedicated Postgres schema, `nextbase`, so they never collide with an
app's own tables in `public`. System tables start with `_`. Collection names cannot, so the two
never clash. Postgres 15 or newer is required, with `DateStyle` ISO and
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

## 5. HTTP API

All paths are relative to `basePath`. Requests and responses are JSON unless noted.

### 5.1 Endpoints

| Method | Path                                          | Who                                  |
| ------ | --------------------------------------------- | ------------------------------------ |
| GET    | `/health`                                     | anyone                               |
| GET    | `/_`, `/_/`                                   | anyone (admin UI shell)              |
| GET    | `/setup`                                      | anyone (reports whether setup is needed) |
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
| POST   | `/collections/{c}/auth-refresh`               | the authenticated record             |
| POST   | `/collections/{c}/auth-logout`                | anyone (clears the session cookie)   |
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
- Malformed JSON, an unsupported content type, or a body over the size limit → 400 or 413.

### 5.3 Request pipeline

1. Match the route. Unknown routes return 404.
2. Enforce the body size limit while streaming (section 5.5).
3. Resolve the principal from the token (section 7.3): anonymous, auth record or superuser. A
   token that is present but invalid or expired returns 401. Silently downgrading to anonymous
   hides client bugs behind confusingly empty results.
4. Check the schema version (section 4.8).
5. Run the handler, inside a transaction for writes.
6. Serialize records (section 6.6) and map errors.

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
- **Back-relations:** `comments_via_post` walks from a post to the comments whose `post` field
  points at it, and is always multi-valued. `comments_via_post:length` counts them.
- **`@collection`:** each `@collection.<name>` (or `@collection.<name>:<alias>`) is one row variable
  joined to the whole expression, which holds when some combination of rows satisfies it, so
  `@collection.members.user = @request.auth.id && @collection.members.team = team` means one
  membership row matches both. An empty collection contributes a row of NULLs. Rules only.
- **JSON:** `meta.address.city` reads a value by key (keys are bound parameters). It is compared
  as the type of the other side; a value of another JSON type, or a missing key, reads as NULL.
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
- When the identity is unknown, a dummy hash is still verified, so response timing does not reveal
  which accounts exist.

### 7.2 Tokens

Tokens are HS256 JWTs, created and verified with `jose`. JWT verification is security-critical and
`jose` is audited and dependency-free.

| Type                | Claims                                   | Default lifetime |
| ------------------- | ---------------------------------------- | ---------------- |
| `auth`              | `id`, `collectionId`, `refreshable`      | 7 days (superusers: 1 day) |
| `verification`      | `id`, `collectionId`, `email`            | 3 days |
| `passwordReset`     | `id`, `collectionId`, `email`            | 30 minutes |
| `emailChange`       | `id`, `collectionId`, `email`, `newEmail`| 30 minutes |
| `file`              | `id`, `collectionId`                     | 2 minutes |

- **Signing key:** `record.tokenKey + collection.options.tokens[type].secret`. Secrets are 50
  random characters generated when the collection is created, and the admin UI can rotate them.
- **Revocation:**
  - Rotating a collection secret revokes all tokens of that type for the collection.
  - Regenerating a record's `tokenKey` revokes all of that record's tokens. This happens on
    password change, email change and password reset, which also makes reset and email-change
    tokens single-use.
- **Verification steps:**
  1. Decode without trusting the token, to read `id` and `collectionId`.
  2. Load the record.
  3. Derive the key.
  4. Verify with `algorithms: ["HS256"]` pinned.
  5. Check the `type` claim, `exp`, and that `collectionId` is an auth collection.

### 7.3 Transport

- Clients send `Authorization: Bearer <token>`.
- Alternatively, the HttpOnly session cookie described in section 7.6.
- If both are present, the header wins.

### 7.4 Flows

- **auth-with-password**
  - Input: `{ identity, password }`.
  - `identity` is matched against `options.identityFields`, which defaults to `["email"]`. Other
    identity fields must be text fields with a unique index.
  - Checks the authRule.
  - Returns `{ token, record }`.
- **auth-refresh:** requires a refreshable auth token, re-checks the authRule, and returns a new
  token and the fresh record.
- **request-verification, request-password-reset**
  - Always return 204, whether or not the email exists.
  - Mail is sent after the response is decided, so timing does not depend on whether a record was
    found.
- **confirm-password-reset:** sets the password, regenerates `tokenKey`, and marks the record as
  verified, since the user proved control of the email address.
- **request-email-change, confirm-email-change**
  - The confirm step requires the current password.
  - It checks the new email is still free, then updates the email and regenerates `tokenKey`.
- **Email templates:** subject and body templates are per-collection options. Links point at a
  configurable app URL, with `{TOKEN}` substituted into it.

### 7.5 Brute-force protection

Failed password attempts are counted per collection and identity in `_auth_attempts`, using a fixed
15-minute window. After 10 failures, attempts return 429 until the window ends.

This works across serverless instances without trusting client-IP headers. The cost is that an
attacker can temporarily lock out one known account. IP-level limits belong at the edge (platform
firewall or proxy), and the docs will say so. This trade-off is listed as an open question.

### 7.6 Session cookies (Next.js integration)

Server components need the user's identity without client-side token plumbing. When a login call
asks for a session (`{ session: true }` in the body), the response also sets the session cookie:

```
nextbase_auth=<token>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=<token lifetime>
```

- `Secure` is omitted only for `http://localhost`.
- `auth-refresh` re-issues the cookie and `auth-logout` clears it.

Cookie authentication opens a CSRF surface, which is closed as follows:

- `SameSite=Lax` blocks the cookie on cross-site sub-requests.
- Any POST, PATCH or DELETE request that authenticates via the cookie (no `Authorization` header)
  must carry an `Origin` header equal to the request's origin or listed in `trustedOrigins`.
  Otherwise it gets 403.
- GET handlers have no side effects.

Server components cannot set cookies, so tokens are refreshed by the browser SDK or by the app's
own server actions. A 7-day lifetime makes this a non-issue in practice.

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
import { NextBaseClient } from "@nextbase/nextbase/client";

const nb = new NextBaseClient(); // baseUrl defaults to "/api/nextbase"

await nb.collection("users").authWithPassword("a@b.co", "secret");
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
- **Auth:** `authWithPassword` and `authRefresh` save the token and record in the auth store. The
  remaining flows of section 7.4 are added with them.
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
  - `isValid` checks the token's expiry claim, not its signature.
- **Types:** collections are typed with generics in v1. The collection model's types are exported
  from `shared/`, where the server's own definitions live. Generating record types from the live
  schema is a later addition.

### 10.1 Server-side use

```ts
// Server component or server action: anonymous, or a user once signed in or given a token.
const nb = nextbase.client();

// Trusted server code: acts as a superuser. Never expose it to user input.
const admin = nextbase.client({ superuser: true });
```

`nextbase.client()` returns the same SDK, wired to an in-process `fetch` and a memory-only auth
store. Requests go through the full pipeline (routing, validation, rules, serialization) without a
network hop, so server-side access gets exactly the same authorization as HTTP access. Create one
per request: a signed-in client must never be shared between users. With session cookies,
`nextbase.client({ cookies: await cookies() })` will act as the signed-in user.

The superuser principal is passed through an internal `dispatch(request, principal)` that HTTP
cannot reach. `handle(request)` always derives the principal from the request's own credentials.
In-process requests never log the setup token, which names a URL to call.

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
- **CI:** gets a Postgres 17 service container.

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
