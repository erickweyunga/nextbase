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

function webAuthn(): { statics: WebAuthnStatics; credentials: Credentials } {
  const statics = (globalThis as { PublicKeyCredential?: WebAuthnStatics })
    .PublicKeyCredential;
  const credentials = (
    globalThis as { navigator?: { credentials?: Credentials } }
  ).navigator?.credentials;
  if (
    !statics ||
    !credentials ||
    typeof statics.parseRequestOptionsFromJSON !== 'function'
  ) {
    throw new Error('Passkeys need a browser that supports WebAuthn.');
  }
  return { statics, credentials };
}

/** Asks the device to create a passkey. */
export async function createPasskey(
  options: unknown,
  signal?: AbortSignal,
): Promise<PasskeyCredential> {
  const { statics, credentials } = webAuthn();
  const credential = (await credentials.create({
    publicKey: statics.parseCreationOptionsFromJSON(options),
    ...(signal && { signal }),
  })) as JsonCredential;
  return credential.toJSON();
}

/** Asks the device for a passkey; `autofill` waits for one picked from the form's suggestions. */
export async function getPasskey(
  options: unknown,
  { autofill, signal }: { autofill?: boolean; signal?: AbortSignal },
): Promise<PasskeyCredential> {
  const { statics, credentials } = webAuthn();
  const credential = (await credentials.get({
    publicKey: statics.parseRequestOptionsFromJSON(options),
    ...(autofill && { mediation: 'conditional' }),
    ...(signal && { signal }),
  })) as JsonCredential;
  return credential.toJSON();
}

/** Tells the device a passkey is gone here, so it stops offering it, where browsers can. */
export function forgetPasskey(rpId: string, credentialId: string): void {
  const { statics } = webAuthn();
  void statics
    .signalUnknownCredential?.({ rpId, credentialId })
    .catch(() => {});
}
