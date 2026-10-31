import type { Collection, Field } from '@nextbasejs/client';
import type { Builder, Params, Row } from '@nextbasejs/dbx';
import { table } from '../db/system.ts';
import { decodeRecordJson } from '../db/types.ts';
import { timestampParam } from '../storable.ts';

/** The channel writes notify once they commit events. */
export const CHANNEL = 'nextbase_realtime';

export type RealtimeAction = 'create' | 'update' | 'delete';

const TRANSACTIONS = table('_realtime_transactions');
const EVENTS = table('_realtime_events');
const STATE = table('_realtime_state');

// Postgres takes at most 65535 parameters per statement; each event takes 2.
const PER_STATEMENT = 30_000;

/**
 * A position in the event log, after an event. Events order by their transaction's commit position,
 * then by their order in it. Positions are bigints, as Postgres sequences are.
 */
export interface Cursor {
  position: bigint;
  seq: bigint;
}

export function compareCursors(a: Cursor, b: Cursor): number {
  if (a.position !== b.position) return a.position < b.position ? -1 : 1;
  return a.seq === b.seq ? 0 : a.seq < b.seq ? -1 : 1;
}

/**
 * Logs that `records` were written, in their transaction, so an event exists exactly when its write commits.
 * A deferred trigger gives the transaction its position at commit, under a lock, so positions follow commit order.
 */
export async function writeEvents(
  q: Builder,
  collection: Collection,
  action: RealtimeAction,
  records: readonly Row[],
): Promise<void> {
  for (let i = 0; i < records.length; i += PER_STATEMENT) {
    const params: Params = { nb_c: collection.id, nb_a: action };
    const tuples = records.slice(i, i + PER_STATEMENT).map((record, j) => {
      params[`nb_r${j}`] = record.id;
      params[`nb_j${j}`] = JSON.stringify(snapshot(collection, record));
      return `({:nb_c}, {:nb_a}, {:nb_r${j}}, {:nb_j${j}}::jsonb)`;
    });
    // Data-modifying WITH clauses run whether or not the query reads them,
    // and a WITH query read twice runs once.
    await q
      .newQuery(
        `WITH "nb_tx" AS (
           SELECT COALESCE(
             NULLIF(current_setting('nextbase.realtime_tx', true), ''),
             set_config('nextbase.realtime_tx', nextval('${table('_realtime_transaction_ids')}')::text, true)
           )::bigint AS id
         ), "nb_mark" AS (
           INSERT INTO {{${TRANSACTIONS}}} (id) SELECT id FROM "nb_tx"
           ON CONFLICT DO NOTHING
         ), "nb_events" AS (
           INSERT INTO {{${EVENTS}}} (transaction_id, collection_id, action, record_id, record)
           SELECT "nb_tx".id, v.c, v.a, v.r, v.j
           FROM "nb_tx", (VALUES ${tuples.join(', ')}) AS v(c, a, r, j)
         )
         SELECT pg_notify('${CHANNEL}', '')`,
      )
      .bind(params)
      .execute();
  }
}

/**
 * The record as stored, for subscribers' rules and output, without password hash and token key.
 * Timestamps stay as Postgres writes them, so `decodeRecordJson` reads them back exactly.
 */
function snapshot(collection: Collection, record: Row): Row {
  const out: Row = {};
  for (const field of collection.fields) {
    if (secret(field)) continue;
    const value = record[field.name];
    out[field.name] = value instanceof Date ? timestampParam(value) : value;
  }
  return out;
}

function secret(field: Field): boolean {
  return (
    field.type === 'password' || (field.system && field.name === 'tokenKey')
  );
}

/** An event read from the log. */
export interface StoredEvent {
  cursor: Cursor;
  collectionId: string;
  action: RealtimeAction;
  recordId: string;
  /**
   * The record as written, stored without its secrets. Null for collections
   * the read did not ask for.
   */
  record: Row | null;
}

export interface EventPage {
  /** At most `limit` events after the cursor, in order. */
  events: StoredEvent[];
  /** Events after the cursor were deleted unread, as too old to keep. */
  lost: boolean;
  schemaVersion: number;
}

interface EventRow {
  schemaVersion: string;
  lost: boolean;
  position: string | null;
  seq: string | null;
  collectionId: string;
  action: RealtimeAction;
  recordId: string;
  record: Row | null;
}

/**
 * Reads events after `cursor`, in order, with the records of `collectionIds` (or of all collections).
 * Positions are taken at commit, after earlier commits, so no event later appears below one read.
 */
