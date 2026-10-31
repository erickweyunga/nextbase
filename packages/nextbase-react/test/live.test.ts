// @vitest-environment happy-dom
/// <reference lib="dom" />
import {
  ClientError,
  type ListResult,
  NextBaseClient,
  type RealtimeEvent,
  type RecordModel,
  type SubscribeOptions,
} from '@nextbasejs/client';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextBaseProvider, useRecord, useRecords } from '../src/index.ts';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface Post extends RecordModel {
  title: string;
}

const post = (id: string, title: string): Post => ({
  id,
  collectionId: 'c1',
  collectionName: 'posts',
  title,
});

const page = (items: Post[]): ListResult<Post> => ({
  page: 1,
  perPage: 30,
  totalItems: items.length,
  totalPages: 1,
  items,
});

/** A fake records service: loads answer what the test says, events on demand. */
class FakeRecords {
  list: Post[] = [];
  one: Post | Error = post('p1', 'First');
  lists = 0;
  topics: string[] = [];
  unsubscribed = 0;
  #listeners: {
    callback: (event: RealtimeEvent<Post>) => void;
    options: SubscribeOptions | undefined;
  }[] = [];

  getList = vi.fn(async () => {
    this.lists++;
    return page([...this.list]);
  });

  getOne = vi.fn(async () => {
    if (this.one instanceof Error) throw this.one;
    return this.one;
  });

  subscribe = vi.fn(
    (
      topic: string,
      callback: (event: RealtimeEvent<Post>) => void,
      options?: SubscribeOptions,
    ) => {
      this.topics.push(topic);
      const listener = { callback, options };
      this.#listeners.push(listener);
      return () => {
        this.unsubscribed++;
        this.#listeners = this.#listeners.filter((l) => l !== listener);
      };
    },
  );

  /** The subscription went live. */
  reset(): void {
    for (const { options } of this.#listeners) options?.onReset?.();
  }

  emit(event: RealtimeEvent<Post>): void {
    for (const { callback } of this.#listeners) callback(event);
  }

  refuse(error: ClientError): void {
    for (const { options } of this.#listeners) options?.onError?.(error);
  }
}

describe('live hooks', () => {
  let fake: FakeRecords;
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    fake = new FakeRecords();
    vi.spyOn(NextBaseClient.prototype, 'collection').mockReturnValue(
      fake as never,
    );
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const mount = (children: ReactNode) =>
    act(() =>
      root.render(createElement(NextBaseProvider, { session: null }, children)),
    );
  /** Lets pending loads settle. */
  const settle = () => act(async () => {});

  function Posts(props: {
    filter?: string;
    fields?: string;
    initial?: ListResult<Post>;
  }) {
    const { data, isPending, error } = useRecords<Post>('posts', props);
    if (error) return `error:${error.message}`;
    if (isPending) return 'pending';
    return (data?.items ?? []).map((p) => p.title).join(',') || 'none';
  }

  it('loads once the subscription is live, never before', async () => {
    fake.list = [post('p1', 'First')];
    await mount(createElement(Posts));
    expect(container.textContent).toBe('pending');
    expect(fake.getList).not.toHaveBeenCalled();
    // Every change the caller sees, not only the filter's.
    expect(fake.topics).toEqual(['*']);
    fake.reset();
    await settle();
    expect(container.textContent).toBe('First');
  });

  it('applies updates and deletes at once, and loads again once for changes close together', async () => {
    vi.useFakeTimers();
    fake.list = [post('p1', 'First'), post('p2', 'Second')];
    await mount(createElement(Posts));
    fake.reset();
    await settle();
    expect(fake.lists).toBe(1);

    await act(() => {
      fake.emit({ action: 'update', record: post('p1', 'First, edited') });
    });
    expect(container.textContent).toBe('First, edited,Second');
    await act(() => {
      fake.emit({ action: 'delete', record: post('p2', 'Second') });
    });
    expect(container.textContent).toBe('First, edited');

    fake.list = [post('p3', 'Third'), post('p1', 'First, edited')];
    await act(() => {
      fake.emit({ action: 'create', record: post('p3', 'Third') });
    });
    expect(fake.lists).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(fake.lists).toBe(2);
    expect(container.textContent).toBe('Third,First, edited');
  });

  it('still loads again while changes keep coming', async () => {
    vi.useFakeTimers();
    fake.list = [post('p1', 'First')];
    await mount(createElement(Posts));
    fake.reset();
    await settle();
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        fake.emit({ action: 'create', record: post(`n${i}`, 'New') });
        await vi.advanceTimersByTimeAsync(100);
      });
    }
    expect(fake.lists).toBeGreaterThan(1);
  });

  it('patches nothing for a change without an id, and loads it instead', async () => {
    vi.useFakeTimers();
    fake.list = [{ title: 'First' } as Post, { title: 'Second' } as Post];
    await mount(createElement(Posts, { fields: 'title' }));
    fake.reset();
    await settle();
    await act(() => {
      fake.emit({ action: 'delete', record: { title: 'Second' } as Post });
    });
    expect(container.textContent).toBe('First,Second');
    fake.list = [{ title: 'First' } as Post];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(container.textContent).toBe('First');
  });

  it('keeps only the newest of overlapping loads', async () => {
    let release: (value: ListResult<Post>) => void = () => {};
    fake.list = [post('p1', 'Old')];
    await mount(createElement(Posts));
    fake.getList.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    fake.reset();
    fake.list = [post('p1', 'New')];
    fake.reset();
    await settle();
    expect(container.textContent).toBe('New');
    await act(async () => release(page([post('p1', 'Old')])));
    expect(container.textContent).toBe('New');
  });

  it('subscribes again when the options change, and stops on unmount', async () => {
    await mount(createElement(Posts, { filter: 'a = 1' }));
    await mount(createElement(Posts, { filter: 'a = 2' }));
    expect(fake.subscribe).toHaveBeenCalledTimes(2);
    expect(fake.unsubscribed).toBe(1);
  });

  it('reports a refused subscription', async () => {
    await mount(createElement(Posts));
    await act(() => {
      fake.refuse(
        new ClientError({ status: 403, message: 'Not allowed.', data: {} }),
      );
    });
    expect(container.textContent).toBe('error:Not allowed.');
  });

  it('renders the page a server component loaded, before anything loads', () => {
    const html = renderToString(
      createElement(
        NextBaseProvider,
        { session: null },
        createElement(Posts, { initial: page([post('p1', 'Server')]) }),
      ),
    );
    expect(html).toContain('Server');
    expect(fake.getList).not.toHaveBeenCalled();
  });

  function OnePost({ id }: { id?: string }) {
    const { data, isPending } = useRecord<Post>('posts', id);
    if (isPending) return 'pending';
    if (data === undefined) return 'idle';
    return data === null ? 'gone' : data.title;
  }

  it('keeps one record current, and null once deleted', async () => {
    await mount(createElement(OnePost, { id: 'p1' }));
    expect(fake.topics).toEqual(['p1']);
    fake.reset();
    await settle();
    expect(container.textContent).toBe('First');
    await act(() => {
      fake.emit({ action: 'update', record: post('p1', 'Renamed') });
    });
    expect(container.textContent).toBe('Renamed');
    await act(() => {
      fake.emit({ action: 'delete', record: post('p1', 'Renamed') });
    });
    expect(container.textContent).toBe('gone');
  });

  it('answers null for a record the caller cannot see, and nothing without an id', async () => {
    fake.one = new ClientError({
      status: 404,
      message: 'Not found.',
      data: {},
    });
    await mount(createElement(OnePost, { id: 'p9' }));
    fake.reset();
    await settle();
    expect(container.textContent).toBe('gone');
    await mount(createElement(OnePost, {}));
    expect(container.textContent).toBe('idle');
  });
});
