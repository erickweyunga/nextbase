import type {
  AuthCollection,
  Collection,
  NextBaseClient,
  RecordModel,
  TokenConfig,
  TokenType,
} from '@nextbasejs/client';
import type { Row, Tx } from '@nextbasejs/dbx';
import type { Principal } from '../auth/principal.ts';
import type { Effects } from '../effects.ts';
import type { Logger } from '../logs/logger.ts';
import { writeEvents } from '../realtime/events.ts';
import type { Schema } from '../schema/cache.ts';
import { serverRecord } from './serialize.ts';

/**
 * What made a write: `request` for the records API, from HTTP, `client()` or
 * a batch; `system` for NextBase's own writes, such as a sign-up through
 * OAuth2 or a phone code, or a verified email; `cascade` for records deleted
 * by a cascading relation, or changed because a deleted record was taken out
 * of their relation.
 */
export type HookSource = 'request' | 'system' | 'cascade';

/** An auth collection as hooks see it: without its token secrets. */
export type HookAuthCollection = Omit<AuthCollection, 'tokens'> & {
  tokens: Record<TokenType, Omit<TokenConfig, 'secret'>>;
};

/**
 * A collection as hooks see it, frozen: changing it would change the
 * collection for every request. Auth collections leave out their token
 * secrets.
 */
export type HookCollection =
  | Exclude<Collection, AuthCollection>
  | HookAuthCollection;

/** Who a write is made for. */
export interface HookPrincipal {
  /** Superusers, `client({ superuser: true })` and NextBase's own writes. */
  superuser: boolean;
  /** The collection of the signed-in record, if any. */
  collection?: HookAuthCollection;
  /** The signed-in record, as hooks see records. */
  record?: RecordModel;
  /** The id of the superuser acting as `record`, on an impersonation session. */
  impersonatedBy?: string;
}

/** The request of a write, as rules see it. */
export interface HookRequest {
  method: string;
  query: Record<string, string>;
  /**
   * Lowercased header names. `authorization` and `cookie` are left out:
   * they carry the caller's session.
   */
  headers: Record<string, string>;
}

interface HookEvent {
  collection: HookCollection;
  principal: HookPrincipal;
}

/** A create about to be checked. */
export interface BeforeCreateEvent<T extends RecordModel = RecordModel>
  extends HookEvent {
  /** The body to create the record from; changes are checked as if sent. */
  input: Partial<T> & Record<string, unknown>;
  request: HookRequest;
  source: 'request' | 'system';
}

/** An update about to be checked. */
export interface BeforeUpdateEvent<T extends RecordModel = RecordModel>
  extends HookEvent {
  /** The body to update the record with; changes are checked as if sent. */
  input: Partial<T> & Record<string, unknown>;
  /** The record as stored, read without a lock. */
  record: T;
  request: HookRequest;
  source: 'request' | 'system';
}

/** A delete about to be checked. */
export interface BeforeDeleteEvent<T extends RecordModel = RecordModel>
  extends HookEvent {
  /** The record as stored, read without a lock. */
  record: T;
  request: HookRequest;
  source: 'request' | 'system';
}

/** A record written: created, or deleted. */
export interface RecordEvent<
  T extends RecordModel = RecordModel,
  C extends Record<string, RecordModel> = Record<string, RecordModel>,
> extends HookEvent {
  /** The record as the write left it. */
  record: T;
  source: HookSource;
  /**
   * A superuser client. In on hooks its requests join the write's
   * transaction, so what they write is kept or undone with it; await them.
   */
  nextbase: NextBaseClient<C>;
}

/** A record updated. */
export interface UpdateEvent<
  T extends RecordModel = RecordModel,
  C extends Record<string, RecordModel> = Record<string, RecordModel>,
> extends RecordEvent<T, C> {
  /** The record as it was before the update. */
  original: T;
}

type Hook<E> = (event: E) => void | Promise<void>;

/** The hooks of one collection. Each may be async. */
export interface CollectionHooks<
  T extends RecordModel = RecordModel,
  C extends Record<string, RecordModel> = Record<string, RecordModel>,
