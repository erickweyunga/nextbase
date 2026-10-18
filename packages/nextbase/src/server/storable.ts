// Values JavaScript accepts but Postgres rejects. Checking them up front turns
// what would be a database error (a 500) into a validation error (a 400).

/** Postgres text and jsonb cannot hold NUL characters. */
export function hasNul(value: string): boolean {
  return value.includes("\u0000");
}

// timestamptz starts at 4713 BC (proleptic year -4712); JavaScript dates reach
// further back. JavaScript's latest date is within Postgres's range.
const MIN_TIME = Date.UTC(-4712, 0, 1);

/** Whether a JavaScript time, in milliseconds, is storable as timestamptz. */
export function isStorableTime(time: number): boolean {
  return Number.isFinite(time) && time >= MIN_TIME;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/**
 * A timestamptz parameter, written in UTC with Postgres's own BC notation.
 * node-postgres would send a Date in the process's local time with a
 * whole-minute offset, shifting historical dates whose zone offset had seconds,
 * and Postgres rejects JavaScript's `-004712-...` year form.
 */
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

/**
 * Parses timestamptz output (ISO DateStyle), including offsets with seconds,
 * BC years and years past 9999, which node-postgres's parser gets wrong.
 * Returns undefined for anything else, such as `infinity`.
 */
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
  // The offset goes into the same call, so the result is computed in one
  // step: an intermediate local time could fall outside JavaScript's range.
  const k = sign === "+" ? -1 : 1;
  date.setUTCHours(
    Number(h) + k * Number(oh),
    Number(mi) + k * Number(om),
    Number(s) + k * Number(os),
    Number(fraction.padEnd(3, "0").slice(0, 3)),
  );
  return Number.isNaN(date.getTime()) ? undefined : date;
}
