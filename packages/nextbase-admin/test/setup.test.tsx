// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://localhost:3001/api/nextbase/_/"}
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Setup } from '../src/setup.tsx';
import { UIProvider } from '../src/ui/provider/index.ts';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('the setup screen', () => {
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
  });

  const tokenField = () =>
    container.querySelector<HTMLInputElement>('input[name="token"]');

  it('fills in the token from the link', async () => {
    await act(() =>
      root.render(
        createElement(
          UIProvider,
          null,
          createElement(Setup, {
            token: 'from.the.link',
            onCreated: () => {},
          }),
        ),
      ),
    );
    expect(tokenField()?.value).toBe('from.the.link');
  });

  it('asks for the token without a link', async () => {
    await act(() =>
      root.render(
        createElement(
          UIProvider,
          null,
          createElement(Setup, { token: undefined, onCreated: () => {} }),
        ),
      ),
    );
    expect(tokenField()?.value).toBe('');
  });
});
