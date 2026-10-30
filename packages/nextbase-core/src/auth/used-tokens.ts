import { createHash } from 'node:crypto';
import type { Builder } from '@nextbasejs/dbx';
import { table } from '../db/system.ts';

/** Marks a single-use token used; false when it was already. */
export async function spendToken(
  db: Builder,
  jti: string,
  exp: unknown,
): Promise<boolean> {
  const spent = await db
    .newQuery(
      `WITH expired AS (
         DELETE FROM {{${table('_used_tokens')}}} WHERE expires <= now()
       )
       INSERT INTO {{${table('_used_tokens')}}} (id_hash, expires)
       VALUES ({:idHash}, to_timestamp({:exp}))
       ON CONFLICT (id_hash) DO NOTHING
       RETURNING 1`,
    )
    .bind({
      idHash: createHash('sha256').update(jti).digest('hex'),
      exp: typeof exp === 'number' ? exp : 0,
    })
    .column();
  return spent.length > 0;
}
