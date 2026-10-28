// Values JavaScript accepts but Postgres rejects, checked up front to give a 400, not a 500.

export function hasNul(value: string): boolean {
  return value.includes("\u0000");
}

// timestamptz starts at 4713 BC; JavaScript dates reach further back, not further forward.
const MIN_TIME = Date.UTC(-4712, 0, 1);

export function isStorableTime(time: number): boolean {
  return Number.isFinite(time) && time >= MIN_TIME;
}

// A date and time with no zone, such as `2026-01-02 03:04:05`.
const NO_ZONE = /^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d(?::\d\d(?:\.\d+)?)?)$/;

/**
 * Parses an ISO 8601 date, like `Date.parse`, but reads a date and time with
 * no zone as UTC. `Date.parse` reads it in the server's local time, so the
 * same input would mean a different moment on each server.
 */
export function parseDate(text: string): number {
  const m = NO_ZONE.exec(text);
  return Date.parse(m ? `${m[1]}T${m[2]}Z` : text);
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

// UTC with Postgres's BC notation: node-postgres's local-time form shifts dates
// whose zone offset had seconds, and Postgres rejects `-004712-...` years.
export function timestampParam(date: Date): string {
  const year = date.getUTCFullYear();
  const bc = year <= 0;
  return (
    `${pad(bc ? 1 - year : year, 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}+00` +
    (bc ? " BC" : "")
  );
}

const TIMESTAMPTZ =
  /^(\d{4,})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(?:\.(\d+))?([+-])(\d\d)(?::(\d\d))?(?::(\d\d))?( BC)?$/;

// Handles offsets with seconds, BC years and years past 9999, which
// node-postgres gets wrong. Undefined for anything else, such as `infinity`.
export function parseTimestamptz(text: string): Date | undefined {
  const m = TIMESTAMPTZ.exec(text);
  if (!m) return undefined;
  const [
    ,
    y,
    mo,
    d,
    h,
    mi,
    s,
    fraction = "",
    sign,
    oh,
    om = "0",
    os = "0",
    bc,
  ] = m as unknown as string[];
  const date = new Date(0);
  date.setUTCFullYear(
    bc ? 1 - Number(y) : Number(y),
    Number(mo) - 1,
    Number(d),
  );
  // One step: an intermediate local time could fall outside JavaScript's range.
  const k = sign === "+" ? -1 : 1;
  date.setUTCHours(
    Number(h) + k * Number(oh),
    Number(mi) + k * Number(om),
    Number(s) + k * Number(os),
    Number(fraction.padEnd(3, "0").slice(0, 3)),
  );
  return Number.isNaN(date.getTime()) ? undefined : date;
}
