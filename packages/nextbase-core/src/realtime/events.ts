import type { Collection, Field } from "@nextbasejs/client";
import type { Builder, Params, Row } from "@nextbasejs/dbx";
import { table } from "../db/system.ts";
import { decodeRecordJson } from "../db/types.ts";
import { timestampParam } from "../storable.ts";

/** The channel writes notify once they commit events. */
export const CHANNEL = "nextbase_realtime";

export type RealtimeAction = "create" | "update" | "delete";

const EVENTS = table("_realtime_events");
const STATE = table("_realtime_state");

// Postgres takes at most 65535 parameters per statement; each event takes 2.
const PER_STATEMENT = 30_000;

/**
 * A position in the event log, between two events. Events are ordered by the
 * id of the transaction that wrote them, then by their order in it. Both are
 * bigints: an xid8 can exceed JavaScript's safe integers.
 */
export interface Cursor {
  txid: bigint;
  seq: bigint;
}

const MAX_XID8 = 2n ** 64n - 1n;
const MAX_SEQ = 2n ** 63n - 1n;

/** `{txid}.{seq}`, the event id clients send back in `Last-Event-ID`. */
export function formatCursor({ txid, seq }: Cursor): string {
  return `${txid}.${seq}`;
}

/** The cursor of an event id, or undefined when it is not one. */
export function parseCursor(id: string): Cursor | undefined {
  const match = /^(\d{1,20})\.(\d{1,19})$/.exec(id);
  if (!match) return undefined;
  const txid = BigInt(match[1] as string);
  const seq = BigInt(match[2] as string);
  return txid <= MAX_XID8 && seq <= MAX_SEQ ? { txid, seq } : undefined;
}

export function compareCursors(a: Cursor, b: Cursor): number {
  if (a.txid !== b.txid) return a.txid < b.txid ? -1 : 1;
  return a.seq === b.seq ? 0 : a.seq < b.seq ? -1 : 1;
}

/**
 * Logs that `records` were written, in the transaction that wrote them, so
 * an event exists exactly when its write commits. Each statement also
 * notifies listeners; Postgres sends one notification per transaction, once
 * it commits, and none if it rolls back.
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
    // A data-modifying WITH runs whether or not the query reads it.
    await q
      .newQuery(
        `WITH "nb_events" AS (
           INSERT INTO {{${EVENTS}}} (collection_id, action, record_id, record)
           VALUES ${tuples.join(", ")}
         )
         SELECT pg_notify('${CHANNEL}', '')`,
      )
      .bind(params)
      .execute();
  }
}

/**
 * The record as stored, for subscribers' rules and output, without its
 * password hash and token key. Timestamps are kept as Postgres writes them,
 * so `decodeRecordJson` reads them back exactly.
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
    field.type === "password" || (field.system && field.name === "tokenKey")
  );
}

/** An event read from the log. `record` is set for the collections asked for. */
export interface StoredEvent {
  cursor: Cursor;
  collectionId: string;
  action: RealtimeAction;
  recordId: string;
  /** The record as written, stored without its secrets. */
  record: Row | null;
}

export interface EventPage {
  /** At most `limit` events after the cursor, of finished transactions. */
  events: StoredEvent[];
  /** Events after the cursor were deleted unread, as too old to keep. */
  lost: boolean;
  /**
   * Committed events wait behind a transaction still running, which may
   * never notify, so they are read again shortly.
   */
  held: boolean;
  schemaVersion: number;
}

interface EventRow {
  schemaVersion: string;
  lost: boolean;
  held: boolean;
  txid: string | null;
  seq: string | null;
  collectionId: string;
  action: RealtimeAction;
  recordId: string;
  record: Row | null;
}

/**
 * Reads the events after `cursor`, in order, with the records of the
 * collections in `collectionIds`. Only events of transactions that have
 * finished are read: those below the oldest transaction still running.
 * Ordered by transaction id alone, a transaction that started writing
 * earlier but commits later would otherwise add events below a cursor that
 * already passed them. Postgres reads everything in one snapshot, so the
 * horizon and the events agree.
 */
