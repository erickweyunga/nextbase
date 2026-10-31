import type { Builder } from '@nextbasejs/dbx';
import { table } from '../db/system.ts';

// How each record's password was last set while MFA is on (`chosen` if no row).
// After an `emailReset` or `phoneReset`, that channel alone held both steps.

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
