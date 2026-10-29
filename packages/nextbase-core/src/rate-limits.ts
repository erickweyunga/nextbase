import { BlockList, isIP } from 'node:net';
import type { DB } from '@nextbasejs/dbx';
import type { Principal } from './auth/principal.ts';
import { table } from './db/system.ts';
import { ApiError } from './errors.ts';
import type { Logger } from './logs/logger.ts';

/** What a route does, for rate limit labels such as `*:auth`. */
export type RouteTag =
  | 'auth'
  | 'create'
  | 'list'
  | 'view'
  | 'update'
  | 'delete'
  | 'batch'
  | 'realtime'
  | 'file';

const TAGS: ReadonlySet<string> = new Set<RouteTag>([
  'auth',
  'create',
  'list',
  'view',
  'update',
  'delete',
  'batch',
  'realtime',
  'file',
]);

export interface RateLimitRule {
  /**
   * What the rule limits: a route tag of one collection or of all
   * (`users:auth`, `*:create`), a method and exact path (`POST /batch`), an
   * exact path (`/files/token`), or a path prefix ending with a slash
   * (`/collections/`). Paths are below `basePath`.
   */
  label: string;
  /** Only guests, or only signed-in callers. Defaults to both. */
  audience?: 'guest' | 'auth';
  /** Requests allowed per window. */
  max: number;
  /** Seconds, counted from the first request of the window. */
  window: number;
}

export interface RateLimitsOptions {
  /** Replaces the default rules. */
  rules?: RateLimitRule[];
  /** IPs or CIDR ranges, such as `10.0.0.0/8`, that are never limited. */
  excludedIps?: string[];
}

const DEFAULT_RULES: readonly RateLimitRule[] = [
  { label: '*:auth', max: 2, window: 3 },
  { label: '*:create', max: 20, window: 5 },
  { label: 'POST /batch', max: 3, window: 1 },
  { label: '/', max: 300, window: 10 },
];

const METHODS: ReadonlySet<string> = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

// Collection names, including system ones such as `_superusers`.
const TAG_LABEL = /^(\*|_?[A-Za-z][A-Za-z0-9_]{0,62}):([a-z]+)$/;
const METHOD_LABEL = /^([A-Z]+) (\/.*)$/;
const MAX_LABEL = 200;

/**
 * About one counted request in `pruneEvery` deletes expired counts, in the
 * background. Tests change it; apps have no reason to.
 */
export const rateLimitTimings = { pruneEvery: 100 };
// Expired counts each delete removes at most, so none holds locks for long.
const PRUNE_BATCH = 1000;

const RATE_LIMITS = table('_rate_limits');

/** The rules of one label: one per audience. */
interface Slot {
  guest?: RateLimitRule;
  auth?: RateLimitRule;
  any?: RateLimitRule;
}

/** What a request is limited by. */
export interface Limited {
  /** The method, with HEAD as GET. */
  method: string;
  /** The path below `basePath`. */
  route: string;
  tags: readonly RouteTag[];
  /** The name of the collection the route is about, if any. */
  collection: string | undefined;
  principal: Principal;
  ip: string | undefined;
}

/**
 * Limits requests per caller with fixed windows counted in Postgres, so
 * limits hold across serverless instances. Signed-in callers are counted
 * per record, guests per IP, which needs `clientIp`: guests whose IP is
 * unknown are not limited.
 */
export class RateLimits {
  readonly #tags = new Map<string, Slot>();
  readonly #paths = new Map<string, Slot>();
  /** Longest first. */
  readonly #prefixes: { prefix: string; slot: Slot }[] = [];
  readonly #excluded = new BlockList();
  readonly #logger: Logger;
  readonly #waitUntil: (promise: Promise<unknown>) => void;
  #warnedNoIp = false;
  /** Whether any rule names a collection, so requests must look theirs up. */
  readonly byCollection: boolean;

