// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://localhost:3001/api/nextbase/_/"}
import type { Collection } from '@nextbasejs/client';
import { describe, expect, it } from 'vitest';
import { landing, matching } from '../src/collections.tsx';

const collection = (name: string, type: Collection['type'], system = false) =>
  ({ id: name, name, type, system }) as Collection;

const all = [
  collection('_superusers', 'auth', true),
  collection('posts', 'base'),
  collection('users', 'auth'),
];

describe('the collections landing', () => {
  it('opens the collection opened last', () => {
    expect(landing(all, 'posts')).toBe('/collections/posts');
  });

  it('opens the first collection, in the panel order, without one', () => {
    expect(landing(all, null)).toBe('/collections/users');
    expect(landing(all, 'deleted')).toBe('/collections/users');
    expect(landing([collection('_superusers', 'auth', true)], null)).toBe(
      '/collections/_superusers',
    );
  });

  it('has nowhere to go without collections', () => {
    expect(landing([], 'posts')).toBeUndefined();
  });
});

describe('the collections search', () => {
  it('keeps the collections whose names contain it, ignoring case', () => {
    expect(matching(all, 'POST').map((c) => c.name)).toEqual(['posts']);
    expect(matching(all, 'us').map((c) => c.name)).toEqual([
      '_superusers',
      'users',
    ]);
    expect(matching(all, '  ')).toHaveLength(3);
  });
});
