import type { MailKind } from "./auth/mail.ts";

/** An email to send once the request has succeeded. */
export interface MailNote {
  kind: MailKind;
  collection: string;
  to: string;
}

/**
 * Work whose fate depends on whether the request succeeds. A request can
 * fail after it changed things, alone or as part of a batch, and its database
 * changes then roll back; these follow them.
 */
export class Effects {
  /** Emails that tell people about saved changes: sent only on success. */
  readonly mail: MailNote[] = [];
  /** Stored files the saved changes no longer need: deleted only on success. */
  readonly obsoleteFiles: string[] = [];
  /** Files stored during the request: deleted again if it fails. */
  readonly newFiles: string[] = [];
}
