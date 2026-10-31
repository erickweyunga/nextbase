import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
} from 'node:crypto';

// A software authenticator, as browsers emulate in devtools: ES256 keys, "none"
// attestation, and the browser's WebAuthn JSON helpers on `globalThis`.

interface Key {
  credentialId: Buffer;
  privateKey: KeyObject;
  rpId: string;
  userHandle: string;
  counter: number;
}

type Json = Record<string, unknown>;

export interface Behavior {
  /** The origin the browser reports; the page's own by default. */
  origin?: string;
  /** Whether the device checked the user, such as by fingerprint. */
  userVerified?: boolean;
  /** Overrides the next signature counter. */
  counter?: number;
  /** Answers with this record's passkey, as when the user picks it. */
  account?: string;
}

export class Authenticator {
  readonly keys: Key[] = [];
  /** The last options a ceremony was given. */
  lastOptions: Json | undefined;
  /** The passkeys the page told the device to forget. */
  readonly forgotten: string[] = [];
  /** The `mediation` of the last `get`. */
  lastMediation: string | undefined;
  behavior: Behavior = {};

  constructor(readonly origin: string) {}

  /** Puts this authenticator where the browser's WebAuthn API is. */
  install(): () => void {
    const g = globalThis as Record<string, unknown>;
    const before = { PublicKeyCredential: g.PublicKeyCredential };
    const navigatorBefore = Object.getOwnPropertyDescriptor(g, 'navigator');
    g.PublicKeyCredential = {
      parseCreationOptionsFromJSON: (options: Json) => options,
      parseRequestOptionsFromJSON: (options: Json) => options,
      signalUnknownCredential: async ({
        credentialId,
      }: {
        credentialId: string;
      }) => {
        this.forgotten.push(credentialId);
      },
    };
    Object.defineProperty(g, 'navigator', {
      configurable: true,
      value: {
        credentials: {
          create: async ({ publicKey }: { publicKey: Json }) =>
            jsonCredential(this.create(publicKey)),
          get: async ({
            publicKey,
            mediation,
          }: {
            publicKey: Json;
            mediation?: string;
          }) => {
            this.lastMediation = mediation;
            return jsonCredential(this.get(publicKey));
          },
        },
      },
    });
    return () => {
      g.PublicKeyCredential = before.PublicKeyCredential;
      if (navigatorBefore)
        Object.defineProperty(g, 'navigator', navigatorBefore);
      else delete g.navigator;
    };
  }

  /** A registration response, as `credential.toJSON()` gives it. */
  create(options: Json): Json {
    this.lastOptions = options;
    const rp = options.rp as { id: string };
    const user = options.user as { id: string };
    const excluded = (options.excludeCredentials as { id: string }[]) ?? [];
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    });
    const credentialId = randomBytes(16);
    if (excluded.some((c) => c.id === b64(credentialId))) {
      throw new Error('InvalidStateError');
    }
    const key: Key = {
      credentialId,
      privateKey,
      rpId: rp.id,
      userHandle: user.id,
      counter: 0,
    };
    this.keys.push(key);
    const jwk = publicKey.export({ format: 'jwk' });
    const cose = cbor(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x as string, 'base64url')],
        [-3, Buffer.from(jwk.y as string, 'base64url')],
      ]),
    );
    const attested = Buffer.concat([
      Buffer.alloc(16),
      uint16(credentialId.length),
      credentialId,
      cose,
    ]);
    const authData = this.#authData(rp.id, key, true, attested);
    const clientData = this.#clientData(
      'webauthn.create',
      options.challenge as string,
    );
    return {
      id: b64(credentialId),
      rawId: b64(credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64(clientData),
        attestationObject: b64(
          cbor(
            new Map<string, unknown>([
              ['fmt', 'none'],
              ['attStmt', new Map()],
              ['authData', authData],
            ]),
          ),
        ),
        transports: ['internal'],
      },
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
    };
  }

  /** An assertion by the newest passkey the options allow. */
  get(options: Json): Json {
    this.lastOptions = options;
    const rpId = options.rpId as string;
    const allowed = (options.allowCredentials as { id: string }[]) ?? [];
    const key = this.keys.findLast(
      (k) =>
        k.rpId === rpId &&
        (this.behavior.account === undefined ||
          k.userHandle === b64(Buffer.from(this.behavior.account))) &&
        (allowed.length === 0 ||
          allowed.some((c) => c.id === b64(k.credentialId))),
    );
    if (!key) throw new Error('NotAllowedError');
    return this.assert(key, options.challenge as string);
  }

  /** An assertion by `key`, for `challenge`. */
  assert(key: Key, challenge: string): Json {
    key.counter = this.behavior.counter ?? key.counter + 1;
    const authData = this.#authData(key.rpId, key);
    const clientData = this.#clientData('webauthn.get', challenge);
    const signature = sign(
      'sha256',
      Buffer.concat([
        authData,
        createHash('sha256').update(clientData).digest(),
      ]),
      key.privateKey,
    );
    return {
      id: b64(key.credentialId),
      rawId: b64(key.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64(clientData),
        authenticatorData: b64(authData),
        signature: b64(signature),
        userHandle: key.userHandle,
      },
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
    };
  }

  #authData(rpId: string, key: Key, attest = false, attested?: Buffer): Buffer {
    const uv = this.behavior.userVerified ?? true;
    // UP, UV, backup eligible and backed up, as a synced passkey has.
    let flags = 0x01 | 0x08 | 0x10 | (uv ? 0x04 : 0);
    if (attest) flags |= 0x40;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(key.counter);
    return Buffer.concat([
      createHash('sha256').update(rpId).digest(),
      Buffer.from([flags]),
      counter,
      ...(attested ? [attested] : []),
    ]);
  }

  #clientData(type: string, challenge: string): Buffer {
    return Buffer.from(
      JSON.stringify({
        type,
        challenge,
        origin: this.behavior.origin ?? this.origin,
        crossOrigin: false,
      }),
    );
  }
}

function jsonCredential(json: Json): { id: string; toJSON(): Json } {
  return { id: json.id as string, toJSON: () => json };
}

function b64(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function uint16(n: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(n);
  return out;
}

/** The CBOR WebAuthn needs: integers, byte and text strings, and maps. */
function cbor(value: unknown): Buffer {
  if (typeof value === 'number') {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (Buffer.isBuffer(value))
    return Buffer.concat([head(2, value.length), value]);
  if (typeof value === 'string') {
    const text = Buffer.from(value);
    return Buffer.concat([head(3, text.length), text]);
  }
  if (value instanceof Map) {
    return Buffer.concat([
      head(5, value.size),
      ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)]),
    ]);
  }
  throw new TypeError(`Cannot encode ${typeof value} as CBOR.`);
}

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  const out = Buffer.alloc(3);
  out[0] = (major << 5) | 25;
  out.writeUInt16BE(n, 1);
  return out;
}
