import type { Collection, Field, RecordModel } from '@nextbasejs/client';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { nb } from './api.ts';
import { typeIcon } from './collection-icon.tsx';
import {
  DATE_FORMAT,
  END_COLUMN,
  FILLER_COLUMN,
  ID_COLUMN,
  NOWRAP_COLUMN,
  TEXT_COLUMN,
} from './components/grid-columns.ts';
import { TablePage } from './components/page.tsx';
import { FilePreview, relationOptions } from './field-inputs.tsx';
import { RecordPanel } from './record-form.tsx';
import { asList, searchFilter } from './record-text.ts';
import { Button, KIND } from './ui/button/index.ts';
import { DropdownMenu } from './ui/dropdown-menu/index.ts';
import { EmptyState } from './ui/empty-state/index.ts';
import { AddIcon, ExpandMoreIcon, MoreHorizIcon } from './ui/icons/index.tsx';
import { ConfirmModal } from './ui/modal/index.ts';
import { canLeave, navigate } from './ui/navigation.tsx';
import {
  PageHeader,
  PageHeaderButtonLabel,
  PageHeaderSearch,
} from './ui/page-header/index.ts';
import { SidePanelLayout } from './ui/side-panel/index.ts';
import { styled } from './ui/styles/index.ts';
import {
  DIVIDER,
  SELECTION_COLUMN_OVERRIDES,
  SelectionCheckbox,
  TableBuilder,
  TableBuilderColumn,
  useRowSelection,
} from './ui/table/index.ts';
import { toaster } from './ui/toast/index.ts';

const PAGE_SIZE = 30;

const Files = styled('span', ({ $theme }) => ({
  display: 'flex',
  alignItems: 'center',
  gap: $theme.sizing.scale300,
}));

const FileLabel = styled('span', {
  maxWidth: '240px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const FileCell = styled('span', ({ $theme }) => ({
  display: 'flex',
  alignItems: 'center',
  gap: $theme.sizing.scale200,
}));

function plural(count: number): string {
  return count === 1 ? '1 record' : `${count} records`;
}

function columnsOf(collection: Collection): Field[] {
  return collection.fields.filter((f) => !f.hidden && f.name !== 'id');
}

function expandOf(collection: Collection): string | undefined {
  const names = collection.fields
    .filter((f) => f.type === 'relation' && !f.hidden)
    .map((f) => f.name);
  return names.length > 0 ? names.join(',') : undefined;
}

function cell(
  field: Field,
  record: RecordModel,
  collections: readonly Collection[],
): ReactNode {
  const value = record[field.name];
  if (value === null || value === undefined || value === '') return null;
  switch (field.type) {
    case 'relation':
      return relationOptions(
        field,
        collections.find((c) => c.id === field.collectionId),
        record,
      )
        .map((option) => option.label)
        .join(', ');
    case 'file': {
      const names = asList(value);
      return (
        names.length > 0 && (
          <Files>
            {names.map((name) => (
              <FileCell key={name}>
                <FilePreview record={record} name={name} />
                {names.length === 1 && (
                  <FileLabel title={name}>{name}</FileLabel>
                )}
              </FileCell>
            ))}
          </Files>
        )
      );
    }
    case 'bool':
      return value ? 'True' : 'False';
    case 'date':
    case 'autodate': {
      const date = new Date(String(value));
      return Number.isNaN(date.getTime())
        ? String(value)
        : DATE_FORMAT.format(date);
    }
    case 'json':
      return JSON.stringify(value);
    default:
      return Array.isArray(value) ? value.join(', ') : String(value);
  }
}

function overridesFor(field: Field) {
  if (field.type === 'number') return END_COLUMN;
  if (field.type === 'text' || field.type === 'json') return TEXT_COLUMN;
  return NOWRAP_COLUMN;
}

