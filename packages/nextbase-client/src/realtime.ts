import { authSync } from './auth-sync.ts';
import { ClientError } from './client-error.ts';
import type { NextBaseClient } from './index.ts';
import type { ApiErrorBody, RecordModel } from './shared/api.ts';

export type RealtimeAction = 'create' | 'update' | 'delete';

/** A record created, updated or deleted. */
export interface RealtimeEvent<T extends RecordModel = RecordModel> {
  action: RealtimeAction;
  /**
   * The record as a list request would return it to this caller, with the
   * subscription's `expand` and `fields`. For a delete, as it was.
   */
  record: T;
}

export interface SubscribeOptions {
  /** A filter expression the records must match; build one with `filter()`. */
  filter?: string;
  /** Relations to load, e.g. `author`. */
  expand?: string;
  /** Output fields, e.g. `id,title`. */
  fields?: string;
  /**
   * Called once the subscription is live, so events from then on arrive,
   * and again whenever events may have been missed, such as after the
   * client was away longer than the server keeps events. Load what you
   * show here.
   */
  onReset?: () => void;
  /** Called when the server refuses the subscription, which then ends. */
  onError?: (error: ClientError) => void;
}

interface Subscription {
  collection: string;
  id: string | undefined;
  callback: (event: RealtimeEvent) => void;
  options: SubscribeOptions;
  /** A stream with it started, so it misses nothing from then on. */
  live: boolean;
}

/** How a stream ended. */
type Outcome =
  /** The server ended it on purpose: reconnect at once. */
  | 'ended'
  /** It failed, or could not start: reconnect after a wait. */
  | 'failed'
  /** Subscriptions or the session changed, or a topic was refused: reconnect at once. */
  | 'changed';

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
// A stream that stayed open this long was healthy, whatever ended it.
const HEALTHY_MS = MAX_RETRY_MS;

/**
 * Realtime subscriptions of one client, all over one streamed request. It
 * reconnects on its own, resuming after the last event it received, and
 * starts over when subscriptions or the signed-in session change.
 */
export class RealtimeService {
  readonly #client: NextBaseClient;
  readonly #post: (init: RequestInit) => Promise<Response>;
  readonly #subscriptions = new Set<Subscription>();
  #lastEventId = '';
  #failures = 0;
  #running = false;
  #scheduled = false;
  #changed = false;
  #controller: AbortController | undefined;
  #wake: (() => void) | undefined;
  #offAuth: (() => void) | undefined;

  constructor(
    client: NextBaseClient,
    post: (init: RequestInit) => Promise<Response>,
  ) {
    this.#client = client;
    this.#post = post;
  }

