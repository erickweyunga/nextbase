import type { BaseCollection } from '@nextbasejs/client';
import { and, type Builder, type DB } from '@nextbasejs/dbx';
import type { Principal } from '../auth/principal.ts';
import { table } from '../db/system.ts';
import { ApiError } from '../errors.ts';
import { compileFilter } from '../filter/compiler.ts';
import { FilterError } from '../filter/parser.ts';
import type { Schema } from '../schema/cache.ts';

const LOGS = '_logs';

/**
 * `_logs` as a collection, so the records API's listing, filters and sorts
 * read it. It is not in the schema: no records API, realtime or typegen.
 */
export function logsCollection(): BaseCollection {
  return {
    id: LOGS,
    name: LOGS,
    type: 'base',
    system: true,
    fields: [
      {
        id: '_id',
        name: 'id',
        type: 'text',
        system: true,
        required: true,
        hidden: false,
        min: 15,
        max: 15,
        pattern: '^[a-z0-9]+$',
        primaryKey: true,
      },
      {
        id: '_created',
        name: 'created',
        type: 'autodate',
        system: true,
        required: false,
        hidden: false,
        onCreate: true,
        onUpdate: false,
      },
      {
        id: '_level',
        name: 'level',
        type: 'number',
        system: true,
        required: true,
        hidden: false,
        min: null,
        max: null,
        onlyInt: true,
      },
      {
        id: '_message',
        name: 'message',
        type: 'text',
        system: true,
        required: true,
        hidden: false,
        min: 0,
        max: 0,
        pattern: '',
        primaryKey: false,
      },
      {
        id: '_data',
        name: 'data',
        type: 'json',
        system: true,
        required: false,
        hidden: false,
        maxSize: 0,
      },
    ],
    indexes: [],
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
  };
}

/** A log entry as the API returns it: a record without its collection. */
export function logModel(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const { collectionId: _, collectionName: __, ...entry } = record;
  return entry;
}

export interface LogStat {
  /** The start of the hour, such as `2026-01-31T14:00:00.000Z`. */
  date: string;
  total: number;
}

const ALIAS = 't0';

/** Entries matching `filter` per hour, in UTC, oldest first. */
export async function logStats(
  q: Builder,
  context: { schema: Schema; principal: Principal },
  filter: string,
): Promise<LogStat[]> {
  let where: ReturnType<typeof compileFilter>;
  try {
    where = compileFilter(filter, logsCollection(), ALIAS, {
      ...context,
      request: { method: 'GET', query: {}, headers: {}, body: {} },
      mode: 'filter',
    });
  } catch (error) {
    if (!(error instanceof FilterError)) throw error;
    throw new ApiError(400, `Invalid filter: ${error.message}`);
  }
  const hour = `date_trunc('hour', ${ALIAS}.created, 'UTC')`;
  const rows = await q
    .select(`${hour} AS date`, 'COUNT(*) AS total')
    .from(`${table(LOGS)} ${ALIAS}`)
    .where(and(where))
    .groupBy(hour)
    .orderBy(hour)
    .all<{ date: Date; total: string }>();
  return rows.map(({ date, total }) => ({
    date: date.toISOString(),
    total: Number(total),
  }));
}

/**
 * Deletes every entry. Not TRUNCATE: its exclusive lock would hold up every
 * instance's log writes behind any open read of the table.
 */
export async function deleteLogs(db: DB): Promise<void> {
  await db.newQuery(`DELETE FROM {{${table(LOGS)}}}`).execute();
}