export function Records({
  collection,
  collections,
}: {
  collection: Collection;
  collections: readonly Collection[];
}) {
  const [items, setItems] = useState<RecordModel[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string>();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [panel, setPanel] = useState<{ record?: RecordModel }>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const selection = useRowSelection(items, (record) => record.id);
  const selected = selection.selectedRows;

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(
    async (next: number) => {
      setLoading(true);
      try {
        const result = await nb
          .collection(collection.name)
          .getList(next, PAGE_SIZE, {
            filter: searchFilter(collection, query) || undefined,
            expand: expandOf(collection),
          });
        setItems((current) =>
          next === 1 ? result.items : [...current, ...result.items],
        );
        setHasMore(result.page < result.totalPages);
        setPage(next);
        setFailed(undefined);
      } catch (error) {
        if (next === 1) setItems([]);
        setFailed(error instanceof Error ? error.message : String(error));
      } finally {
        setLoading(false);
      }
    },
    [collection, query],
  );

  useEffect(() => {
    void load(1);
  }, [load]);

  const remove = async () => {
    setDeleting(true);
    const records = nb.collection(collection.name);
    const results = await Promise.allSettled(
      selected.map((record) => records.delete(record.id)),
    );
    const failures = results.filter((r) => r.status === 'rejected').length;
    if (failures === 0) {
      toaster.positive(`Deleted ${plural(selected.length)}.`, {
        key: 'record',
      });
    } else {
      toaster.negative(`Failed to delete ${plural(failures)}.`, {
        key: 'record',
      });
    }
    selection.clear();
    setConfirmDelete(false);
    setDeleting(false);
    await load(1);
  };

  const open = (next: { record?: RecordModel }) =>
    void canLeave().then((leave) => {
      if (leave) setPanel(next);
    });

  const fields = columnsOf(collection);

  return (
    <TablePage>
      <PageHeader
        variant="large"
        inset
        collapseLabelsBelow={560}
        title={collection.name}
        icon={typeIcon(collection.type)}
        search={
          <PageHeaderSearch
            value={search}
            onChange={setSearch}
            label={`Search ${collection.name}`}
            placeholder="Search or filter"
          />
        }
        actions={
          <>
            <DropdownMenu
              items={[
                {
                  label: 'Edit collection',
                  onSelect: () =>
                    navigate(
                      `/collections/${encodeURIComponent(collection.name)}/edit`,
                    ),
                },
                { label: 'Refresh', onSelect: () => void load(1) },
                {
                  label:
                    selected.length > 0
                      ? `Delete ${plural(selected.length)}`
                      : 'Delete selected',
                  disabled: selected.length === 0,
                  onSelect: () => setConfirmDelete(true),
                },
              ]}
            >
              <Button kind={KIND.secondary}>
                <PageHeaderButtonLabel
                  icon={<MoreHorizIcon size={16} />}
                  end={<ExpandMoreIcon size={16} />}
                  iconWhenCollapsedOnly
                >
                  Actions
                </PageHeaderButtonLabel>
              </Button>
            </DropdownMenu>
            <Button onClick={() => open({})}>
              <PageHeaderButtonLabel icon={<AddIcon size={16} />}>
                New record
              </PageHeaderButtonLabel>
            </Button>
          </>
        }
      />
      <SidePanelLayout
        flush
        panel={
          panel && (
            <RecordPanel
              key={panel.record?.id ?? 'new'}
              collection={collection}
              collections={collections}
              {...(panel.record && { record: panel.record })}
              onClose={() => setPanel(undefined)}
              onSaved={() => {
                setPanel(undefined);
                void load(1);
              }}
            />
          )
        }
      >
        <TableBuilder
          data={items}
          framed
          divider={DIVIDER.grid}
          pageSize={PAGE_SIZE}
          isRowSelected={(record) =>
            selection.isSelected(record) || panel?.record?.id === record.id
          }
          onRowClick={(record) => {
            if (panel?.record?.id !== record.id) open({ record });
          }}
          isLoading={loading && items.length === 0}
          hasMore={hasMore}
          onLoadMore={() => void load(page + 1)}
          emptyMessage={
            <EmptyState
              framed={false}
              icon={typeIcon(collection.type, 64)}
              title={
                failed ??
                (query ? 'No records match your search' : 'No records yet')
              }
            />
          }
        >
          <TableBuilderColumn<RecordModel>
            header={
              <SelectionCheckbox
                checked={selection.allSelected}
                isIndeterminate={selection.someSelected}
                onChange={selection.toggleAll}
                aria-label="Select all records"
              />
            }
            overrides={SELECTION_COLUMN_OVERRIDES}
          >
            {(record) => (
              <SelectionCheckbox
                checked={selection.isSelected(record)}
                onChange={() => selection.toggle(record)}
                aria-label={`Select ${record.id}`}
              />
            )}
          </TableBuilderColumn>
          <TableBuilderColumn<RecordModel> header="id" overrides={ID_COLUMN}>
            {(record) => record.id}
          </TableBuilderColumn>
          {fields.map((field) => (
            <TableBuilderColumn<RecordModel>
              key={field.id}
              header={field.name}
              overrides={overridesFor(field)}
            >
              {(record) => cell(field, record, collections)}
            </TableBuilderColumn>
          ))}
          <TableBuilderColumn<RecordModel> header="" overrides={FILLER_COLUMN}>
            {() => null}
          </TableBuilderColumn>
        </TableBuilder>
      </SidePanelLayout>
      <ConfirmModal
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${plural(selected.length)}?`}
        subtitle="They are removed for everyone. This can't be undone."
        confirmLabel="Delete"
        danger
        isLoading={deleting}
        onConfirm={() => void remove()}
      />
    </TablePage>
  );
}
