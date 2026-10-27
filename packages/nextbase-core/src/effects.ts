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
}
