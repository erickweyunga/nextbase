// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://localhost:3001/api/nextbase/_/"}
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UIProvider, useColorMode } from '../src/ui/provider/index.ts';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('the colour mode', () => {
  let root: Root;
  let container: HTMLElement;
  let state: ReturnType<typeof useColorMode> | undefined;

  function Probe() {
    state = useColorMode();
    return null;
  }

  const mount = () =>
    act(async () => {
      root.render(createElement(UIProvider, null, createElement(Probe)));
    });

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
  });

  it('follows the system until a mode is chosen', async () => {
    await mount();
    expect(state?.mode).toBe('system');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('remembers a chosen mode and applies it to the page', async () => {
    await mount();
    await act(async () => state?.setMode('dark'));
    expect(state?.dark).toBe(true);
    expect(localStorage.getItem('nextbase-admin-color-mode')).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    await act(async () => state?.setMode('system'));
    expect(localStorage.getItem('nextbase-admin-color-mode')).toBeNull();
  });
});