> {
  /** Before the create is checked, outside its transaction. */
  beforeCreate?: Hook<BeforeCreateEvent<T>>;
  /** Before the update is checked, outside its transaction. */
  beforeUpdate?: Hook<BeforeUpdateEvent<T>>;
  /** Before the delete is checked, outside its transaction. */
  beforeDelete?: Hook<BeforeDeleteEvent<T>>;
  /** In the create's transaction, once the record is inserted. */
  onCreate?: Hook<RecordEvent<T, C>>;
  /** In the update's transaction, once the record is changed. */
  onUpdate?: Hook<UpdateEvent<T, C>>;
  /** In the delete's transaction, once the record is deleted. */
  onDelete?: Hook<RecordEvent<T, C>>;
  /** In the background, once the create is committed. */
  afterCreate?: Hook<RecordEvent<T, C>>;
  /** In the background, once the update is committed. */
  afterUpdate?: Hook<UpdateEvent<T, C>>;
  /** In the background, once the delete is committed. */
  afterDelete?: Hook<RecordEvent<T, C>>;
}

/**
 * Hooks by collection name. Those under `"*"` run for every collection,
 * after the collection's own.
 */
export type RecordHooks<
  C extends Record<string, RecordModel> = Record<string, RecordModel>,
> = { [N in keyof C & string]?: CollectionHooks<C[N], C> } & {
  '*'?: CollectionHooks<RecordModel, C>;
};

type Action = 'create' | 'update' | 'delete';
type Stage = 'before' | 'on' | 'after';
type HookName = `${Stage}${Capitalize<Action>}`;

const HOOK_NAMES: readonly HookName[] = [
  'beforeCreate',
  'beforeUpdate',
  'beforeDelete',
  'onCreate',
  'onUpdate',
  'onDelete',
  'afterCreate',
  'afterUpdate',
  'afterDelete',
];

const SUPERUSERS = '_superusers';

/** The write a hook runs for, and the request it belongs to. */
export interface HookScope {
  schema: Schema;
  principal: Principal;
  source: HookSource;
  /** The on hooks whose writes, through `e.nextbase`, led to this write. */
  chain: readonly string[];
  /** Where after hooks wait for the commit. */
  effects: Effects | undefined;
}

/** What a client whose requests join an on hook's transaction needs. */
export interface Join {
  tx: Tx;
  schema: Schema;
  /** The effects of the write the hook runs for. */
  effects: Effects;
  chain: readonly string[];
}

export interface JoinedClient {
  client: NextBaseClient<Record<string, RecordModel>>;
  /**
   * Refuses further requests and waits for those still running; true if
   * there were any.
   */
  close(): Promise<boolean>;
}

/** The superuser clients hooks get, from NextBase. */
export interface HookClients {
  /** For after hooks: requests that carry the hooks that led to them. */
  chained(
    chain: readonly string[],
  ): NextBaseClient<Record<string, RecordModel>>;
  joined(join: Join): JoinedClient;
}

/** Which collections send realtime events, from NextBase. */
export interface RealtimeWrites {
  sends(collection: Collection): boolean;
  /** Called once a write logged events, in its transaction. */
  logged(): void;
}

/** A record a write changed, and what it was before an update. */
export interface WrittenRecord {
  record: Row;
  original?: Row;
}

type AnyHook = (event: Record<string, unknown>) => void | Promise<void>;

/**
 * The app's record hooks, checked once when NextBase is created, and the
 * realtime events of written records, which follow the same writes.
 */
export class Hooks {
  readonly #hooks = new Map<string, Partial<Record<HookName, AnyHook>>>();
  readonly #clients: HookClients;
  readonly #realtime: RealtimeWrites | undefined;
  readonly #logger: Logger;