  /**
   * Calls `callback` for each record of `collection` created, updated or
   * deleted that the caller may see: any record for `"*"`, under the list
   * rule, or one record by id, under the view rule. Returns the function
   * that unsubscribes.
   */
  subscribe<T extends RecordModel = RecordModel>(
    collection: string,
    topic: string,
    callback: (event: RealtimeEvent<T>) => void,
    options: SubscribeOptions = {},
  ): () => void {
    if (topic === '') {
      throw new TypeError('The topic must be "*" or a record id.');
    }
    const subscription: Subscription = {
      collection,
      id: topic === '*' ? undefined : topic,
      callback: callback as (event: RealtimeEvent) => void,
      options,
      live: false,
    };
    this.#subscriptions.add(subscription);
    this.#offAuth ??= this.#client.authStore.onChange(() => this.#restart());
    this.#restart();
    return () => {
      if (!this.#subscriptions.delete(subscription)) return;
      this.#restart();
    };
  }

  /**
   * Starts the stream over with the current subscriptions, once the calls
   * of this tick are done, so several subscribe at once with one request.
   */
  #restart(): void {
    this.#changed = true;
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      if (this.#subscriptions.size === 0) {
        this.#offAuth?.();
        this.#offAuth = undefined;
      }
      this.#controller?.abort();
      this.#wake?.();
      if (!this.#running) void this.#run();
    });
  }

  async #run(): Promise<void> {
    this.#running = true;
    try {
      while (this.#subscriptions.size > 0) {
        this.#changed = false;
        const started = Date.now();
        const outcome = await this.#stream();
        if (outcome === 'ended' || Date.now() - started >= HEALTHY_MS) {
          this.#failures = 0;
        }
        if (outcome !== 'failed' || this.#changed) continue;
        await this.#sleep(retryDelay(++this.#failures));
      }
    } finally {
      this.#running = false;
      // A later subscription starts after events as they come then.
      this.#lastEventId = '';
      this.#failures = 0;
    }
  }

  /** Waits `ms`, or until subscriptions or the session change. */
  async #sleep(ms: number): Promise<void> {
    if (this.#changed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
      this.#wake = done;
    });
    this.#wake = undefined;
  }

  /** Runs one streamed request until it ends. */
  async #stream(): Promise<Outcome> {
    const subscriptions = [...this.#subscriptions];
    const store = this.#client.authStore;
    const { token, record } = store;
    const unchanged = authSync(store).snapshot();
    const controller = new AbortController();
    this.#controller = controller;
    const headers: Record<string, string> = {
      accept: 'text/event-stream',
      'content-type': 'application/json',
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (this.#lastEventId) headers['last-event-id'] = this.#lastEventId;
    const topics = subscriptions.map(({ collection, id, options }) => ({
      collection,
      ...(id !== undefined && { id }),
      ...(options.filter && { filter: options.filter }),
      ...(options.expand && { expand: options.expand }),
      ...(options.fields && { fields: options.fields }),
    }));
    try {
      const response = await this.#post({
        method: 'POST',
        headers,
        body: JSON.stringify({ topics }),
        signal: controller.signal,
      });
      // A cookie session that ended, as `send()` handles it.
      if (
        unchanged() &&
        token === '' &&
        record !== null &&
        response.headers.get('nextbase-session') === 'none'
      ) {
        store.clear();
        await response.body?.cancel();
        return 'changed';
      }
      if (!response.ok) return await this.#refused(response, subscriptions);
      if (!response.body) return 'failed';
      // The server answers once it knows where the stream starts.
      for (const subscription of subscriptions) {
        if (subscription.live || !this.#subscriptions.has(subscription)) {
          continue;
        }
        subscription.live = true;
        call(() => subscription.options.onReset?.());
      }
      let ended = false;
      const parser = new EventStreamParser((event) => {
        if (event.type === 'end') {
          ended = true;
          const { reason } = parseJson(event.data) as { reason?: unknown };
          if (reason === 'signed_out' && unchanged() && store.isValid) {
            store.clear();
          }
          return;
        }
        this.#dispatch(subscriptions, event);
      });
      const reader = response.body
        .pipeThrough(new TextDecoderStream())
        .getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.push(value);
          // Ids come with events, and alone, to move the cursor on.
          this.#lastEventId = parser.lastEventId || this.#lastEventId;
        }
      } finally {
        reader.releaseLock();
      }
      return ended ? 'ended' : 'failed';
    } catch {
      return controller.signal.aborted ? 'changed' : 'failed';
    } finally {
      controller.abort();
      if (this.#controller === controller) this.#controller = undefined;
    }
  }

  #dispatch(
    subscriptions: readonly Subscription[],
    event: { type: string; data: string },
  ): void {
    if (event.type === 'reset') {
      for (const subscription of subscriptions) {
        if (this.#subscriptions.has(subscription)) {
          call(() => subscription.options.onReset?.());
        }
      }
      return;
    }
    if (
      event.type !== 'create' &&
      event.type !== 'update' &&
      event.type !== 'delete'
    ) {
      return;
    }
    const { topics } = parseJson(event.data) as {
      topics?: Record<string, RecordModel>;
    };
    for (const [index, record] of Object.entries(topics ?? {})) {
      const subscription = subscriptions[Number(index)];
      // Unsubscribed while the stream was open.
      if (!subscription || !this.#subscriptions.has(subscription)) continue;
      call(() =>
        subscription.callback({ action: event.type as RealtimeAction, record }),
      );
    }
  }

  /**
   * A response that refused the stream. Refused topics end their
   * subscriptions; other client errors end all of them, as retrying cannot
   * fix them. A 401 signs out, as `send()` does, and the stream starts over.
   */
  async #refused(
    response: Response,
    subscriptions: readonly Subscription[],
  ): Promise<Outcome> {
    const body = parseJson(await response.text().catch(() => ''));
    const error = new ClientError(
      isErrorBody(body)
        ? body
        : {
            status: response.status,
            message: `The request failed with status ${response.status}.`,
            data: {},
          },
    );
    const store = this.#client.authStore;
    if (response.status === 401 && store.isValid) {
      store.clear();
      return 'changed';
    }
    if (
      response.status < 400 ||
      response.status >= 500 ||
      [401, 408, 409, 429].includes(response.status)
    ) {
      return 'failed';
    }
    const refused = error.data.topics;
    const ended =
      refused && typeof refused === 'object'
        ? Object.keys(refused).flatMap((i) => subscriptions[Number(i)] ?? [])
        : subscriptions;
    for (const subscription of ended) {
      if (this.#subscriptions.delete(subscription)) {
        call(() => subscription.options.onError?.(error));
      }
    }
    return 'changed';
  }
}

