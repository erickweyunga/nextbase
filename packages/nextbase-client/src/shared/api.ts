/** Default mount point of the NextBase route handler. */
export const DEFAULT_BASE_PATH = '/api/nextbase';

/** One validation failure. `code` is stable; `message` is for humans. */
export interface FieldError {
  code: string;
  message: string;
}

/** Validation errors keyed by field, nested like the input: `{ fields: { 2: { name: ... } } }`. */
export interface ErrorData {
  [key: string]: FieldError | ErrorData;
}

/** Body of every non-2xx JSON response. */
export interface ApiErrorBody {
  status: number;
  message: string;
  data: ErrorData;
  /**
   * Set on the 401 of a first sign-in step that needs a second one: pass it
   * to the second step, before it expires.
   */
  mfaId?: string;
  /** With `mfaId`: the ways this account can take the second step. */
  methods?: SignInMethod[];
}

/**
 * A way a session proved who signed in. `impersonation` marks a session a
 * superuser started to act as the record.
 */
export type SignInMethod =
  | 'password'
  | 'oauth2'
  | 'phoneCode'
  | 'emailCode'
  | 'totp'
  | 'recoveryCode'
  | 'impersonation';

/** A sign-in that needs a second step. */
export interface MfaRequired {
  /** Pass it to the second step, before it expires. */
  mfaId: string;
  /** The ways this account can take the second step. */
  methods: SignInMethod[];
}

export interface HealthResponse {
  status: 'ok';
}

/** A page of a list. With `skipTotal`, `totalItems` and `totalPages` are -1. */
export interface ListResult<T> {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  items: T[];
}

/** A record. Other keys are the collection's fields. */
export interface RecordModel {
  id: string;
  collectionId: string;
  collectionName: string;
  /** Related records loaded with the `expand` parameter. */
  expand?: Record<string, RecordModel | RecordModel[]>;
  [field: string]: unknown;
}

/** A sign-in or refresh response. `token` is omitted when the session is in the HttpOnly cookie. */
export interface AuthResponse<T extends RecordModel = RecordModel> {
  token?: string;
  record: T;
  /** How the session signed in, such as `["password", "totp"]`. */
  methods: SignInMethod[];
}

/** One signed-in device or client of a record. */
export interface SessionModel {
  id: string;
  created: string;
  expires: string;
  userAgent: string;
  /** Whether this is the session making the request. */
  current: boolean;
  /**
   * The id of the superuser acting as the record, set only on an
   * impersonation session. Revoke it like any other session.
   */
  impersonatedBy?: string;
  /**
   * How the session signed in, such as `["password", "totp"]`. Empty for
   * sessions older than this field.
   */
  methods: SignInMethod[];
}

/** The caller's own session and record. */
export interface CurrentSession<T extends RecordModel = RecordModel>
  extends SessionModel {
  record: T;
}

/** An impersonation's response: like a sign-in, with the new session. */
export interface ImpersonateResponse<T extends RecordModel = RecordModel>
  extends AuthResponse<T> {
  session: SessionModel;
}

export interface SetupStatus {
  /** True until the first superuser exists. */
  required: boolean;
}

/** How records of an auth collection can sign in. */
export interface AuthMethods {
  password: {
    /** False when the collection's authRule is null. */
    enabled: boolean;
    /** Fields the identity may be, such as `email` or `username`. */
    identityFields: string[];
  };
  oauth2: {
    /** False without providers, for superusers, or when nobody signs in. */
    enabled: boolean;
    providers: AuthProvider[];
  };
  phone: {
    enabled: boolean;
  };
  /** Sign-in by a code emailed to the account, with no password. */
  otp: {
    enabled: boolean;
  };
  /** A second sign-in step, for the accounts the collection's settings name. */
  mfa: {
    enabled: boolean;
    /** Seconds a sign-in waits for its second step. */
    duration: number;
  };
}

/** Whether a record has an authenticator app, and its recovery codes left. */
export interface MfaStatus {
  totp: boolean;
  recoveryCodesLeft: number;
}

/** An authenticator app to set up: show `uri` as a QR code, or `secret` to type in. */
export interface TotpSetup {
  /** Base32, as authenticator apps take it. */
  secret: string;
  /** An `otpauth://totp/...` URI. */
  uri: string;
}

/** One-time codes for when the authenticator app is lost. Shown only once. */
export interface RecoveryCodes {
  recoveryCodes: string[];
}

/** An OAuth2 provider a sign-in page can offer. */
export interface AuthProvider {
  /** The server's `oauth2` key, such as `google`. */
  name: string;
  /** Button label, such as `Google`. */
  displayName: string;
}

/** An entry of the server's log. */
export interface LogModel {
  id: string;
  created: string;
  /** -4 debug, 0 info, 4 warn, 8 error. */
  level: number;
  /** Such as `GET /api/nextbase/collections/posts/records`. */
  message: string;
  /** `type` says what it is: `request`, or the background work that failed. */
  data: Record<string, unknown>;
}

/** The number of log entries in one hour. */
export interface LogStat {
  /** The start of the hour, in UTC. */
  date: string;
  total: number;
}

/** A provider account linked to an auth record. */
export interface LinkedAccountModel {
  id: string;
  provider: string;
  created: string;
}
