import type { MailKind } from "./auth/mail.ts";

export interface MailNote {
  kind: MailKind;
  collection: string;
  to: string;
}

/** Work that follows the request's database changes: kept on success, undone on failure. */
export class Effects {
  /** Sent on success. */
  readonly mail: MailNote[] = [];
  /** Deleted on success. */
  readonly obsoleteFiles: string[] = [];
  /** Deleted on failure. */
  readonly newFiles: string[] = [];
  /** After hooks, run in the background on success. */
  readonly hooks: (() => Promise<void>)[] = [];

  /** Takes on the work of writes that succeeded inside this request's. */
  absorb(other: Effects): void {
    this.mail.push(...other.mail);
    this.obsoleteFiles.push(...other.obsoleteFiles);
    this.newFiles.push(...other.newFiles);
    this.hooks.push(...other.hooks);
  }
}