  constructor(
    options: RateLimitsOptions,
    {
      logger,
      waitUntil,
    }: {
      logger: Logger;
      waitUntil: (promise: Promise<unknown>) => void;
    },
  ) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('rateLimits must be false or an object.');
    }
    const { rules = DEFAULT_RULES, excludedIps = [] } = options;
    if (!Array.isArray(rules)) {
      throw new TypeError('rateLimits.rules must be a list of rules.');
    }
    if (!Array.isArray(excludedIps)) {
      throw new TypeError('rateLimits.excludedIps must be a list of IPs.');
    }
    this.#logger = logger;
    this.#waitUntil = waitUntil;
    const prefixes = new Map<string, Slot>();
    let byCollection = false;
    for (const rule of rules) {
      const checked = checkRule(rule);
      const { label } = checked;
      const tag = TAG_LABEL.exec(label);
      let slots: Map<string, Slot>;
      let key: string;
      if (tag) {
        // Collection names are unique regardless of case.
        key = `${(tag[1] as string).toLowerCase()}:${tag[2]}`;
        slots = this.#tags;
        if (tag[1] !== '*') byCollection = true;
      } else if (label.endsWith('/')) {
        key = label;
        slots = prefixes;
      } else {
        key = label;
        slots = this.#paths;
      }
      const slot = slots.get(key) ?? {};
      const audience = checked.audience ?? 'any';
      if (slot[audience]) {
        throw new TypeError(
          `rateLimits.rules has two rules for ${JSON.stringify(label)}${checked.audience ? ` and audience "${checked.audience}"` : ''}.`,
        );
      }
      slot[audience] = checked;
      slots.set(key, slot);
    }
    this.byCollection = byCollection;
    this.#prefixes = [...prefixes]
      .map(([prefix, slot]) => ({ prefix, slot }))
      .sort((a, b) => b.prefix.length - a.prefix.length);
    for (const entry of excludedIps) excludeIp(this.#excluded, entry);
  }

  /**
   * Counts the request against the first rule that matches it, in one
   * autocommit upsert, and refuses it with a 429 when it is over. Run it
   * outside any transaction, so refused requests stay counted.
   */
  async check(db: DB, request: Limited): Promise<void> {
    const { principal, ip } = request;
    if (principal.superuser) return;
    if (ip !== undefined && this.#excluded.check(ip, family(ip))) return;
    const { collection, record } = principal;
    const signedIn = collection !== undefined && record !== undefined;
    const rule = this.#find(request, signedIn ? 'auth' : 'guest');
    if (!rule) return;
    let caller: string;
    if (signedIn) {
      caller = `rec:${collection.id}:${String(record.id)}`;
    } else if (ip === undefined) {
      this.#warnNoIp();
      return;
    } else {
      caller = `ip:${ipKey(ip)}`;
    }
    const key = `${rule.label}|${rule.audience ?? ''}|${caller}`;
    const { hits, resetIn } = await db
      .newQuery(
        `INSERT INTO {{${RATE_LIMITS}}} AS r (key, hits, window_end)
         VALUES ({:key}, 1, now() + make_interval(secs => {:window}))
         ON CONFLICT (key) DO UPDATE SET
           hits = CASE WHEN r.window_end <= now() THEN 1 ELSE least(r.hits + 1, {:over}) END,
           window_end = CASE WHEN r.window_end <= now() THEN now() + make_interval(secs => {:window}) ELSE r.window_end END
         RETURNING hits, ceil(extract(epoch FROM window_end - now()))::int AS "resetIn"`,
      )
      .bind({ key, window: rule.window, over: rule.max + 1 })
      .one<{ hits: number; resetIn: number }>();
    if (Math.random() * rateLimitTimings.pruneEvery < 1) this.#prune(db);
    if (hits <= rule.max) return;
    const seconds = String(Math.max(1, resetIn));
    // Labels hold no quotes or backslashes, so each is a valid quoted string.
    const name = `"${rule.label}"`;
    throw new ApiError(
      429,
      'Too many requests.',
      {},
      {
        'retry-after': seconds,
        'ratelimit-policy': `${name};q=${rule.max};w=${rule.window}`,
        ratelimit: `${name};r=0;t=${seconds}`,
      },
    );
  }

  /**
   * The first rule that applies: the route's tags for its collection, then
   * for all collections, then the method and path, the path, and the
   * longest prefix. For each label, a rule for the caller's audience comes
   * before one for both.
   */
  #find(
    { method, route, tags, collection }: Limited,
    audience: 'guest' | 'auth',
  ): RateLimitRule | undefined {
    const pick = (slot: Slot | undefined): RateLimitRule | undefined =>
      slot && (slot[audience] ?? slot.any);
    for (const tag of tags) {
      const rule =
        (collection !== undefined &&
          pick(this.#tags.get(`${collection.toLowerCase()}:${tag}`))) ||
        pick(this.#tags.get(`*:${tag}`));
      if (rule) return rule;
    }
    const rule =
      pick(this.#paths.get(`${method} ${route}`)) ??
      pick(this.#paths.get(route));
    if (rule) return rule;
    for (const { prefix, slot } of this.#prefixes) {
      if (!route.startsWith(prefix)) continue;
      const rule = pick(slot);
      if (rule) return rule;
    }
    return undefined;
  }

  #warnNoIp(): void {
    if (this.#warnedNoIp) return;
    this.#warnedNoIp = true;
    console.warn(
      "[nextbase] Guests are not rate limited: their IP is unknown. Set the clientIp option to the header your proxy sets, or to 'vercel'.",
    );
  }

  // In the background, skipping rows another delete or upsert holds, so it
  // never waits on a lock and no request waits on it for long.
  #prune(db: DB): void {
    this.#waitUntil(
      db
        .newQuery(
          `DELETE FROM {{${RATE_LIMITS}}} WHERE key IN (
             SELECT key FROM {{${RATE_LIMITS}}}
             WHERE window_end <= now()
             ORDER BY window_end
             LIMIT ${PRUNE_BATCH}
             FOR UPDATE SKIP LOCKED
           )`,
        )
        .execute()
        .catch((error: unknown) => {
          this.#logger.failure(
            'rateLimits',
            'deleting expired rate limit counts failed',
            error,
          );
        }),
    );
  }
}

function checkRule(rule: RateLimitRule): RateLimitRule {
  if (rule === null || typeof rule !== 'object') {
    throw new TypeError('Each of rateLimits.rules must be an object.');
  }
  const { label, audience, max, window } = rule;
  const name = JSON.stringify(label);
  if (typeof label !== 'string' || !validLabel(label)) {
    throw new TypeError(
      `rateLimits.rules has an invalid label ${name}. Use a route tag ("users:auth", "*:create"), "METHOD /path", "/path" or "/prefix/".`,
    );
  }
  if (audience !== undefined && audience !== 'guest' && audience !== 'auth') {
    throw new TypeError(
      `The audience of rate limit ${name} must be "guest" or "auth".`,
    );
  }
  for (const [key, value] of [
    ['max', max],
    ['window', window],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(
        `The ${key} of rate limit ${name} must be a whole number, at least 1.`,
      );
    }
  }
  return { label, ...(audience !== undefined && { audience }), max, window };
}

function validLabel(label: string): boolean {
  if (label.length === 0 || label.length > MAX_LABEL) return false;
  const tag = TAG_LABEL.exec(label);
  if (tag) return TAGS.has(tag[2] as string);
  const method = METHOD_LABEL.exec(label);
  if (method) {
    const path = method[2] as string;
    // A method takes an exact path, not a prefix.
    return (
      METHODS.has(method[1] as string) &&
      !path.endsWith('/') &&
      canonicalPath(path)
    );
  }
  return canonicalPath(label);
}

/** An absolute path as a request's URL would have it, with no query. */
function canonicalPath(path: string): boolean {
  if (!path.startsWith('/') || /[\s?#"\\]/.test(path)) return false;
  return new URL(path, 'http://rate.invalid').pathname === path;
}

function excludeIp(list: BlockList, entry: string): void {
  const invalid = (): TypeError =>
    new TypeError(
      `rateLimits.excludedIps has ${JSON.stringify(entry)}, which is not an IP or a CIDR range such as "10.0.0.0/8".`,
    );
  if (typeof entry !== 'string') throw invalid();
  const [address = '', prefix, ...rest] = entry.split('/');
  const version = isIP(address);
  if (version === 0 || rest.length > 0) throw invalid();
  const type = version === 6 ? 'ipv6' : 'ipv4';
  if (prefix === undefined) {
    list.addAddress(address, type);
    return;
  }
  const bits = Number(prefix);
  if (!/^\d{1,3}$/.test(prefix) || bits > (version === 6 ? 128 : 32)) {
    throw invalid();
  }
  list.addSubnet(address, bits, type);
}

function family(ip: string): 'ipv4' | 'ipv6' {
  return isIP(ip) === 6 ? 'ipv6' : 'ipv4';
}

/**
 * A guest's IP as counted: IPv6 by its /64, the block one subscriber is
 * usually given, so changing the rest of the address does not reset the
 * count. The IP is as `clientIp` reads it, so IPv6 is compressed.
 */
function ipKey(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const [head = '', tail] = ip.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups =
    tail === undefined
      ? left
      : [
          ...left,
          ...Array<string>(8 - left.length - right.length).fill('0'),
          ...right,
        ];
  return `${groups.slice(0, 4).join(':')}::/64`;
}
