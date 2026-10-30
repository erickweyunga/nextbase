import type { CurrentSession } from '@nextbasejs/client';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NextBaseProvider, useNextBase, useSession } from '../src/index.ts';

describe('@nextbasejs/react', () => {
  const session: CurrentSession = {
    id: 's1',
    created: '2026-10-19T00:00:00.000Z',
    expires: '2026-10-26T00:00:00.000Z',
    userAgent: '',
    current: true,
    methods: [],
    record: {
      id: 'u1',
      collectionId: 'c1',
      collectionName: 'users',
      email: 'ann@example.com',
    },
  };

  function Probe() {
    const { data, isPending } = useSession();
    const nb = useNextBase();
    return createElement(
      'p',
      null,
      `${isPending ? 'pending' : 'ready'}:${String(data?.email ?? 'signed out')}:${nb.authStore.isValid}`,
    );
  }
  const render = (props: object) =>
    renderToString(
      createElement(NextBaseProvider, props, createElement(Probe)),
    );

  it('renders with the session the server read, so the first paint is right', () => {
    expect(render({ session })).toContain('ready:ann@example.com:true');
    expect(render({ session: null })).toContain('ready:signed out:false');
  });

  it('is pending when the session is left to the browser to load', () => {
    expect(render({})).toContain('pending:signed out:false');
  });

  it('asks for a provider instead of failing obscurely', () => {
    expect(() => renderToString(createElement(Probe))).toThrow(
      'Wrap the component tree in <NextBaseProvider>.',
    );
  });
});
