// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://localhost:3001/api/nextbase/_/"}
import { ClientError, type Collection } from '@nextbasejs/client';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nb } from '../src/api.ts';
import { CollectionForm } from '../src/collection-form.tsx';
import { UIProvider } from '../src/ui/provider/index.ts';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('the new collection screen', () => {
  let root: Root;
  let container: HTMLElement;
  let created: Collection[];

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    created = [];
    await act(async () => {
      root.render(
        createElement(
          UIProvider,
          null,
          createElement(CollectionForm, {
            onSaved: (collection) => created.push(collection),
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

  const type = (input: HTMLInputElement, value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const nameField = () =>
    container.querySelector<HTMLInputElement>('input[name="name"]');
  const button = (label: string) =>
    [...container.querySelectorAll('button')].find(
      (b) => (b.getAttribute('aria-label') ?? b.textContent) === label,
    );
  const submit = () =>
    act(async () => {
      button('Create')?.click();
    });

  it('adds new fields above created and updated', async () => {
    const create = vi
      .spyOn(nb.collections, 'create')
      .mockResolvedValue({ name: 'posts' } as Collection);
    const name = nameField();
    if (!name) throw new Error('No name field.');
    await type(name, 'posts');
    await act(async () => {
      button('New field')?.click();
    });
    const fieldNames = container.querySelectorAll<HTMLInputElement>(
      'input[aria-label="Field name"]',
    );
    const added = [...fieldNames].find((input) => input.value === '');
    if (!added) throw new Error('No new field.');
    await type(added, 'title');
    await submit();
    expect(create).toHaveBeenCalledWith({
      name: 'posts',
      type: 'base',
      fields: [
        { name: 'title', type: 'text', required: false },
        {
          name: 'created',
          type: 'autodate',
          required: false,
          onCreate: true,
          onUpdate: false,
        },
        {
          name: 'updated',
          type: 'autodate',
          required: false,
          onCreate: true,
          onUpdate: true,
        },
      ],
    });
    expect(created).toEqual([{ name: 'posts' }]);
  });

  it('shows the errors under the fields it refused', async () => {
    vi.spyOn(nb.collections, 'create').mockRejectedValue(
      new ClientError({
        status: 400,
        message: 'Failed to create the collection.',
        data: {
          name: { code: 'validation_required', message: 'Cannot be blank.' },
          fields: {
            1: {
              name: {
                code: 'validation_not_unique',
                message: 'Another field has this name.',
              },
            },
          },
        },
      }),
    );
    await submit();
    expect(container.textContent).toContain('Cannot be blank.');
    expect(container.textContent).toContain('Another field has this name.');
    expect(created).toEqual([]);
  });
});

describe('editing a collection', () => {
  const posts = {
    id: 'pbc_posts',
    name: 'posts',
    type: 'base',
    system: false,
    fields: [
      {
        id: '_id',
        name: 'id',
        type: 'text',
        system: true,
        required: true,
        hidden: false,
      },
      {
        id: 'f_status',
        name: 'status',
        type: 'select',
        system: false,
        required: false,
        hidden: false,
        values: ['draft', 'live'],
        maxSelect: 1,
      },
      {
        id: 'f_created',
        name: 'created',
        type: 'autodate',
        system: false,
        required: false,
        hidden: false,
        onCreate: true,
        onUpdate: false,
      },
    ],
  } as unknown as Collection;

  let root: Root;
  let container: HTMLElement;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          UIProvider,
          null,
          createElement(CollectionForm, {
            collection: posts,
            onSaved: () => {},
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

  it('saves changes and keeps what the form does not edit', async () => {
    const update = vi.spyOn(nb.collections, 'update').mockResolvedValue(posts);
    const names = [
      ...container.querySelectorAll<HTMLInputElement>(
        'input[aria-label="Field name"]',
      ),
    ];
    expect(names.map((input) => input.value)).toEqual(['status', 'created']);
    const status = names[0];
    if (!status) throw new Error('No status field.');
    await act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(status, 'state');
      status.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((b) => b.textContent === 'Save')
        ?.click();
    });
    expect(update).toHaveBeenCalledWith('pbc_posts', {
      name: 'posts',
      fields: [
        {
          id: 'f_status',
          name: 'state',
          type: 'select',
          system: false,
          required: false,
          hidden: false,
          values: ['draft', 'live'],
          maxSelect: 1,
        },
        {
          id: 'f_created',
          name: 'created',
          type: 'autodate',
          system: false,
          required: false,
          hidden: false,
          onCreate: true,
          onUpdate: false,
        },
      ],
    });
  });
});

describe('field settings', () => {
  let root: Root;
  let container: HTMLElement;

  const tags = {
    id: 'c_tags',
    name: 'tags',
    type: 'base',
    system: false,
    fields: [],
  } as unknown as Collection;
  const posts = {
    id: 'c_posts',
    name: 'posts',
    type: 'base',
    system: false,
    fields: [
      {
        id: 'f_tags',
        name: 'tags',
        type: 'relation',
        system: false,
        required: false,
        hidden: false,
        collectionId: 'c_tags',
        maxSelect: 1,
        cascadeDelete: false,
      },
    ],
  } as unknown as Collection;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          UIProvider,
          null,
          createElement(CollectionForm, {
            collection: posts,
            collections: [posts, tags],
            onSaved: () => {},
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

  it("saves a field's settings merged into the field", async () => {
    const update = vi.spyOn(nb.collections, 'update').mockResolvedValue(posts);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="tags settings"]')
        ?.click();
    });
    const max = container.querySelector<HTMLInputElement>(
      'input[aria-label="tags Max select"]',
    );
    if (!max) throw new Error('No max select setting.');
    await act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(max, '3');
      max.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((b) => b.textContent === 'Save')
        ?.click();
    });
    expect(update).toHaveBeenCalledWith('c_posts', {
      name: 'posts',
      fields: [
        expect.objectContaining({
          id: 'f_tags',
          collectionId: 'c_tags',
          maxSelect: 3,
          cascadeDelete: false,
        }),
      ],
    });
  });
});
