// The collection model of the collections API, shared by server and client.

export type FieldType =
  | 'text'
  | 'number'
  | 'bool'
  | 'email'
  | 'phone'
  | 'url'
  | 'date'
  | 'autodate'
  | 'select'
  | 'relation'
  | 'file'
  | 'json'
  | 'password';

interface FieldBase<T extends FieldType> {
  /** Stable across renames. */
  id: string;
  name: string;
  type: T;
  /** Cannot be removed, renamed or retyped. */
  system: boolean;
  required: boolean;
  /** Excluded from API output and from client filters and sorts. */
  hidden: boolean;
}

export interface TextField extends FieldBase<'text'> {
  min: number;
  max: number;
  /** A regex the value must match, or "" for none. */
  pattern: string;
  /** Only the system `id` field. */
  primaryKey: boolean;
}

export interface NumberField extends FieldBase<'number'> {
  min: number | null;
  max: number | null;
  onlyInt: boolean;
}

export interface BoolField extends FieldBase<'bool'> {}

export interface EmailField extends FieldBase<'email'> {
  onlyDomains: string[];
  exceptDomains: string[];
}

/** A phone number, stored in E.164 such as `+255712345678`. */
export type PhoneField = FieldBase<'phone'>;

export interface UrlField extends FieldBase<'url'> {
  onlyDomains: string[];
  exceptDomains: string[];
}

export interface DateField extends FieldBase<'date'> {
  /** Timestamps such as `2026-01-31T00:00:00Z`, or "" for no bound. */
  min: string;
  max: string;
}

export interface AutodateField extends FieldBase<'autodate'> {
  onCreate: boolean;
  onUpdate: boolean;
}

export interface SelectField extends FieldBase<'select'> {
  values: string[];
  maxSelect: number;
}

export interface RelationField extends FieldBase<'relation'> {
  collectionId: string;
  maxSelect: number;
  cascadeDelete: boolean;
}

export interface FileField extends FieldBase<'file'> {
  maxSelect: number;
  /** Bytes per file. */
  maxSize: number;
  /** Allowed MIME types, or empty for any. */
  mimeTypes: string[];
  /** Served only with a file token to callers that pass the view rule. */
  protected: boolean;
  /**
   * Thumbnail sizes images may be requested in, such as `300x200`: `WxH`
   * crops from the centre, `WxHt` and `WxHb` from the top or bottom, `WxHf`
   * fits inside, `0xH` and `Wx0` keep the aspect ratio. `100x100` is always
   * allowed.
   */
  thumbs: string[];
}

export interface JsonField extends FieldBase<'json'> {
  /** Bytes of serialized JSON. */
  maxSize: number;
}

export interface PasswordField extends FieldBase<'password'> {
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
  | 'auth'
  | 'verification'
  | 'passwordReset'
  | 'emailChange'
  | 'file';

export interface TokenConfig {
  /** Combined with each record's `tokenKey` to sign tokens. */
  secret: string;
  /** Lifetime in seconds. */
  duration: number;
}

export interface Index {
  /** Unique across collections: Postgres indexes share a namespace with tables. */
  name: string;
  unique: boolean;
  /** Field ids, so indexes survive field renames. */
  fields: string[];
  /** `btree` for equality, ranges and sorting; `trigram` for `~` on text (needs pg_trgm). */
  type: 'btree' | 'trigram';
}

/** Access rule: `null` allows only superusers, `""` anyone, otherwise a filter expression. */
export type Rule = string | null;

interface CollectionBase {
  id: string;
  name: string;
  /** Cannot be deleted, renamed, or have its rules changed. */
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
  type: 'base';
}

export interface AuthCollection extends CollectionBase {
  type: 'auth';
  /** Extra condition to sign in or refresh, e.g. `emailVerified = true`. */
  authRule: Rule;
  /** Lets matching callers change other records' email, password and emailVerified. */
  manageRule: Rule;
  /** Fields a sign-in identity is matched against. */
  identityFields: string[];
  /** Sign-in with SMS codes; records may then have a phone instead of an email. */
  phoneSignIn: boolean;
  /**
   * Links a provider account to an existing account with the same email when
   * both verified it, at the first sign-in with it. `false`: such a sign-in
   * answers `account_exists`, and the owner links the provider from their
   * account. Never done for an account that takes a second sign-in step.
   */
  implicitLinking: boolean;
  tokens: Record<TokenType, TokenConfig>;
  /** A second sign-in step. */
  mfa: MfaConfig;
  /** When the email must be verified, and when the verification email goes out. */
  emailVerification: EmailVerificationConfig;
}

export interface EmailVerificationConfig {
  /**
   * Accounts with an unverified email cannot sign in. A sign-up with an
   * email that is already registered answers as a new one does, and the
   * owner is told.
   */
  required: boolean;
  /** Sends the verification email when an account signs up. */
  sendOnSignUp: boolean;
  /** Sends it again when an unverified account signs in with its password. */
  sendOnSignIn: boolean;
}

/** Which accounts of an auth collection must take a second sign-in step. */
export interface MfaConfig {
  enabled: boolean;
  /**
   * `null`: only accounts with an authenticator app. `""`: every account.
   * A filter: matching accounts, and those with an authenticator app.
   */
  rule: Rule;
  /** Seconds a sign-in waits for its second step, 60 to 3600. */
  duration: number;
}

/** A read-only collection backed by a SQL query; fields come from its columns. */
export interface ViewCollection extends CollectionBase {
  type: 'view';
  /** A SELECT over collection tables with an `id` column. */
  viewQuery: string;
}

export type Collection = BaseCollection | AuthCollection | ViewCollection;