  constructor(
    hooks: RecordHooks | undefined,
    clients: HookClients,
    logger: Logger,
    realtime?: RealtimeWrites,
  ) {
    this.#clients = clients;
    this.#logger = logger;
    this.#realtime = realtime;
    for (const [name, set] of Object.entries(hooks ?? {})) {
      if (set === undefined) continue;
      if (name === SUPERUSERS) {
        throw new TypeError(
          'Hooks cannot be set on _superusers: setup and createSuperuser() write its records outside the records API.',
        );
      }
      if (set === null || typeof set !== 'object' || Array.isArray(set)) {
        throw new TypeError(`hooks.${name} must be an object of hooks.`);
      }
      for (const [hook, run] of Object.entries(set)) {
        if (!(HOOK_NAMES as readonly string[]).includes(hook)) {
          throw new TypeError(
            `hooks.${name}.${hook} is not a hook. Hooks are ${HOOK_NAMES.join(', ')}.`,
          );
        }
        if (run !== undefined && typeof run !== 'function') {
          throw new TypeError(`hooks.${name}.${hook} must be a function.`);
        }
      }
      this.#hooks.set(name, set as Partial<Record<HookName, AnyHook>>);
    }
  }

  /**
   * The collection's hook, then the one for every collection. Superusers
   * have none: their records are also written outside the records API.
   */
  #find(collection: Collection, name: HookName): AnyHook[] {
    if (collection.name === SUPERUSERS) return [];
    return [
      this.#hooks.get(collection.name)?.[name],
      this.#hooks.get('*')?.[name],
    ].filter((hook) => hook !== undefined);
  }

  /** Whether the collection has a before hook for `action`. */
  hasBefore(collection: Collection, action: Action): boolean {
    return this.#find(collection, `before${capitalize(action)}`).length > 0;
  }

  /** Whether the collection has an on or after hook for `action`. */
  hasOnOrAfter(collection: Collection, action: Action): boolean {
    const name = capitalize(action);
    return (
      this.#find(collection, `on${name}`).length > 0 ||
      this.#find(collection, `after${name}`).length > 0
    );
  }

  /**
   * Whether writes of `action` to the collection must pass their records to
   * `wrote`: for on or after hooks, or realtime events.
   */
  observes(collection: Collection, action: Action): boolean {
    return this.hasOnOrAfter(collection, action) || this.#sends(collection);
  }

  // As for hooks, superusers send none: setup and createSuperuser() write
  // them outside the records API.
  #sends(collection: Collection): boolean {
    return (
      collection.name !== SUPERUSERS &&
      (this.#realtime?.sends(collection) ?? false)
    );
  }

  /** Runs the before hooks of a write, which may change `input`. */
  async before(
    scope: HookScope,
    collection: Collection,
    action: Action,
    {
      input,
      record,
      request,
    }: {
      input?: Record<string, unknown>;
      record?: Row;
      request: HookRequest;
    },
  ): Promise<void> {
    const hooks = this.#find(collection, `before${capitalize(action)}`);
    if (hooks.length === 0) return;
    const { authorization, cookie, ...headers } = request.headers;
    const event = {
      collection: hookCollection(collection),
      principal: hookPrincipal(scope.principal),
      source: scope.source,
      request: { method: request.method, query: request.query, headers },
      ...(input && { input }),
      ...(record && { record: serverRecord(collection, record) }),
    };
    for (const hook of hooks) await hook(event);
  }

  /**
   * Logs the realtime event of a written record and runs its on hooks, in
   * its transaction, then queues its after hooks for once the request's
   * changes are committed.
   */
  async wrote(
    tx: Tx,
    scope: HookScope,
    collection: Collection,
    action: Action,
    record: Row,
    original?: Row,
  ): Promise<void> {
    await this.#log(tx, collection, action, [record]);
    await this.#run(tx, scope, collection, action, record, original);
  }

  /**
   * `wrote` for several records of one collection, in order. Without on
   * hooks, which may write records of their own in between, their events
   * are logged with one statement.
   */
  async wroteAll(
    tx: Tx,
    scope: HookScope,
    collection: Collection,
    action: Action,
    written: readonly WrittenRecord[],
  ): Promise<void> {
    if (this.#find(collection, `on${capitalize(action)}`).length > 0) {
      for (const { record, original } of written) {
        await this.wrote(tx, scope, collection, action, record, original);
      }
      return;
    }
    await this.#log(
      tx,
      collection,
      action,
      written.map((w) => w.record),
    );
    for (const { record, original } of written) {
      await this.#run(tx, scope, collection, action, record, original);
    }
  }

  async #log(
    tx: Tx,
    collection: Collection,
    action: Action,
    records: readonly Row[],
  ): Promise<void> {
    if (records.length === 0 || !this.#sends(collection)) return;
    await writeEvents(tx, collection, action, records);
    this.#realtime?.logged();
  }

  async #run(
    tx: Tx,
    scope: HookScope,
    collection: Collection,
    action: Action,
    record: Row,
    original?: Row,
  ): Promise<void> {
    const name = capitalize(action);
    const on = this.#find(collection, `on${name}`);
    const after = this.#find(collection, `after${name}`);
    if (on.length === 0 && after.length === 0) return;
    const effects = scope.effects;
    if (!effects) throw new Error('Writes with record hooks need effects.');
    const event = (): Record<string, unknown> => ({
      collection: hookCollection(collection),
      principal: hookPrincipal(scope.principal),
      source: scope.source,
      record: serverRecord(collection, record),
      ...(original && { original: serverRecord(collection, original) }),
    });
    // Queued before the on hooks run, so after hooks run in the order of the
    // writes, this one before those its on hooks make. If an on hook fails,
    // the write fails, and what it queued is dropped with it.
    if (after.length > 0) {
      // Taken now: later writes of the request may change the record.
      const e = event();
      const chain = [...scope.chain, `${collection.name}.after${name}`];
      effects.hooks.push(async () => {
        const run = { ...e, nextbase: this.#clients.chained(chain) };
        for (const hook of after) {
          try {
            await hook(run);
          } catch (error) {
            this.#logger.failure(
              'hook',
              `after${name} hook for ${collection.name} failed`,
              error,
            );
          }
        }
      });
    }
    if (on.length > 0) {
      const hook = `${collection.name}.on${name}`;
      const joined = this.#clients.joined({
        tx,
        schema: scope.schema,
        effects,
        chain: [...scope.chain, hook],
      });
      const e = { ...event(), nextbase: joined.client };
      let failure: { error: unknown } | undefined;
      try {
        for (const run of on) await run(e);
      } catch (error) {
        failure = { error };
      }
      // Its writes run in this transaction, so none may outlast the hook.
      const unfinished = await joined.close();
      if (failure) throw failure.error;
      if (unfinished) {
        throw new Error(
          `The on${name} hook for ${collection.name} returned before its writes through e.nextbase finished. Await them.`,
        );
      }
    }
  }
}

