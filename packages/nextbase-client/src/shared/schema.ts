// The collection model as the collections API sends and receives it. The server
// parses and validates it; the client SDK exposes it as types.

export type FieldType =
  | "text"
  | "number"
  | "bool"
  | "email"
  | "phone"
  | "url"
  | "date"
  | "autodate"
  | "select"
  | "relation"
  | "file"
  | "json"
  | "password";

interface FieldBase<T extends FieldType> {
  /** Stable for the field's lifetime, so renames are detected as renames. */
  id: string;
  name: string;
  type: T;
  /** Defined by the collection type; cannot be removed, renamed or retyped. */
  system: boolean;
  /** The value must not be blank. */
  required: boolean;
  /** Left out of API output, client filters and sorts. */
  hidden: boolean;
}

export interface TextField extends FieldBase<"text"> {
  min: number;
  max: number;
  /** A regular expression the value must match, or "" for none. */
  pattern: string;
  /** Only the system `id` field. */
  primaryKey: boolean;
}

export interface NumberField extends FieldBase<"number"> {
  min: number | null;
  max: number | null;
  onlyInt: boolean;
}

export interface BoolField extends FieldBase<"bool"> {}

export interface EmailField extends FieldBase<"email"> {
  onlyDomains: string[];
  exceptDomains: string[];
}

/** A phone number, stored in E.164 such as `+255712345678`. */
export type PhoneField = FieldBase<"phone">;

export interface UrlField extends FieldBase<"url"> {
  onlyDomains: string[];
  exceptDomains: string[];
}

export interface DateField extends FieldBase<"date"> {
  /** ISO 8601 timestamps, or "" for no bound. */
  min: string;
  max: string;
}

export interface AutodateField extends FieldBase<"autodate"> {
  onCreate: boolean;
  onUpdate: boolean;
}

export interface SelectField extends FieldBase<"select"> {
  values: string[];
  maxSelect: number;
}

export interface RelationField extends FieldBase<"relation"> {
  collectionId: string;
  maxSelect: number;
  cascadeDelete: boolean;
}

export interface FileField extends FieldBase<"file"> {
  maxSelect: number;
  /** Bytes per file. */
  maxSize: number;
  /** Allowed MIME types, or empty for any. */
  mimeTypes: string[];
  /** Served only with a file token to callers that pass the view rule. */
  protected: boolean;
}

export interface JsonField extends FieldBase<"json"> {
  /** Bytes of serialized JSON. */
  maxSize: number;
}

export interface PasswordField extends FieldBase<"password"> {
  min: number;
  max: number;
}

export type Field =
  | TextField
  | NumberField
  | BoolField
  | EmailField
  | PhoneField
  | UrlField
  | DateField
  | AutodateField
  | SelectField
  | RelationField
  | FileField
  | JsonField
  | PasswordField;

export type TokenType =
  | "auth"
  | "verification"
  | "passwordReset"
  | "emailChange"
  | "file";

export interface TokenConfig {
  /** Combined with each record's `tokenKey` to sign tokens of this type. */
  secret: string;
  /** Lifetime in seconds. */
  duration: number;
}

export interface Index {
  /** Unique across every collection: Postgres indexes share one namespace with tables. */
  name: string;
  unique: boolean;
  /** Field ids, so indexes survive field renames. */
  fields: string[];
  /**
   * `btree` serves equality, ranges and sorting. `trigram` serves `~`
   * (contains) on text fields, and needs Postgres's pg_trgm extension.
   */
  type: "btree" | "trigram";
}

/**
 * Access rules: `null` allows only superusers, `""` allows anyone, and any
 * other value is a filter expression the request must satisfy.
 */
export type Rule = string | null;

interface CollectionBase {
  id: string;
  name: string;
  /** Created by NextBase; cannot be deleted, renamed, or have its rules changed. */
  system: boolean;
  fields: Field[];
  indexes: Index[];
  listRule: Rule;
  viewRule: Rule;
  createRule: Rule;
  updateRule: Rule;
  deleteRule: Rule;
}

export interface BaseCollection extends CollectionBase {
  type: "base";
}

export interface AuthCollection extends CollectionBase {
  type: "auth";
  /** Extra condition a record must meet to log in or refresh, e.g. `verified = true`. */
  authRule: Rule;
  /** Lets matching callers change other records' email, password and verified flag. */
  manageRule: Rule;
  /** Field names a login identity is matched against. */
  identityFields: string[];
  /**
   * Sign-in with codes sent by SMS to the `phone` field, which also lets a
   * record have a phone instead of an email.
   */
  phoneAuth: boolean;
  tokens: Record<TokenType, TokenConfig>;
}

/**
 * A read-only collection whose records are the rows of a SQL query over other
 * collections. Its fields are derived from the query's columns.
 */
export interface ViewCollection extends CollectionBase {
  type: "view";
  /** A SELECT over collection tables, by name, with an `id` column. */
  viewQuery: string;
}

export type Collection = BaseCollection | AuthCollection | ViewCollection;
