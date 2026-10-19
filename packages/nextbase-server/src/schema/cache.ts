import type { Collection, Field } from "@nextbase/client";
import type { Builder, DB } from "@nextbase/dbx";
import { table } from "../db/system.ts";
import { ApiError } from "../errors.ts";
import { loadCollections } from "./store.ts";
import { readViewRole } from "./views.ts";

/** The collections as of one schema version. */
export class Schema {
  readonly version: number;
  readonly collections: readonly Collection[];
  /** The database role view collections are read as, once one exists. */
  readonly viewRole: string | null;

  constructor(
    version: number,
    collections: readonly Collection[],
    viewRole: string | null = null,
  ) {
    this.version = version;
    this.collections = collections;
    this.viewRole = viewRole;
  }

  /** The collection with this id or name, or undefined. */
  find(idOrName: string): Collection | undefined {
    return this.collections.find(
      (c) => c.id === idOrName || c.name === idOrName,
    );
  }

  /**
   * Resolves a back-relation name such as `comments_via_post`: the records of
   * `comments` whose relation field `post` points at `target`. Names may
   * contain underscores, so every `_via_` split is tried.
   */
  backRelation(
    target: Collection,
    name: string,
  ): { source: Collection; field: Field & { type: "relation" } } | undefined {
    for (
      let i = name.indexOf("_via_");
      i > 0;
      i = name.indexOf("_via_", i + 1)
    ) {
      const source = this.collections.find((c) => c.name === name.slice(0, i));
      const field = source?.fields.find((f) => f.name === name.slice(i + 5));
      if (
        source &&
        field?.type === "relation" &&
        field.collectionId === target.id
      ) {
        return { source, field };
      }
    }
    return undefined;
  }

  /** The collection with this id or name, or a 404. */
  get(idOrName: string): Collection {
    const collection = this.find(idOrName);
    if (!collection) throw new ApiError(404, "Collection not found.");
    return collection;
  }
}

/** The current schema version, bumped by every schema change. */
export async function readSchemaVersion(q: Builder): Promise<number> {
  const [version] = await q
    .newQuery(`SELECT schema_version FROM {{${table("_meta")}}}`)
    .column<string>();
  return Number(version);
}

/**
 * Caches the schema per instance. Every `get` reads the schema version, one
 * primary-key lookup, and reloads when another instance changed the schema: a
 * stale cache would enforce outdated access rules.
 */
export class SchemaCache {
  #schema: Schema | undefined;
  #loading: Promise<Schema> | undefined;

  async get(db: DB): Promise<Schema> {
    const version = await readSchemaVersion(db);
    for (;;) {
      if (this.#schema && this.#schema.version >= version) return this.#schema;
      // Concurrent requests share one reload.
      this.#loading ??= this.#load(db).finally(() => {
        this.#loading = undefined;
      });
      const loaded = await this.#loading;
      // A reload that started before this request saw `version` may predate
      // it, and would enforce outdated rules; then load again.
      if (loaded.version >= version) return loaded;
    }
  }

  async #load(db: DB): Promise<Schema> {
    // One snapshot, so the version matches the collections read with it.
    const schema = await db.transaction(
      async (tx) =>
        new Schema(
          await readSchemaVersion(tx),
          await loadCollections(tx),
          await readViewRole(tx),
        ),
      { isolation: "repeatable read", readOnly: true },
    );
    if (!this.#schema || schema.version > this.#schema.version)
      this.#schema = schema;
    return schema;
  }
}