function capitalize<A extends Action>(action: A): Capitalize<A> {
  return `${action[0]?.toUpperCase()}${action.slice(1)}` as Capitalize<A>;
}

// Schema versions replace their collection objects, so each copy is made once
// per version of a collection.
const hookCollections = new WeakMap<Collection, HookCollection>();

/** The collection as hooks see it: a frozen copy without token secrets. */
function hookCollection(collection: AuthCollection): HookAuthCollection;
function hookCollection(collection: Collection): HookCollection;
function hookCollection(collection: Collection): HookCollection {
  let copy = hookCollections.get(collection);
  if (!copy) {
    const clone = structuredClone(collection) as Collection;
    if (clone.type === 'auth') {
      for (const config of Object.values(clone.tokens)) {
        delete (config as Partial<TokenConfig>).secret;
      }
    }
    copy = deepFreeze(clone);
    hookCollections.set(collection, copy);
  }
  return copy;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function hookPrincipal(principal: Principal): HookPrincipal {
  const { collection, record, superuser, impersonatedBy } = principal;
  return {
    superuser,
    ...(impersonatedBy !== undefined && { impersonatedBy }),
    ...(collection && { collection: hookCollection(collection) }),
    ...(collection &&
      record && { record: serverRecord(collection, record) as RecordModel }),
  };
}
