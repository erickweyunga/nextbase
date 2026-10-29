import { BlockList, isIP } from 'node:net';
import type { Collection } from '@nextbasejs/client';
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

// Keys refused until their window ends, kept per instance, so repeated
// requests over a limit are answered without the database.
const MAX_REFUSED = 10_000;

const RATE_LIMITS = table('_rate_limits');

/** The rules of one label: one per audience. */
interface Slot {
  guest?: RateLimitRule;
  auth?: RateLimitRule;
  any?: RateLimitRule;
}

/** What a request, or a write in a batch, is limited by. */
export interface Limited {
  /** The method, with HEAD as GET. */
  method: string;
  /** The path below `basePath`. */
  route: string;
  tags: readonly RouteTag[];
  /** The collection the route is about, if any. */
  collection: Collection | undefined;
}

/** Who sends the requests being counted. */
export interface Caller {
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
  /** Keys over their limit, with when their window ends, in ms. */
  readonly #refused = new Map<string, number>();
  /** Whether any rule names a collection. */
  readonly #byCollection: boolean;

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
    this.#byCollection = byCollection;
    this.#prefixes = [...prefixes]
      .map(([prefix, slot]) => ({ prefix, slot }))
      .sort((a, b) => b.prefix.length - a.prefix.length);
    for (const entry of excludedIps) excludeIp(this.#excluded, entry);
  }

  /**
   * Whether requests with these tags must say their collection: when a rule
   * names one, or a create could be a sign-up.
   */
  needsCollection(tags: readonly RouteTag[]): boolean {
    if (tags.length === 0) return false;
    return this.#byCollection || tags.includes('create');
  }

