import type { Builder } from '@nextbasejs/dbx';
import { table } from '../db/system.ts';

// How each record's password was last set, while its collection has MFA on.
// - `chosen`: at sign-up, by a change with the old password, or by a
//   superuser or manager. The default for records without a row.
// - `emailReset`, `phoneReset`: by a code or link sent there, so for a while
//   that inbox or phone alone held both steps.
// - `random`: generated at an OAuth2 or phone sign-up; nobody knows it.

export type PasswordOrigin = 'chosen' | 'emailReset' | 'phoneReset' | 'random';

/** How long a reset keeps codes to its channel from being the other step. */
export const RESET_HOLD = '24 hours';

export async function setPasswordOrigin(
  q: Builder,
  collectionId: string,
  recordId: string,
  origin: PasswordOrigin,
): Promise<void> {
  await q
    .newQuery(
      `INSERT INTO {{${table('_password_origins')}}} (collection_id, record_id, origin, set_at)
       VALUES ({:collectionId}, {:recordId}, {:origin}, now())
       ON CONFLICT (collection_id, record_id) DO UPDATE SET
         origin = EXCLUDED.origin, set_at = EXCLUDED.set_at`,
    )
    .bind({ collectionId, recordId, origin })
    .execute();
}
