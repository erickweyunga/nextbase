/**
 * How often realtime does its periodic work, in milliseconds. Tests shorten
 * them; apps have no reason to.
 */
export const timings = {
  /** How often to look for new events when notifications cannot be heard. */
  pollMs: 1_000,
  /** The first wait before listening again after the connection failed. */
  reconnectMs: 500,
  /** The longest wait between attempts to listen again. */
  maxReconnectMs: 30_000,
  /** How often an idle stream sends a comment, so proxies keep it open. */
  heartbeatMs: 25_000,
  /** How often a stream checks that its session still exists. */
  sessionMs: 30_000,
  /** How long events are kept for subscribers that reconnect. */
  retentionMs: 600_000,
  /** How often each instance deletes events older than that. */
  purgeMs: 60_000,
};