export async function readEvents(
  q: Builder,
  cursor: Cursor,
  collectionIds: readonly string[],
  limit: number,
): Promise<EventPage> {
  const rows = await q
    .newQuery(
      `WITH "nb_h" AS (SELECT pg_snapshot_xmin(pg_current_snapshot()) AS xmin)
       SELECT
         (SELECT schema_version FROM {{${table("_meta")}}}) AS "schemaVersion",
         (SELECT (s.purged_txid, s.purged_seq) > ({:txid}::xid8, {:seq}::bigint)
            FROM {{${STATE}}} s) AS lost,
         EXISTS (SELECT 1 FROM {{${EVENTS}}} WHERE txid >= "nb_h".xmin) AS held,
         e.txid::text AS txid, e.seq::text AS seq,
         e.collection_id AS "collectionId", e.action, e.record_id AS "recordId",
         CASE WHEN e.collection_id = ANY({:collections}::text[]) THEN e.record END AS record
       FROM "nb_h" LEFT JOIN LATERAL (
         SELECT * FROM {{${EVENTS}}}
         WHERE (txid, seq) > ({:txid}::xid8, {:seq}::bigint) AND txid < "nb_h".xmin
         ORDER BY txid, seq
         LIMIT ${limit}
       ) e ON true`,
    )
    .bind({
      txid: cursor.txid.toString(),
      seq: cursor.seq.toString(),
      collections: [...collectionIds],
    })
    .all<EventRow & Row>();
  const [first] = rows;
  const events: StoredEvent[] = [];
  for (const row of rows) {
    if (row.txid === null || row.seq === null) continue;
    events.push({
      cursor: { txid: BigInt(row.txid), seq: BigInt(row.seq) },
      collectionId: row.collectionId,
      action: row.action,
      recordId: row.recordId,
      record: row.record,
    });
  }
  return {
    events,
    lost: first?.lost === true,
    held: first?.held === true,
    schemaVersion: Number(first?.schemaVersion),
  };
}

/**
 * Where a new subscriber starts: after the last event of a finished
 * transaction, and never before what was deleted as too old.
 */
export async function headCursor(q: Builder): Promise<Cursor> {
  const [row] = await q
    .newQuery(
      `SELECT s.purged_txid::text AS "purgedTxid", s.purged_seq::text AS "purgedSeq",
              e.txid::text AS txid, e.seq::text AS seq
       FROM {{${STATE}}} s
       LEFT JOIN LATERAL (
         SELECT txid, seq FROM {{${EVENTS}}}
         WHERE txid < pg_snapshot_xmin(pg_current_snapshot())
         ORDER BY txid DESC, seq DESC
         LIMIT 1
       ) e ON true`,
    )
    .all<{
      purgedTxid: string;
      purgedSeq: string;
      txid: string | null;
      seq: string | null;
    }>();
  if (!row) throw new Error("The realtime state is missing.");
  const purged = { txid: BigInt(row.purgedTxid), seq: BigInt(row.purgedSeq) };
  if (row.txid === null || row.seq === null) return purged;
  const last = { txid: BigInt(row.txid), seq: BigInt(row.seq) };
  return compareCursors(last, purged) > 0 ? last : purged;
}

/** The last event visible to readers, for polling; undefined when none. */
export async function lastEventId(q: Builder): Promise<string | undefined> {
  const [id] = await q
    .newQuery(
      `SELECT txid::text || '.' || seq::text FROM {{${EVENTS}}}
       WHERE txid < pg_snapshot_xmin(pg_current_snapshot())
       ORDER BY txid DESC, seq DESC
       LIMIT 1`,
    )
    .column<string>();
  return id;
}

/**
 * Deletes events older than `seconds`, and remembers the last one deleted.
 * A transaction can commit long after it wrote its events, so an event
 * deleted here may not have been read yet; a reader whose cursor is below
 * the last one deleted is told it may have missed events.
 */
export async function purgeEvents(q: Builder, seconds: number): Promise<void> {
  await q
    .newQuery(
      `WITH "nb_gone" AS (
         DELETE FROM {{${EVENTS}}}
         WHERE created < now() - make_interval(secs => {:seconds})
         RETURNING txid, seq
       ), "nb_last" AS (
         SELECT txid, seq FROM "nb_gone" ORDER BY txid DESC, seq DESC LIMIT 1
       )
       UPDATE {{${STATE}}} s
       SET purged_txid = l.txid, purged_seq = l.seq
       FROM "nb_last" l
       WHERE (l.txid, l.seq) > (s.purged_txid, s.purged_seq)`,
    )
    .bind({ seconds })
    .execute();
}

/** The record of an event, as a select of its collection returns it. */
export function eventRecord(collection: Collection, record: Row): Row {
  return decodeRecordJson(collection, record);
}
