import { isIP } from "node:net";

/**
 * Where the client's IP comes from: `"vercel"` for Vercel's own headers, a
 * header your proxy sets, or a function. Never used to decide who is signed
 * in, only for logs and rate limits.
 */
export type ClientIpOption =
  | "vercel"
  | {
      /** A header your proxy appends the client's IP to, such as `x-forwarded-for`. */
      header: string;
      /**
       * Proxies of yours that append to the header after the one that saw
       * the client. Defaults to 0: the rightmost entry is the client.
       */
      trustedHops?: number;
    }
  | ((request: Request) => string | undefined);

/** The client's IP of a request, or undefined when unknown. */
export type ClientIp = (request: Request) => string | undefined;

const UNKNOWN: ClientIp = () => undefined;

/**
 * Reads `clientIp`. Without it, Vercel's headers are used on Vercel, and
 * elsewhere the IP is unknown: no header can be trusted unless a proxy of
 * yours sets it.
 */
export function clientIpReader(
  option: ClientIpOption | undefined,
  onVercel: boolean = process.env.VERCEL !== undefined &&
    process.env.VERCEL !== "",
): ClientIp {
  const config = option ?? (onVercel ? "vercel" : undefined);
  if (config === undefined) return UNKNOWN;
  if (config === "vercel") {
    // Vercel sets both itself, replacing what the client sent.
    return (request) =>
      fromHeader(request, "x-vercel-forwarded-for", 0) ??
      fromHeader(request, "x-real-ip", 0);
  }
  if (typeof config === "function") {
    return (request) => {
      try {
        const ip = config(request);
        return typeof ip === "string" ? normalizeIp(ip.trim()) : undefined;
      } catch (error) {
        console.error("[nextbase] clientIp failed:", error);
        return undefined;
      }
    };
  }
  if (config === null || typeof config !== "object") {
    throw new TypeError(
      'clientIp must be "vercel", { header, trustedHops } or a function.',
    );
  }
  const { header, trustedHops = 0 } = config;
  if (
    typeof header !== "string" ||
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header)
  ) {
    throw new TypeError("clientIp.header must be a header name.");
  }
  if (!Number.isSafeInteger(trustedHops) || trustedHops < 0) {
    throw new RangeError("clientIp.trustedHops must be a whole number, or 0.");
  }
  const name = header.toLowerCase();
  return (request) => fromHeader(request, name, trustedHops);
}

/**
 * The entry `hops` from the right of a list header, all of its lines merged.
 * Proxies append, so entries further left were written by the client and
 * prove nothing.
 */
function fromHeader(
  request: Request,
  name: string,
  hops: number,
): string | undefined {
  // Fetch joins repeated lines with ", ", in order.
  const value = request.headers.get(name);
  if (value === null) return undefined;
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const entry = entries[entries.length - 1 - hops];
  return entry === undefined ? undefined : normalizeIp(entry);
}

// `[2001:db8::1]` or `[2001:db8::1]:443`, and `203.0.113.9:5678`.
const BRACKETED = /^\[([^\]]+)\](?::(\d{1,5}))?$/;
const V4_WITH_PORT = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/;
const MAX_PORT = 65_535;
// The canonical form of an IPv4-mapped IPv6 address, in hex.
const MAPPED_V4 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/**
 * A valid IP, or undefined: without a port or zone id, IPv6 compressed and
 * lowercase, and an IPv4-mapped IPv6 address as plain IPv4, so one client
 * always reads the same. Brackets are only allowed around IPv6, a zone id
 * only after IPv6, and a port only from 0 to 65535.
 */
function normalizeIp(value: string): string | undefined {
  const bracketed = BRACKETED.exec(value);
  const withPort = bracketed ?? V4_WITH_PORT.exec(value);
  const port = withPort?.[2];
  if (port !== undefined && Number(port) > MAX_PORT) return undefined;
  let ip = withPort?.[1] ?? value;
  const zone = ip.indexOf("%");
  if (zone !== -1) {
    if (zone === ip.length - 1) return undefined;
    ip = ip.slice(0, zone);
    if (isIP(ip) !== 6) return undefined;
  }
  const version = isIP(ip);
  if (version === 4 && !bracketed) return ip;
  if (version !== 6) return undefined;
  // The URL parser writes IPv6 in its canonical form, RFC 5952.
  const canonical = new URL(`http://[${ip}]`).hostname.slice(1, -1);
  const mapped = MAPPED_V4.exec(canonical);
  if (!mapped) return canonical;
  const high = Number.parseInt(mapped[1] as string, 16);
  const low = Number.parseInt(mapped[2] as string, 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}
