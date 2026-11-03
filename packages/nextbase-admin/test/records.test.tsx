// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://localhost:3001/api/nextbase/_/"}
import type { Collection, Field } from '@nextbasejs/client';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nb } from '../src/api.ts';
import { Records } from '../src/records.tsx';
import { UIProvider } from '../src/ui/provider/index.ts';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const field = (name: string, type: Field['type'], hidden = false) =>
  ({ id: name, name, type, system: true, required: false, hidden }) as Field;

const superusers = {
  id: '_superusers',
  name: '_superusers',
  type: 'auth',
  system: true,
  fields: [
    field('id', 'text'),
    field('email', 'email'),
    field('emailVerified', 'bool'),
    field('password', 'password', true),
    field('tokenKey', 'text', true),
  ],
} as unknown as Collection;

describe('the records table', () => {
  let root: Root;
  let container: HTMLElement;
  let getList: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    getList = vi.fn();
    vi.spyOn(nb, 'collection').mockReturnValue({ getList } as never);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const mount = () =>
    act(async () => {
      root.render(
        createElement(
          UIProvider,
          null,
          createElement(Records, {
            collection: superusers,
            collections: [superusers],
          }),
        ),
      );
    });

  it('shows the visible fields of each record', async () => {
    getList.mockResolvedValue({
      page: 1,
      perPage: 30,
      totalItems: 1,
      totalPages: 1,
      items: [
        {
          id: 'su1',
          collectionId: '_superusers',
          collectionName: '_superusers',
          email: 'owner@example.com',
          emailVerified: true,
        },
      ],
    });
    await mount();
    const headers = [...container.querySelectorAll('th')].map(
      (th) => th.textContent,
    );
    expect(headers).toEqual(['', 'id', 'email', 'emailVerified', '']);
    expect(getList).toHaveBeenCalledWith(1, 30, { filter: undefined });
    const cells = [...container.querySelectorAll('tbody td')].map(
      (td) => td.textContent,
    );
    expect(cells.slice(1)).toEqual(['su1', 'owner@example.com', 'True', '']);
  });

  const empty = {
    page: 1,
    perPage: 30,
    totalItems: 0,
    totalPages: 0,
    items: [],
  };

  const search = async (text: string) => {
    const input = container.querySelector<HTMLInputElement>(
      'input[type="search"]',
    );
    if (!input) throw new Error('No search field.');
    await act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 350)));
  };

  it('searches the text fields for plain words', async () => {
    getList.mockResolvedValue(empty);
    await mount();
    await search("o'neil");
    expect(getList).toHaveBeenLastCalledWith(1, 30, {
      filter: `id ~ "o'neil" || email ~ "o'neil"`,
    });
    expect(container.textContent).toContain('No records match your search');
  });

  it('passes a filter expression through', async () => {
    getList.mockResolvedValue(empty);
    await mount();
    await search('emailVerified = true');
    expect(getList).toHaveBeenLastCalledWith(1, 30, {
      filter: 'emailVerified = true',
    });
  });

  it('shows skeleton rows while the records load', async () => {
    getList.mockReturnValue(new Promise(() => {}));
    await mount();
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('says when there are no records', async () => {
    getList.mockResolvedValue({
      page: 1,
      perPage: 30,
      totalItems: 0,
      totalPages: 0,
      items: [],
    });
    await mount();
    expect(container.textContent).toContain('No records yet');
  });
});