export async function readEvents(
  q: Builder,
  cursor: Cursor,
  collectionIds: readonly string[] | undefined,
  limit: number,
): Promise<EventPage> {
  const record =
    collectionIds === undefined
      ? 'e.record'
      : 'CASE WHEN e.collection_id = ANY({:collections}::text[]) THEN e.record END';
  const rows = await q
    .newQuery(
      `SELECT
         (SELECT schema_version FROM {{${table('_meta')}}}) AS "schemaVersion",
         (SELECT (s.purged_position, s.purged_seq) > ({:position}::bigint, {:seq}::bigint)
            FROM {{${STATE}}} s) AS lost,
         e.position::text AS position, e.seq::text AS seq,
         e.collection_id AS "collectionId", e.action, e.record_id AS "recordId",
         e.record
       FROM (SELECT 1) "nb_one" LEFT JOIN LATERAL (
         SELECT t.position, e.seq, e.collection_id, e.action, e.record_id, ${record} AS record
         FROM {{${TRANSACTIONS}}} t
         JOIN {{${EVENTS}}} e ON e.transaction_id = t.id
         WHERE t.position >= {:position} AND (t.position > {:position} OR e.seq > {:seq})
         ORDER BY t.position, e.seq
         LIMIT ${limit}
       ) e ON true`,
    )
    .bind({
      position: cursor.position.toString(),
      seq: cursor.seq.toString(),
      ...(collectionIds && { collections: [...collectionIds] }),
    })
    .all<EventRow & Row>();
  const [first] = rows;
  const events: StoredEvent[] = [];
  for (const row of rows) {
    if (row.position === null || row.seq === null) continue;
    events.push({
      cursor: { position: BigInt(row.position), seq: BigInt(row.seq) },
      collectionId: row.collectionId,
      action: row.action,
      recordId: row.recordId,
      record: row.record,
    });
  }
  return {
    events,
    lost: first?.lost === true,
    schemaVersion: Number(first?.schemaVersion),
  };
}

/**
 * Where a new subscriber starts: after the last event committed, and never
 * before what was deleted as too old.
 */
export async function headCursor(q: Builder): Promise<Cursor> {
  const [row] = await q
    .newQuery(
      `SELECT s.purged_position::text AS "purgedPosition", s.purged_seq::text AS "purgedSeq",
              e.position::text AS position, e.seq::text AS seq
       FROM {{${STATE}}} s
       LEFT JOIN LATERAL (
         SELECT t.position, e.seq
         FROM {{${TRANSACTIONS}}} t
         JOIN {{${EVENTS}}} e ON e.transaction_id = t.id
         WHERE t.position IS NOT NULL
         ORDER BY t.position DESC, e.seq DESC
         LIMIT 1
       ) e ON true`,
    )
    .all<{
      purgedPosition: string;
      purgedSeq: string;
      position: string | null;
      seq: string | null;
    }>();
  if (!row) throw new Error('The realtime state is missing.');
  const purged = {
    position: BigInt(row.purgedPosition),
    seq: BigInt(row.purgedSeq),
  };
  if (row.position === null || row.seq === null) return purged;
  const last = { position: BigInt(row.position), seq: BigInt(row.seq) };
  return compareCursors(last, purged) > 0 ? last : purged;
}

/** The position of the last committed transaction, for polling. */
export async function lastPosition(q: Builder): Promise<string | undefined> {
  const [position] = await q
    .newQuery(`SELECT max(position)::text FROM {{${TRANSACTIONS}}}`)
    .column<string | null>();
  return position ?? undefined;
}

/**
 * Deletes events of transactions committed over `seconds` ago and remembers the last one deleted, so
 * readers below it learn they may have missed events. Running transactions get a higher position.
 */
export async function purgeEvents(q: Builder, seconds: number): Promise<void> {
  await q
    .newQuery(
      `WITH "nb_gone" AS (
         DELETE FROM {{${TRANSACTIONS}}}
         WHERE committed < now() - make_interval(secs => {:seconds})
         RETURNING id, position
       ), "nb_events" AS (
         DELETE FROM {{${EVENTS}}}
         WHERE transaction_id IN (SELECT id FROM "nb_gone")
         RETURNING transaction_id, seq
       ), "nb_last" AS (
         SELECT g.position, max(e.seq) AS seq
         FROM "nb_gone" g JOIN "nb_events" e ON e.transaction_id = g.id
         GROUP BY g.position
         ORDER BY g.position DESC
         LIMIT 1
       )
       UPDATE {{${STATE}}} s
       SET purged_position = l.position, purged_seq = l.seq
       FROM "nb_last" l
       WHERE (l.position, l.seq) > (s.purged_position, s.purged_seq)`,
    )
    .bind({ seconds })
    .execute();
}

/** The record of an event, as a select of its collection returns it. */
export function eventRecord(collection: Collection, record: Row): Row {
  return decodeRecordJson(collection, record);
}
