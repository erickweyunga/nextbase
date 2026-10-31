import type { MailKind } from './auth/mail.ts';

export interface MailNote {
  kind: MailKind;
  collection: string;
  to: string;
}

/** The work that follows writes, once they are committed. */
export interface Committed {
  mail: MailNote[];
  obsoleteFiles: string[];
  hooks: (() => Promise<void>)[];
}

/**
 * Work that follows the request's database changes: kept on success, undone on
 * failure. Call `commit()` after writes that commit before the request may fail.
 */
export class Effects {
  /** Sent on success. */
  readonly mail: MailNote[] = [];
  /** Deleted on success. */
  readonly obsoleteFiles: string[] = [];
  /** Deleted on failure. */
  readonly newFiles: string[] = [];
  /** After hooks, run in the background on success. */
  readonly hooks: (() => Promise<void>)[] = [];
  /** The work of writes already committed, done even if the request fails. */
  readonly committed: Committed = { mail: [], obsoleteFiles: [], hooks: [] };

  /**
   * Marks the work so far as following committed writes. Call it right after a
   * transaction commits, when no work of a failed transaction is left here.
   */
  commit(): void {
    this.committed.mail.push(...this.mail.splice(0));
    this.committed.obsoleteFiles.push(...this.obsoleteFiles.splice(0));
    this.committed.hooks.push(...this.hooks.splice(0));
    // The committed records keep them.
    this.newFiles.length = 0;
  }

  /** Takes on the work of writes that succeeded inside this request's. */
  absorb(other: Effects): void {
    this.committed.mail.push(...other.committed.mail);
    this.committed.obsoleteFiles.push(...other.committed.obsoleteFiles);
    this.committed.hooks.push(...other.committed.hooks);
    this.mail.push(...other.mail);
    this.obsoleteFiles.push(...other.obsoleteFiles);
    this.newFiles.push(...other.newFiles);
    this.hooks.push(...other.hooks);
  }
}
