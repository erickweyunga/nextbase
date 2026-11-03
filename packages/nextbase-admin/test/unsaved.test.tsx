// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://localhost:3001/api/nextbase/_/#/collections/posts"}
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canLeave } from '../src/ui/navigation.tsx';
import { UIProvider } from '../src/ui/provider/index.ts';
import { useUnsavedChanges } from '../src/unsaved.ts';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let dirty = false;

function Editor() {
  useUnsavedChanges(() => dirty);
  return null;
}

describe('unsaved changes', () => {
  let root: Root;
  let container: HTMLElement;

  beforeEach(async () => {
    dirty = false;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(UIProvider, null, createElement(Editor)));
    });
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
  });

  const button = (label: string) =>
    [...document.querySelectorAll('button')].find(
      (b) => b.textContent === label,
    );

  it('lets a clean editor go without asking', async () => {
    await expect(canLeave()).resolves.toBe(true);
    expect(button('Discard')).toBeUndefined();
  });

  it('asks before leaving, and stays when told to keep editing', async () => {
    dirty = true;
    let answer: Promise<boolean> | undefined;
    await act(async () => {
      answer = canLeave();
    });
    await act(async () => button('Keep editing')?.click());
    await expect(answer).resolves.toBe(false);
  });

  it('leaves once the changes are discarded', async () => {
    dirty = true;
    let answer: Promise<boolean> | undefined;
    await act(async () => {
      answer = canLeave();
    });
    await act(async () => button('Discard')?.click());
    await expect(answer).resolves.toBe(true);
  });

  it('warns before the page unloads', () => {
    dirty = true;
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
