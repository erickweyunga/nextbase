import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Principal } from '../auth/principal.ts';
import type { Cursor } from './events.ts';

/**
 * Event ids are cursors signed for one caller and one schema version:
 * `{position}.{seq}.{schemaVersion}.{signature}`. Only the caller a stream
 * sent an id to can resume from it, and only while its signed-in record and
 * the collections are as they were: resuming replays past events against
 * today's rules, which may now let the caller see what they once hid.
 */
export class CursorSigner {
  readonly #key: Buffer;

  /** `secret` is NextBase's own, from the database. */
  constructor(secret: string) {
    this.#key = createHmac('sha256', secret)
      .update('nextbase realtime cursor')
      .digest();
  }

  sign(cursor: Cursor, schemaVersion: number, principal: Principal): string {
    const body = `${cursor.position}.${cursor.seq}.${schemaVersion}`;
    return `${body}.${this.#signature(body, principal)}`;
  }

  /**
   * The cursor of an id signed for this caller and schema version, or
   * undefined for any other id.
   */
  verify(
    id: string,
    schemaVersion: number,
    principal: Principal,
  ): Cursor | undefined {
    const match = /^(\d{1,19})\.(\d{1,19})\.(\d{1,19})\.([\w-]{22})$/.exec(id);
    if (!match) return undefined;
    const [, position, seq, version, signature] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    const body = `${position}.${seq}.${version}`;
    const expected = Buffer.from(this.#signature(body, principal));
    if (!timingSafeEqual(expected, Buffer.from(signature))) return undefined;
    if (Number(version) !== schemaVersion) return undefined;
    return { position: BigInt(position), seq: BigInt(seq) };
  }

  #signature(body: string, principal: Principal): string {
    return createHmac('sha256', this.#key)
      .update(`${body}.${binding(principal)}`)
      .digest('base64url')
      .slice(0, 22);
  }
}

/**
 * Who a cursor is for: the session and the signed-in record as it is, so a
 * changed record, such as one given a new role, cannot resume; superuser
 * server code; or anyone signed out.
 */
function binding(principal: Principal): string {
  if (principal.session && principal.record) {
    const record = createHash('sha256')
      .update(JSON.stringify(principal.record))
      .digest('base64url');
    return `session:${principal.session.id}:${record}`;
  }
  return principal.superuser ? 'superuser' : 'anonymous';
}
