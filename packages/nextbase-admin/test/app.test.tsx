// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://localhost:3001/api/nextbase/_/"}
import { ClientError } from '@nextbasejs/client';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nb } from '../src/api.ts';
import { App } from '../src/app.tsx';
import { UIProvider } from '../src/ui/provider/index.ts';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('the admin', () => {
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.spyOn(nb, 'setupStatus').mockResolvedValue({ required: true });
    vi.spyOn(nb, 'getSession').mockResolvedValue(null);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const mount = () =>
    act(async () => {
      root.render(createElement(UIProvider, null, createElement(App)));
    });
  const tokenField = () =>
    container.querySelector<HTMLInputElement>('input[name="token"]');
  const settled = async (done: () => boolean) => {
    for (let i = 0; i < 50 && !done(); i++) {
      await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
  };

  it('opens the setup link with its token filled in', async () => {
    window.location.hash = '#/setup/from.the.link';
    await mount();
    await settled(() => tokenField() !== null);
    expect(tokenField()?.value).toBe('from.the.link');
  });

  it('fills in the token of a link opened in a tab already on setup', async () => {
    window.location.hash = '#/setup';
    await mount();
    await settled(() => tokenField() !== null);
    expect(tokenField()?.value).toBe('');
    window.location.hash = '#/setup/pasted.later';
    await settled(() => tokenField()?.value === 'pasted.later');
    expect(tokenField()?.value).toBe('pasted.later');
  });

  it('in development, lands on the setup link with the token the server gives', async () => {
    vi.spyOn(nb, 'setupStatus').mockResolvedValue({
      required: true,
      token: 'from.the.server',
    });
    window.location.hash = '';
    await mount();
    await settled(() => tokenField() !== null);
    expect(window.location.hash).toBe('#/setup/from.the.server');
    expect(tokenField()?.value).toBe('from.the.server');
  });

  it('sets up NextBase, then goes to the login page with the email filled in', async () => {
    const setup = vi.spyOn(nb, 'setup').mockResolvedValue({
      id: 'superuser00001',
      collectionId: '_superusers',
      collectionName: '_superusers',
    });
    const signIn = vi.spyOn(nb, 'collection');
    window.location.hash = '#/setup/from.the.link';
    await mount();
    await settled(() => tokenField() !== null);
    const field = (name: string) =>
      container.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    for (const [name, value] of [
      ['email', 'owner@example.com'],
      ['password', 'a long enough password'],
      ['passwordConfirm', 'a long enough password'],
    ] as const) {
      const input = field(name);
      if (input) input.value = value;
    }
    await act(async () => {
      container.querySelector('form')?.requestSubmit();
    });
    await settled(() => tokenField() === null && field('email') !== null);
    expect(setup).toHaveBeenCalledWith({
      token: 'from.the.link',
      email: 'owner@example.com',
      password: 'a long enough password',
    });
    expect(signIn).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/login');
    expect(field('email')?.value).toBe('owner@example.com');
  });

  it('keeps the form and shows why when the server refuses the setup', async () => {
    vi.spyOn(nb, 'setup').mockRejectedValue(
      new ClientError({
        status: 400,
        message: 'Failed to create the superuser.',
        data: {
          password: {
            code: 'validation_length_out_of_range',
            message: 'Must be 8 to 256 characters.',
          },
        },
      }),
    );
    window.location.hash = '#/setup/from.the.link';
    await mount();
    await settled(() => tokenField() !== null);
    await act(async () => {
      container.querySelector('form')?.requestSubmit();
    });
    await settled(() =>
      (container.textContent ?? '').includes('Must be 8 to 256 characters.'),
    );
    expect(tokenField()?.value).toBe('from.the.link');
    expect(container.textContent).toContain('Must be 8 to 256 characters.');
  });

  it('sends any other path to setup while no superuser exists', async () => {
    window.location.hash = '#/logs';
    await mount();
    await settled(() => tokenField() !== null);
    expect(window.location.hash).toBe('#/setup');
    expect(tokenField()?.value).toBe('');
  });
});
