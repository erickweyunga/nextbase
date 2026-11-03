// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://localhost:3001/api/nextbase/_/"}
import type { Collection, Field } from '@nextbasejs/client';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nb } from '../src/api.ts';
import { RecordPanel } from '../src/record-form.tsx';
import { UIProvider } from '../src/ui/provider/index.ts';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const field = (name: string, type: Field['type'], extra = {}) =>
  ({
    id: name,
    name,
    type,
    system: true,
    required: false,
    hidden: false,
    ...extra,
  }) as Field;

const superusers = {
  id: '_superusers',
  name: '_superusers',
  type: 'auth',
  system: true,
  fields: [
    field('id', 'text'),
    field('email', 'email', { required: true }),
    field('emailVerified', 'bool'),
    field('phone', 'phone'),
    field('password', 'password', { hidden: true, required: true }),
    field('tokenKey', 'text', { hidden: true }),
    field('created', 'autodate'),
  ],
} as unknown as Collection;

describe('the new record panel', () => {
  let root: Root;
  let container: HTMLElement;
  let create: ReturnType<typeof vi.fn>;
  let created: number;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    create = vi.fn().mockResolvedValue({ id: 'new' });
    created = 0;
    vi.spyOn(nb, 'collection').mockReturnValue({ create } as never);
    await act(async () => {
      root.render(
        createElement(
          UIProvider,
          null,
          createElement(RecordPanel, {
            collection: superusers,
            collections: [superusers],
            onClose: () => {},
            onSaved: () => {
              created += 1;
            },
          }),
        ),
      );
    });
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const type = (input: HTMLInputElement | undefined, value: string) =>
    act(() => {
      if (!input) throw new Error('No input.');
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

  it('asks for the editable fields and sends them', async () => {
    const labels = [...container.querySelectorAll('label')].map(
      (l) => l.textContent,
    );
    expect(labels.join('|')).not.toMatch(/tokenKey|created|\bid\b/);
    await type(
      container.querySelector<HTMLInputElement>('input[type=email]') ??
        undefined,
      'second@example.com',
    );
    await type(
      container.querySelector<HTMLInputElement>('input[aria-label="phone"]') ??
        undefined,
      '712345678',
    );
    const passwords = [
      ...container.querySelectorAll<HTMLInputElement>('input[type=password]'),
    ];
    await type(passwords[0], 'password123');
    await type(passwords[1], 'password123');
    await act(async () => {
      container
        .querySelector('form')
        ?.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
    });
    expect(create).toHaveBeenCalledWith({
      email: 'second@example.com',
      emailVerified: false,
      phone: '+1 712345678',
      password: 'password123',
      passwordConfirm: 'password123',
    });
    expect(created).toBe(1);
  });
});

describe('the edit record panel', () => {
  it('starts with the record and saves it, keeping a blank password', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const update = vi.fn().mockResolvedValue({ id: 'su1' });
    vi.spyOn(nb, 'collection').mockReturnValue({ update } as never);
    let saved = 0;
    await act(async () => {
      root.render(
        createElement(
          UIProvider,
          null,
          createElement(RecordPanel, {
            collection: superusers,
            collections: [superusers],
            record: {
              id: 'su1',
              collectionId: '_superusers',
              collectionName: '_superusers',
              email: 'ada@example.com',
              emailVerified: true,
              phone: '+255712345678',
            },
            onClose: () => {},
            onSaved: () => {
              saved += 1;
            },
          }),
        ),
      );
    });
    expect(
      container.querySelector<HTMLInputElement>('input[type=email]')?.value,
    ).toBe('ada@example.com');
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="phone"]')
        ?.value,
    ).toContain('712345678');
    await act(async () => {
      container
        .querySelector('form')
        ?.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
    });
    expect(update).toHaveBeenCalledWith('su1', {
      email: 'ada@example.com',
      emailVerified: true,
      phone: '+255 712345678',
    });
    expect(saved).toBe(1);
    await act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });
});