/** The wait before the `failures`th retry in a row, with jitter. */
function retryDelay(failures: number): number {
  const ms = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** (failures - 1));
  return ms / 2 + Math.random() * (ms / 2);
}

/** Runs a subscriber's callback; one that throws does not stop the stream. */
function call(run: () => void): void {
  try {
    run();
  } catch (error) {
    console.error('[nextbase] a realtime callback failed:', error);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as ApiErrorBody).status === 'number' &&
    typeof (value as ApiErrorBody).message === 'string' &&
    typeof (value as ApiErrorBody).data === 'object'
  );
}

interface ParsedEvent {
  type: string;
  data: string;
  lastEventId: string;
}

/**
 * Parses an event stream as the HTML standard's EventSource does
 * (https://html.spec.whatwg.org/multipage/server-sent-events.html). Lines
 * end with CRLF, LF or CR, which may be split across chunks; a blank line
 * dispatches the event. An event without data is not dispatched, but its id
 * still becomes the last event id. The decoder strips a leading BOM.
 */
class EventStreamParser {
  readonly #onEvent: (event: ParsedEvent) => void;
  #line = '';
  /** The last chunk ended with CR, so a LF that starts the next ends nothing. */
  #afterCR = false;
  #type = '';
  #data = '';
  #id = '';
  lastEventId = '';

  constructor(onEvent: (event: ParsedEvent) => void) {
    this.#onEvent = onEvent;
  }

  push(text: string): void {
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      if (this.#afterCR) {
        this.#afterCR = false;
        if (char === LF) {
          start = i + 1;
          continue;
        }
      }
      if (char !== LF && char !== CR) continue;
      const line = this.#line + text.slice(start, i);
      this.#line = '';
      this.#afterCR = char === CR;
      start = i + 1;
      this.#field(line);
    }
    this.#line += text.slice(start);
  }

  #field(line: string): void {
    if (line === '') {
      this.#dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const name = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (name === 'event') this.#type = value;
    else if (name === 'data') this.#data += `${value}\n`;
    else if (name === 'id' && !value.includes('\0')) this.#id = value;
    // `retry` sets EventSource's reconnection time; this client keeps its
    // own backoff.
  }

  #dispatch(): void {
    this.lastEventId = this.#id;
    const data = this.#data;
    const type = this.#type;
    this.#data = '';
    this.#type = '';
    if (data === '') return;
    this.#onEvent({
      type: type || 'message',
      data: data.slice(0, -1),
      lastEventId: this.lastEventId,
    });
  }
}

const LF = 10;
const CR = 13;
