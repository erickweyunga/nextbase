// @vitest-environment happy-dom
/// <reference lib="dom" />
import { AuthStore, type CurrentSession } from '@nextbasejs/client';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextBaseProvider, useSession } from '../src/index.ts';

// Tells React that tests wrap updates in act().
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const session = (email: string): CurrentSession => ({
  id: 's1',
  created: '2026-10-19T00:00:00.000Z',
  expires: '2026-10-26T00:00:00.000Z',
  userAgent: '',
  current: true,
  methods: [],
  record: { id: 'u1', collectionId: 'c1', collectionName: 'users', email },
});

function Probe() {
  const { data } = useSession();
  return createElement('p', null, String(data?.email ?? 'signed out'));
}

describe('@nextbasejs/react in the browser', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('follows a new session from the server, as after a server action', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const show = (value: CurrentSession | null) =>
      act(() =>
        root.render(
          createElement(
            NextBaseProvider,
            { session: value },
            createElement(Probe),
          ),
        ),
      );
    await show(null);
    expect(container.textContent).toBe('signed out');
    await show(session('ann@example.com'));
    expect(container.textContent).toBe('ann@example.com');
    await show(null);
    expect(container.textContent).toBe('signed out');
    await act(() => root.unmount());
  });

  it('keeps the auth store in sync with other tabs', () => {
    const store = new AuthStore();
    const changes: (string | undefined)[] = [];
    store.onChange((_, record) => changes.push(record?.email as string));
    const record = session('bo@example.com').record;
    const value = JSON.stringify({ token: 't1', record });
    // Another tab signs in, then out.
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'nextbase_auth', newValue: value }),
    );
    expect(store.token).toBe('t1');
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'nextbase_auth', newValue: null }),
    );
    expect(store.isValid).toBe(false);
    expect(changes).toEqual(['bo@example.com', undefined]);
  });

  it('subscribes to the auth store once, not on every render', async () => {
    const onChange = vi.spyOn(AuthStore.prototype, 'onChange');
    const container = document.createElement('div');
    const root = createRoot(container);
    const value = session('ann@example.com');
    for (let i = 0; i < 3; i++) {
      await act(() =>
        root.render(
          createElement(
            NextBaseProvider,
            { session: value },
            createElement(Probe),
          ),
        ),
      );
    }
    expect(onChange).toHaveBeenCalledTimes(1);
    await act(() => root.unmount());
  });
});
