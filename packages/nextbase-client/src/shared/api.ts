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
  | 'passkey'
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
  /** In development only, while required: the setup token, so the admin can open its setup screen. */
  token?: string;
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
  /** Sign-in with a passkey; false without the server's `appUrl`. */
  passkey: {
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

/** How the server keeps its log, from the `logs` option. */
export interface LogSettings {
  /** Days entries are kept. */
  maxDays: number;
  /** Entries below this level are not kept: -4 debug, 0 info, 4 warn, 8 error. */
  minLevel: number;
  /** Whether each request records the id of its signed-in record. */
  authId: boolean;
  /** Whether each request records the client's IP, when `clientIp` knows it. */
  ip: boolean;
}

/** Where uploaded files are kept, from the `storage` option; credentials are never sent. */
export type StorageSettings =
  | {
      kind: 'local';
      /** The folder on the server's disk. */
      dir: string;
    }
  | {
      kind: 's3';
      bucket: string;
      region: string;
      /** For providers other than AWS, or empty. */
      endpoint: string;
      forcePathStyle: boolean;
      /** `keys` when the option sets them; otherwise the AWS SDK's own sources apply. */
      credentials: 'keys' | 'sdk';
    };

/** One kind of email the server sends. */
export interface MailEmail {
  /** Such as `verification`, the key of `mail.templates`. */
  kind: string;
  /** The default template's subject, naming the email. */
  subject: string;
  /** Whether `mail.templates` replaces the default. */
  custom: boolean;
  /** The page its link opens, with a `?token=` added, or empty for emails without one. */
  link: string;
}

/** How the server sends email, from the `mail` option. */
export interface MailSettings {
  /**
   * `send` through the option; without it, `log` writes emails to the server log, as
   * development does, and `off` refuses them, as production does.
   */
  delivery: 'send' | 'log' | 'off';
  /** The sender, or empty without the option. */
  from: string;
  emails: MailEmail[];
}

/** Where the client's IP comes from, from the `clientIp` option. */
export type ClientIpSettings =
  | { source: 'vercel' }
  | {
      source: 'header';
      header: string;
      /** Proxies of yours that append to the header after the one that saw the client. */
      trustedHops: number;
    }
  | { source: 'function' }
  /** No option and not on Vercel: no header can be trusted. */
  | { source: 'unknown' };

/** One rate limit rule. */
export interface RateLimitRuleSettings {
  /** A route tag (`*:auth`), method and path (`POST /batch`), exact path or prefix. */
  label: string;
  /** Only guests, only signed-in callers, or `null` for both. */
  audience: 'guest' | 'auth' | null;
  max: number;
  /** Seconds. */
  window: number;
}

/** The app's address and how requests are handled. */
export interface ApplicationSettings {
  /** The URL for email links and OAuth2 redirects, or empty. */
  appUrl: string;
  /** Where the API is mounted, such as `/api/nextbase`. */
  basePath: string;
  /** Other hosts allowed to write with the session cookie. */
  trustedOrigins: string[];
  /** Whether the host is read from X-Forwarded-Host. */
  trustProxy: boolean;
  clientIp: ClientIpSettings;
  /** Milliseconds a records API statement may run, or 0 for no limit. */
  statementTimeout: number;
  /** `null` when rate limits are off. */
  rateLimits: {
    rules: RateLimitRuleSettings[];
    /** IPs and CIDR ranges never limited. */
    excludedIps: string[];
  } | null;
  /** `null` when realtime is off. */
  realtime: {
    /** The collections that send events, or `null` for all. */
    collections: string[] | null;
    /** Seconds a stream stays open before the client reconnects. */
    streamSeconds: number;
  } | null;
}

/** One OAuth2 provider, from the `oauth2` option; its client secret is never sent. */
export interface OAuth2ProviderSettings {
  name: string;
  displayName: string;
  /** The OpenID Connect issuer, or empty for GitHub's own OAuth2. */
  issuer: string;
  /** ID tokens issued to any are accepted; the first is the one browser sign-ins use. */
  clientIds: string[];
  /** The redirect URI to register in the provider's app. */
  callbackUrl: string;
  /** Every scope a sign-in asks for. */
  scopes: string[];
  /** More parameters for the provider's authorization page, `prompt` among them. */
  params: Record<string, string>;
  /** Whether it signs in and links existing accounts only. */
  disableSignUp: boolean;
  /** Whether each linked account's tokens are kept, encrypted. */
  storeTokens: boolean;
  /** Whether `mapProfile` fills the accounts it creates. */
  mapProfile: boolean;
  /** Fields filled from the profile, by claim, or `null` when off. */
  profileFields: Record<string, string> | null;
  /** Hosts profile photos may be downloaded from. */
  photoHosts: string[];
  /** Fields updated from the profile at every sign-in. */
  refreshProfile: string[];
}

/** How secrets and sign-ins are guarded; the keys themselves are never sent. */
export interface SecuritySettings {
  /** The keys that encrypt stored secrets: the first encrypts, all decrypt. */
  secretKeys: number;
  /** `option` for `secretKey`, `env` for `NEXTBASE_SECRET_KEY`, or `none`. */
  secretKeySource: 'option' | 'env' | 'none';
  /** Whether new passwords found in known breaches are refused. */
  rejectBreachedPasswords: boolean;
  /** Whether `validateSignIn` checks each sign-up, link and sign-in. */
  validateSignIn: boolean;
}

/** The settings in effect, from the options passed to `nextbase()`. */
export interface SettingsModel {
  application: ApplicationSettings;
  security: SecuritySettings;
  oauth2: OAuth2ProviderSettings[];
  /** `null` when logs are off. */
  logs: LogSettings | null;
  storage: StorageSettings;
  mail: MailSettings;
}

/** One of the app's migrations, by its file name. */
export interface MigrationModel {
  name: string;
  /** When it ran on this database, or `null` while pending. */
  applied: string | null;
  /** Whether the app still has its file; an applied one may be gone, such as after a squash. */
  file: boolean;
  /** Whether it has a `down` that `revertMigrations()` can undo it with. */
  revertible: boolean;
}

/** The app's migrations and how collection changes are recorded. */
export interface MigrationsStatus {
  /** Whether the app passes its migrations to NextBase. */
  enabled: boolean;
  /** Their folder from the project root, or empty without them. */
  dir: string;
  /** Whether each collection change writes a migration here. */
  automigrate: boolean;
  /** Whether the API may change collections here. */
  schemaChanges: boolean;
  /** Newest first. */
  items: MigrationModel[];
}

/** A passkey of an auth record; its private key never leaves the device. */
export interface PasskeyModel {
  id: string;
  /** The owner's label for it, or empty. */
  name: string;
  /** The authenticator model, such as a password manager; zeros when it does not say. */
  aaguid: string;
  /** Synced to other devices, such as by a password manager. */
  backedUp: boolean;
  created: string;
  /** Empty until it signs in. */
  lastUsed: string;
}

/** A provider account linked to an auth record. */
export interface LinkedAccountModel {
  id: string;
  provider: string;
  created: string;
}
