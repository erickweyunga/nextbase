import type { Builder } from "./builder.ts";
import { hash } from "./expression.ts";
import type { Params } from "./query.ts";
import { quoteIdentifier } from "./sql.ts";

/** Thrown when a model has no primary key, or its key value is missing. */
export class MissingPKError extends Error {
  constructor(message = "dbx: missing primary key.") {
    super(message);
    this.name = "MissingPKError";
  }
}

/** Thrown by `SelectQuery.model()` for a composite primary key. */
export class CompositePKError extends Error {
  constructor() {
    super("dbx: composite primary key is not supported.");
    this.name = "CompositePKError";
  }
}

export interface ModelOptions {
  /** Primary key column, or columns for a composite key. Defaults to `"id"`. */
  pk?: string | readonly string[];
}

/**
 * Inserts, updates or deletes one record. Record keys are column names;
 * `undefined` values are left out.
 */
export class ModelQuery<T extends object> {
  readonly #builder: Builder;
  readonly #table: string;
  readonly #record: T;
  readonly #pk: readonly string[];
  #exclude: readonly string[] = [];
  #signal: AbortSignal | undefined;

  constructor(
    builder: Builder,
    table: string,
    record: T,
    options: ModelOptions = {},
  ) {
    this.#builder = builder;
    this.#table = table;
    this.#record = record;
    this.#signal = builder.options.signal;
    const pk = options.pk ?? "id";
    this.#pk = typeof pk === "string" ? [pk] : pk;
    if (this.#pk.length === 0) throw new MissingPKError();
  }

  /** Makes the model's statements abortable. See `Query.withSignal()`. */
  withSignal(signal: AbortSignal | undefined): this {
    this.#signal = signal;
    return this;
  }

  /** Columns to leave out of `insert()` and `update()`. */
  exclude(...cols: (keyof T & string)[]): this {
    this.#exclude = cols;
    return this;
  }

  /**
   * Inserts the record. With `cols`, only those columns are inserted.
   *
   * If the key is a single column whose value is `null` or `undefined`, it is
   * left to the database default and the generated value is written back to
   * the record.
   */
  async insert(...cols: (keyof T & string)[]): Promise<void> {
    const values = this.#columns(cols);
    const [pk] = this.#pk;
    // Generated keys are decided by the record, not the column list, so a
    // record that has its key never has it overwritten.
    if (
      this.#pk.length !== 1 ||
      pk === undefined ||
      (this.#record as Params)[pk] != null
    ) {
      await this.#builder
        .insert(this.#table, values)
        .withSignal(this.#signal)
        .execute();
      return;
    }

    delete values[pk];
    const insert = this.#builder.insert(this.#table, values);
    const [id] = await this.#builder
      .newQuery(`${insert.sql} RETURNING ${quoteIdentifier(pk)}`)
      .bind(insert.params)
      .withSignal(this.#signal)
      .row();
    (this.#record as Params)[pk] = id;
  }

  /**
   * Updates the record by primary key. With `cols`, only those columns are
   * updated. Throws MissingPKError if the key has no value.
   */
  async update(...cols: (keyof T & string)[]): Promise<void> {
    const values = this.#columns(cols);
    for (const name of this.#pk) delete values[name];
    await this.#builder
      .update(this.#table, values, hash(this.#pkValues()))
      .withSignal(this.#signal)
      .execute();
  }

  /** Deletes the record by primary key. Throws MissingPKError if the key has no value. */
  async delete(): Promise<void> {
    await this.#builder
      .delete(this.#table, hash(this.#pkValues()))
      .withSignal(this.#signal)
      .execute();
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
