// Values JavaScript accepts but Postgres rejects, checked up front to give a 400, not a 500.

export function hasNul(value: string): boolean {
  return value.includes("\u0000");
}

/**
 * Why Postgres cannot store `value` as sent, if it cannot. Besides NULs, that
 * is a lone UTF-16 surrogate, which has no UTF-8 encoding: text would be
 * stored with U+FFFD in its place, and jsonb rejects it.
 */
export function unstorableText(value: string): string | undefined {
  if (hasNul(value)) return "Cannot contain NUL characters.";
  if (!value.isWellFormed()) return "Cannot contain unpaired surrogates.";
  return undefined;
}

// timestamptz starts at 4713 BC; JavaScript dates reach further back, not further forward.
const MIN_TIME = Date.UTC(-4712, 0, 1);

export function isStorableTime(time: number): boolean {
  return Number.isFinite(time) && time >= MIN_TIME;
}

// An ISO 8601 date, with an optional time and zone. The time may follow a
// space instead of `T`, as Postgres writes it, and the zone may be `+0300` or
// `+03` as well as `+03:00`.
const ISO_8601 =
  /^([+-]\d{6}|\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d:\d\d(?::\d\d(?:\.\d+)?)?)(Z|[+-]\d\d(?::?\d\d)?)?)?$/i;

/**
 * Parses an ISO 8601 date, and NaN for anything else. A date and time with no
 * zone is read as UTC. `Date.parse` would read it, and the other formats it
 * guesses at, such as `1/2/2024`, in the server's local time, so the same
 * input would mean a different moment on each server.
 */
export function parseDate(text: string): number {
  const m = ISO_8601.exec(text);
  if (!m) return Number.NaN;
  const [, year, month, day, time = "00:00", zone = "Z"] = m;
  let offset = zone.toUpperCase();
  if (offset !== "Z") {
    const digits = offset.slice(1).replace(":", "");
    offset = `${offset[0]}${digits.slice(0, 2)}:${digits.slice(2) || "00"}`;
  }
  return Date.parse(`${year}-${month}-${day}T${time}${offset}`);
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
