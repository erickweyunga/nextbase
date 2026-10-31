import { ClientError } from './client-error.ts';

// The browser's own WebAuthn JSON helpers (Baseline 2025) turn the server's options
// into what `navigator.credentials` takes, and its credential back into JSON.

/** Options as the server sends them, for `navigator.credentials`. */
export type PasskeyRequest = { rpId?: string } & Record<string, unknown>;

/** What a browser's credential, as `toJSON()` gives it, looks like. */
export type PasskeyCredential = { id: string } & Record<string, unknown>;

interface JsonCredential {
  id: string;
  toJSON(): PasskeyCredential;
}

interface WebAuthnStatics {
  parseCreationOptionsFromJSON(options: unknown): unknown;
  parseRequestOptionsFromJSON(options: unknown): unknown;
  isConditionalMediationAvailable?(): Promise<boolean>;
  signalUnknownCredential?(options: {
    rpId: string;
    credentialId: string;
  }): Promise<void>;
}

interface Credentials {
  create(options: {
    publicKey: unknown;
    signal?: AbortSignal;
  }): Promise<unknown>;
  get(options: {
    publicKey: unknown;
    mediation?: string;
    signal?: AbortSignal;
  }): Promise<unknown>;
}

interface Ceremony {
  signal?: AbortSignal | undefined;
}

function find():
  | { statics: WebAuthnStatics; credentials: Credentials }
  | undefined {
  const statics = (globalThis as { PublicKeyCredential?: WebAuthnStatics })
    .PublicKeyCredential;
  const credentials = (
    globalThis as { navigator?: { credentials?: Credentials } }
  ).navigator?.credentials;
  if (
    !statics ||
    !credentials ||
    typeof statics.parseCreationOptionsFromJSON !== 'function' ||
    typeof statics.parseRequestOptionsFromJSON !== 'function'
  ) {
    return undefined;
  }
  return { statics, credentials };
}

/** Throws before anything is sent where passkeys cannot work, such as on a server. */
export function webAuthn(): {
  statics: WebAuthnStatics;
  credentials: Credentials;
} {
  const found = find();
  if (!found) {
    throw new Error(
      'Passkeys need a browser that supports WebAuthn and its JSON helpers.',
    );
  }
  return found;
}

/** Whether this browser can offer passkeys in an input's autofill suggestions. */
export async function passkeyAutofillAvailable(): Promise<boolean> {
  const found = find();
  try {
    return (await found?.statics.isConditionalMediationAvailable?.()) === true;
  } catch {
    return false;
  }
}

/** Asks the device to create a passkey. */
export async function createPasskey(
  options: unknown,
  { signal }: Ceremony = {},
): Promise<PasskeyCredential> {
  const { statics, credentials } = webAuthn();
  return ceremony(signal, () =>
    credentials.create({
      publicKey: statics.parseCreationOptionsFromJSON(options),
      ...(signal && { signal }),
    }),
  );
}

/** Asks the device for a passkey; `autofill` waits for one picked from the form's suggestions. */
export async function getPasskey(
  options: unknown,
  { autofill, signal }: Ceremony & { autofill?: boolean } = {},
): Promise<PasskeyCredential> {
  const { statics, credentials } = webAuthn();
  return ceremony(signal, () =>
    credentials.get({
      publicKey: statics.parseRequestOptionsFromJSON(options),
      ...(autofill && { mediation: 'conditional' }),
      ...(signal && { signal }),
    }),
  );
}

/** Tells the device a passkey is gone here, so it stops offering it, where browsers can. */
export function forgetPasskey(rpId: string, credentialId: string): void {
  void find()
    ?.statics.signalUnknownCredential?.({ rpId, credentialId })
    .catch(() => {});
}

/**
 * The dialog's credential as JSON. Its errors, such as `NotAllowedError` when the
 * user cancels, become a `ClientError` of status 0 with the browser's error as `cause`.
 */
async function ceremony(
  signal: AbortSignal | undefined,
  run: () => Promise<unknown>,
): Promise<PasskeyCredential> {
  let credential: JsonCredential | null;
  try {
    credential = (await run()) as JsonCredential | null;
  } catch (cause) {
    throw new ClientError(
      {
        status: 0,
        message: cause instanceof Error ? cause.message : String(cause),
        data: {},
      },
      { cause, signal: signal ?? null },
    );
  }
  if (!credential) {
    throw new ClientError({
      status: 0,
      message: 'The device gave no passkey.',
      data: {},
    });
  }
  return credential.toJSON();
}
