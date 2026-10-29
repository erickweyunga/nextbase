import type { Builder } from './builder.ts';
import { hash } from './expression.ts';
import type { Params } from './query.ts';
import { quoteIdentifier } from './sql.ts';

/** Thrown when a model has no primary key, or its key value is missing. */
export class MissingPKError extends Error {
  constructor(message = 'dbx: missing primary key.') {
    super(message);
    this.name = 'MissingPKError';
  }
}

/** Thrown by `SelectQuery.model()` for a composite primary key. */
export class CompositePKError extends Error {
  constructor() {
    super('dbx: composite primary key is not supported.');
    this.name = 'CompositePKError';
  }
}

export interface ModelOptions {
  /** Primary key column, or columns for a composite key. Defaults to `"id"`. */
  pk?: string | readonly string[];
}

/**
 * Writes one record by primary key. Record keys are column names; `undefined`
 * values are left out.
 */
export class ModelQuery<T extends object> {
  readonly #builder: Builder;
  readonly #table: string;
  readonly #record: T;
  readonly #pk: readonly string[];
  #exclude: readonly string[] = [];

  constructor(
    builder: Builder,
    table: string,
    record: T,
    options: ModelOptions = {},
  ) {
    this.#builder = builder;
    this.#table = table;
    this.#record = record;
    const pk = options.pk ?? 'id';
    this.#pk = typeof pk === 'string' ? [pk] : pk;
    if (this.#pk.length === 0) throw new MissingPKError();
  }

  /** Always left out of `insert()` and `update()`. Replaces earlier exclusions. */
  exclude(...cols: (keyof T & string)[]): this {
    this.#exclude = cols;
    return this;
  }

  /**
   * A single-column key that is null is left to the database default, and the
   * generated value is written back to the record.
   */
  async insert(...cols: (keyof T & string)[]): Promise<void> {
    const values = this.#columns(cols);
    const [pk] = this.#pk;
    // Decided by the record, not `cols`, so an existing key is never overwritten.
    if (
      this.#pk.length !== 1 ||
      pk === undefined ||
      (this.#record as Params)[pk] != null
    ) {
      await this.#builder.insert(this.#table, values).execute();
      return;
    }

    delete values[pk];
    const insert = this.#builder.insert(this.#table, values);
    const [id] = await this.#builder
      .newQuery(`${insert.sql} RETURNING ${quoteIdentifier(pk)}`)
      .bind(insert.params)
      .row();
    (this.#record as Params)[pk] = id;
  }

  /** Key columns are never set. Matching no row is not an error. */
  async update(...cols: (keyof T & string)[]): Promise<void> {
    const values = this.#columns(cols);
    for (const name of this.#pk) delete values[name];
    await this.#builder
      .update(this.#table, values, hash(this.#pkValues()))
      .execute();
  }

  async delete(): Promise<void> {
    await this.#builder.delete(this.#table, hash(this.#pkValues())).execute();
  }

  #columns(include: readonly string[]): Params {
    const values: Params = {};
    for (const [name, value] of Object.entries(this.#record)) {
      if (value === undefined) continue;
      if (include.length > 0 && !include.includes(name)) continue;
      if (this.#exclude.includes(name)) continue;
      values[name] = value;
    }
    return values;
  }

  // A missing key value would otherwise widen the WHERE clause to other rows.
  #pkValues(): Params {
    const record = this.#record as Params;
    return Object.fromEntries(
      this.#pk.map((name) => {
        const value = record[name];
        if (value == null) {
          throw new MissingPKError(
            `dbx: primary key "${name}" of the ${this.#table} record has no value.`,
          );
        }
        return [name, value];
      }),
    );
  }
}