  /**
   * Counts each request against the first rule that matches it, in one
   * autocommit upsert, and refuses them all with a 429 when any is over.
   * Run it outside any transaction, so refused requests stay counted.
   */
  async check(
    db: DB,
    { principal, ip }: Caller,
    requests: readonly Limited[],
  ): Promise<void> {
    if (principal.superuser) return;
    if (ip !== undefined && this.#excluded.check(ip, family(ip))) return;
    const { collection, record } = principal;
    const signedIn = collection !== undefined && record !== undefined;
    let caller: string | undefined;
    if (signedIn) {
      caller = `rec:${collection.id}:${String(record.id)}`;
    } else if (ip !== undefined) {
      caller = `ip:${ipKey(ip)}`;
    }
    // Requests that count against one rule add up on its key.
    const counted = new Map<string, { rule: RateLimitRule; hits: number }>();
    for (const request of requests) {
      const rule = this.#find(request, signedIn ? 'auth' : 'guest');
      if (!rule) continue;
      if (caller === undefined) {
        this.#warnNoIp();
        return;
      }
      const key = `${rule.label}|${rule.audience ?? ''}|${caller}`;
      const count = counted.get(key) ?? { rule, hits: 0 };
      count.hits++;
      counted.set(key, count);
    }
    if (counted.size === 0) return;
    const now = Date.now();
    for (const [key, { rule }] of counted) {
      const until = this.#refused.get(key);
      if (until === undefined) continue;
      if (until > now) throw tooMany(rule, until - now);
      this.#refused.delete(key);
    }
    const keys = [...counted.keys()];
    const counts = [...counted.values()];
    // A key over its limit is not written again until its window ends, so
    // refusals add no dead rows and hold no row lock. For a key left as
    // it was, the outer query reads when its window ends, as it was
    // before the statement.
    const rows = await db
      .newQuery(
        `WITH counted AS (
           INSERT INTO {{${RATE_LIMITS}}} AS r (key, hits, window_end)
           SELECT key, hits, now() + make_interval(secs => window_seconds)
           FROM unnest({:keys}::text[], {:hits}::int[], {:windows}::int[])
             AS c(key, hits, window_seconds)
           ON CONFLICT (key) DO UPDATE SET
             hits = CASE WHEN r.window_end <= now() THEN excluded.hits ELSE r.hits + excluded.hits END,
             window_end = CASE WHEN r.window_end <= now() THEN excluded.window_end ELSE r.window_end END
           WHERE r.window_end <= now()
             OR r.hits <= ({:maxes}::int[])[array_position({:keys}::text[], r.key)]
           RETURNING key, hits, window_end
         )
         SELECT c.key, counted.hits,
           extract(epoch FROM coalesce(counted.window_end, r.window_end) - now()) * 1000 AS "resetMs"
         FROM unnest({:keys}::text[]) AS c(key)
         LEFT JOIN counted ON counted.key = c.key
         LEFT JOIN {{${RATE_LIMITS}}} AS r ON counted.key IS NULL AND r.key = c.key`,
      )
      .bind({
        keys,
        hits: counts.map((c) => c.hits),
        windows: counts.map((c) => c.rule.window),
        maxes: counts.map((c) => c.rule.max),
      })
      .all<{ key: string; hits: number | null; resetMs: number | null }>();
    if (Math.random() * rateLimitTimings.pruneEvery < 1) this.#prune(db);
    const results = new Map(rows.map((row) => [row.key, row]));
    let refusal: ApiError | undefined;
    for (const [key, { rule }] of counted) {
      const row = results.get(key);
      if (row?.hits != null && row.hits <= rule.max) continue;
      // Null when another instance created the row as this one counted.
      const resetMs = Number(row?.resetMs ?? rule.window * 1000);
      this.#refuse(key, Date.now() + resetMs);
      refusal ??= tooMany(rule, resetMs);
    }
    if (refusal) throw refusal;
  }

  #refuse(key: string, until: number): void {
    if (this.#refused.size >= MAX_REFUSED) {
      const now = Date.now();
      for (const [old, end] of this.#refused) {
        if (end <= now) this.#refused.delete(old);
      }
      // Still full: the oldest go first.
      for (const old of this.#refused.keys()) {
        if (this.#refused.size < MAX_REFUSED) break;
        this.#refused.delete(old);
      }
    }
    this.#refused.set(key, until);
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
    const name = collection?.name.toLowerCase();
    for (const routeTag of tags) {
      // Creating an auth record signs up, as `/sign-up` does.
      const tag =
        routeTag === 'create' && collection?.type === 'auth'
          ? 'auth'
          : routeTag;
      const rule =
        (name !== undefined && pick(this.#tags.get(`${name}:${tag}`))) ||
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
  if (typeof label === 'string') {
    const path = METHOD_LABEL.exec(label)?.[2] ?? label;
    if (BELOW_COLLECTION.test(path)) {
      throw new TypeError(
        `rateLimits.rules has the label ${name}, a path below one collection, which requests can also name by its id. Use a tag label such as "posts:list" or "posts:create".`,
      );
    }
  }
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

// A path below one collection, which a request can also name by its id or
// with escapes, so only a tag label limits it reliably.
const BELOW_COLLECTION = /^\/(?:collections|files)\/[^/]+\//;

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
 * A guest's IP as counted: IPv6 by its /56, as ISPs commonly give one
 * subscriber a /56 or a /48, so changing the rest of the address does not
 * reset the count. The IP is as `clientIp` reads it, so IPv6 is compressed.
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
  // 56 bits: three groups, and the high byte of the fourth.
  const fourth = (Number(`0x${groups[3] ?? '0'}`) & 0xff00).toString(16);
  return `${[...groups.slice(0, 3), fourth].join(':')}::/56`;
}

/** The 429 of a rule, its window ending in `resetMs`. */
function tooMany(rule: RateLimitRule, resetMs: number): ApiError {
  const seconds = String(Math.max(1, Math.ceil(resetMs / 1000)));
  // Labels hold no quotes or backslashes, so each is a valid quoted string.
  const name = `"${rule.label}"`;
  return new ApiError(
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
