import type { Collection } from '@nextbasejs/client';
import { useCallback, useEffect, useState } from 'react';
import { nb } from './api.ts';
import { CollectionForm } from './collection-form.tsx';
import { typeIcon } from './collection-icon.tsx';
import { Body, Page } from './components/page.tsx';
import { Records } from './records.tsx';
import { EmptyState } from './ui/empty-state/index.ts';
import { AddIcon, FolderIcon } from './ui/icons/index.tsx';
import { navigate } from './ui/navigation.tsx';
import {
  SidebarActionButton,
  type SidebarEntry,
  SidebarPanel,
  SidebarPanelLayout,
  SidebarPanelSearch,
} from './ui/sidebar/index.ts';

const ICON = 20;

const TYPE_ORDER: Record<Collection['type'], number> = {
  auth: 0,
  base: 1,
  view: 2,
};

function byTypeThenName(a: Collection, b: Collection): number {
  return (
    TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.name.localeCompare(b.name)
  );
}

const LAST_COLLECTION_KEY = 'nextbase-admin-collection';

const NEW = '/collections/new';

const pathOf = (name: string) => `/collections/${encodeURIComponent(name)}`;

const editPathOf = (name: string) => `${pathOf(name)}/edit`;

function grouped(collections: readonly Collection[]) {
  return {
    own: collections.filter((c) => !c.system).sort(byTypeThenName),
    system: collections.filter((c) => c.system).sort(byTypeThenName),
  };
}

function lastCollection(): string | null {
  try {
    return localStorage.getItem(LAST_COLLECTION_KEY);
  } catch {
    return null;
  }
}

function remember(name: string): void {
  try {
    localStorage.setItem(LAST_COLLECTION_KEY, name);
  } catch {}
}

export function landing(
  collections: readonly Collection[],
  last: string | null,
): string | undefined {
  const { own, system } = grouped(collections);
  const ordered = [...own, ...system];
  const target = ordered.find((c) => c.name === last) ?? ordered[0];
  return target && pathOf(target.name);
}

function entries(
  collections: readonly Collection[],
  searching = false,
): SidebarEntry[] {
  const item = (collection: Collection) => ({
    title: collection.name,
    href: pathOf(collection.name),
    icon: typeIcon(collection.type),
  });
  const { own, system } = grouped(collections);
  return [
    ...(own.length > 0
      ? [
          {
            label: 'Collections',
            collapsible: !searching,
            items: own.map(item),
          },
        ]
      : []),
    ...(system.length > 0
      ? [
          {
            label: 'System',
            collapsible: !searching,
            defaultOpen: false,
            items: system.map(item),
          },
        ]
      : []),
  ];
}

function useCollections(): [Collection[] | undefined, () => Promise<void>] {
  const [collections, setCollections] = useState<Collection[]>();
  const load = useCallback(
    () =>
      nb.collections
        .getFullList()
        .then(setCollections)
        .catch(() => setCollections([])),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return [collections, load];
}

function CollectionPage({
  path,
  collections,
  onCreated,
}: {
  path: string;
  collections: readonly Collection[] | undefined;
  onCreated: (collection: Collection) => void;
}) {
  if (path === NEW) {
    return (
      <CollectionForm collections={collections ?? []} onSaved={onCreated} />
    );
  }
  const editing = collections?.find((c) => editPathOf(c.name) === path);
  if (editing) {
    return (
      <CollectionForm
        key={`edit:${editing.id}`}
        collection={editing}
        collections={collections ?? []}
        onSaved={onCreated}
      />
    );
  }
  const collection = collections?.find((c) => pathOf(c.name) === path);
  if (collection) {
    return (
      <Records
        key={collection.id}
        collection={collection}
        collections={collections ?? []}
      />
    );
  }
  if (collections?.length !== 0) return null;
  return (
    <Page title="Collections" icon={<FolderIcon size={ICON} />}>
      <EmptyState icon={<FolderIcon size={64} />} title="No collections yet" />
    </Page>
  );
}

export function matching(
  collections: readonly Collection[],
  query: string,
): Collection[] {
  const q = query.trim().toLowerCase();
  return q === ''
    ? [...collections]
    : collections.filter((c) => c.name.toLowerCase().includes(q));
}

export function Collections({ path }: { path: string }) {
  const [collections, reload] = useCollections();
  const [search, setSearch] = useState('');
  const created = (collection: Collection) => {
    void reload();
    navigate(pathOf(collection.name));
  };

  useEffect(() => {
    if (!collections || path === NEW) return;
    const open = collections.find(
      (c) => pathOf(c.name) === path || editPathOf(c.name) === path,
    );
    if (open) {
      remember(open.name);
      return;
    }
    const target = landing(collections, lastCollection());
    if (target) navigate(target, { replace: true });
  }, [collections, path]);
  return (
    <SidebarPanelLayout
      panel={
        <SidebarPanel
          label="Collections"
          action={
            <>
              <SidebarActionButton
                title="New collection"
                icon={<AddIcon size={ICON} />}
                onClick={() => navigate('/collections/new')}
              />
              <SidebarPanelSearch
                value={search}
                onChange={setSearch}
                label="Search collections"
                placeholder="Search collections"
              />
            </>
          }
          items={entries(
            matching(collections ?? [], search),
            search.trim() !== '',
          )}
        />
      }
    >
      <Body>
        <CollectionPage
          path={path}
          collections={collections}
          onCreated={created}
        />
      </Body>
    </SidebarPanelLayout>
  );
}
