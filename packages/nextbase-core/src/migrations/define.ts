import type {
  Collection,
  CollectionInput,
  Field,
  NextBaseClient,
  RecordModel,
} from '@nextbasejs/client';
import type { Tx } from '@nextbasejs/dbx';

/** A collection's fields, to change in place by id, as generated migrations do. */
export interface FieldList extends Array<Field> {
  getById(id: string): Field | undefined;
  /** Puts `field` at `index`, replacing a field with its id wherever it was. */
  addAt(index: number, field: Partial<Field>): void;
  removeById(id: string): void;
}

/** A collection as `change` hands it over, to edit in place. */
export type CollectionDraft<C extends Collection = Collection> =
  C extends Collection ? Omit<C, 'fields'> & { fields: FieldList } : never;

export interface MigrationCollections {
  get(idOrName: string): Promise<Collection>;
  create(input: CollectionInput): Promise<Collection>;
  /** Loads the collection, lets `edit` change it, and saves it; `T` names its type. */
  change<T extends Collection['type'] = Collection['type']>(
    idOrName: string,
    edit: (
      collection: CollectionDraft<Extract<Collection, { type: T }>>,
    ) => void | Promise<void>,
  ): Promise<Collection>;
  delete(idOrName: string): Promise<void>;
  /**
   * Lays `collections` over the existing ones, matched by id, then name. With
   * `deleteMissing`, drops fields and collections they leave out, system ones aside.
   */
  import(
    collections: readonly CollectionInput[],
    options?: { deleteMissing?: boolean },
  ): Promise<void>;
}

/** What a migration works with, all in its one transaction. */
export interface MigrationApp {
  collections: MigrationCollections;
  /** The transaction, for SQL of your own. */
  db: Tx;
  /** A superuser client in the transaction, for records; collections go through `collections`. */
  nextbase: NextBaseClient<Record<string, RecordModel>>;
}

export interface Migration {
  up(app: MigrationApp): void | Promise<void>;
  /** Undoes `up`, for `revertMigrations()`. */
  down?(app: MigrationApp): void | Promise<void>;
}

/** The app's migrations, as the generated `index.ts` of their folder lists them. */
export interface Migrations {
  /** Where they are, from the project root; automigrate writes there. */
  dir: string;
  /** By name, `<unix seconds>_<words>`; they run in name order. */
  files: Readonly<Record<string, Migration>>;
  /** Writes a migration for each collection change; on in `next dev`. */
  automigrate?: boolean;
  /**
   * Lets the API change collections where automigrate is off, such as in production,
   * though nothing records it in a migration. Off, so the migrations stay the truth.
   */
  schemaChanges?: boolean;
}

export const MIGRATION_NAME: RegExp = /^\d{10,}_[a-z0-9_]+$/;

/** One migration, the default export of its file. */
export function migration(definition: Migration): Migration {
  if (
    typeof definition?.up !== 'function' ||
    (definition.down !== undefined && typeof definition.down !== 'function')
  ) {
    throw new TypeError('A migration needs an up function, and maybe a down.');
  }
  return definition;
}

/** The app's migrations, the default export of the generated `index.ts`. */
export function migrations(list: Migrations): Migrations {
  checkMigrations(list);
  return list;
}

export function checkMigrations(list: Migrations): void {
  if (typeof list?.dir !== 'string' || list.dir === '') {
    throw new TypeError('migrations needs the dir they are in.');
  }
  if (list.files === null || typeof list.files !== 'object') {
    throw new TypeError('migrations needs its files, by name.');
  }
  for (const key of ['automigrate', 'schemaChanges'] as const) {
    if (list[key] !== undefined && typeof list[key] !== 'boolean') {
      throw new TypeError(`migrations.${key} must be a boolean.`);
    }
  }
  for (const [name, file] of Object.entries(list.files)) {
    if (!MIGRATION_NAME.test(name)) {
      throw new TypeError(
        `The migration ${JSON.stringify(name)} must be named <unix seconds>_<words>, in lowercase.`,
      );
    }
    migration(file);
  }
}
