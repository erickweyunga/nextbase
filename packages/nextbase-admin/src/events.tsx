import { filter, type LogModel } from '@nextbasejs/client';
import type { Theme } from 'baseui';
import { mergeOverrides } from 'baseui/helpers/overrides';
import {
  Fragment,
  type ReactNode,
  type UIEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { nb } from './api.ts';
import { DATE_FORMAT, NOWRAP_COLUMN } from './components/grid-columns.ts';
import { TablePage } from './components/page.tsx';
import { Accordion, Panel } from './ui/accordion/index.ts';
import { Button, KIND, SHAPE } from './ui/button/index.ts';
import { EmptyState } from './ui/empty-state/index.ts';
import {
  ContentCopyIcon,
  EventListIcon,
  RefreshIcon,
} from './ui/icons/index.tsx';
import { PageHeader, PageHeaderSearch } from './ui/page-header/index.ts';
import { SidePanel, SidePanelLayout } from './ui/side-panel/index.ts';
import { SIZE as SPINNER_SIZE, Spinner } from './ui/spinner/index.ts';
import { styled } from './ui/styles/index.ts';
import { Switch } from './ui/switch/index.ts';
import {
  columnOverrides,
  DIVIDER,
  TableBuilder,
  TableBuilderColumn,
} from './ui/table/index.ts';
import { toaster } from './ui/toast/index.ts';

const PAGE_SIZE = 50;

const LOAD_AHEAD = 400;

const MESSAGE_COLUMN = columnOverrides({ fill: true });
const CENTERED_CELL = { style: { textAlign: 'center' } } as const;
const STATUS_COLUMN = mergeOverrides(
  columnOverrides({ width: '56px', nowrap: true }),
  { TableHeadCell: CENTERED_CELL, TableBodyCell: CENTERED_CELL },
);
const DURATION_COLUMN = columnOverrides({
  width: '80px',
  align: 'end',
  nowrap: true,
});

const LEVELS: Record<number, string> = {
  [-4]: 'DEBUG',
  0: 'INFO',
  4: 'WARN',
  8: 'ERROR',
};

const FILTER_SYNTAX = /[=!<>~]/;

const NOT_SUPERUSERS = 'data.auth != "_superusers"';

function levelLabel(level: number): string {
  return `${LEVELS[level] ?? 'LEVEL'} (${level})`;
}

function show(key: string, value: unknown): string {
  if (key === 'execTime' && typeof value === 'number') {
    return `${value.toFixed(2)}ms`;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function eventsFilter(query: string, superusers: boolean): string {
  const q = query.trim();
  const search =
    q === '' || FILTER_SYNTAX.test(q) ? q : filter('message ~ {:q}', { q });
  const parts = [search, superusers ? '' : NOT_SUPERUSERS].filter(Boolean);
  return parts.length > 1
    ? parts.map((p) => `(${p})`).join(' && ')
    : parts.join('');
}

const Toolbar = styled('div', ({ $theme }) => ({
  display: 'flex',
  alignItems: 'center',
  gap: $theme.sizing.scale500,
}));

const REQUEST_KEYS = [
  'method',
  'url',
  'status',
  'execTime',
  'auth',
  'authId',
  'impersonatedBy',
  'ip',
  'referer',
  'userAgent',
] as const;

const ERROR_KEYS = ['error', 'details', 'stack'] as const;

const REQUEST_LABELS: Record<string, string> = {
  execTime: 'Duration',
  authId: 'Auth id',
  impersonatedBy: 'Impersonated by',
  ip: 'IP',
  url: 'URL',
  userAgent: 'User agent',
};

function rowTint(level: number, $theme: Theme): string | undefined {
  if (level >= 8) return $theme.colors.backgroundNegativeLight;
  if (level >= 4) return $theme.colors.backgroundWarningLight;
  return undefined;
}

const ErrorBody = styled('div', ({ $theme }) => ({
  display: 'grid',
  gap: $theme.sizing.scale500,
}));

async function copyDetails(log: LogModel): Promise<void> {
  try {
    await navigator.clipboard.writeText(JSON.stringify(log, null, 2));
    toaster.positive('Copied the details.', { key: 'event' });
  } catch {
    toaster.negative('Failed to copy the details.', { key: 'event' });
  }
}

const More = styled('div', ({ $theme }) => ({
  display: 'flex',
  justifyContent: 'center',
  paddingBlock: $theme.sizing.scale300,
}));

const Details = styled('dl', ({ $theme }) => ({
  ...$theme.typography.ParagraphSmall,
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 3fr)',
  gap: `${$theme.sizing.scale200} ${$theme.sizing.scale500}`,
  margin: 0,
}));

const COMPACT_ACCORDION = {
  Content: {
    style: ({ $theme }: { $theme: Theme }) => ({
      paddingTop: $theme.sizing.scale300,
      paddingBottom: $theme.sizing.scale400,
    }),
  },
};

const DetailName = styled('dt', ({ $theme }) => ({
  color: $theme.colors.contentTertiary,
  overflowWrap: 'anywhere',
}));

const DetailValue = styled('dd', { margin: 0, overflowWrap: 'anywhere' });

const Code = styled('pre', ({ $theme }) => ({
  ...$theme.typography.MonoParagraphXSmall,
  margin: 0,
  maxWidth: '100%',
  overflowX: 'auto',
  whiteSpace: 'pre',
}));

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function label(key: string): string {
  return REQUEST_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

function rendered(key: string, value: unknown): ReactNode {
  if (key === 'stack' || (typeof value === 'object' && value !== null)) {
    return (
      <Code>
        {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
      </Code>
    );
  }
  return show(key, value);
}

function DetailList({ values }: { values: [string, ReactNode][] }) {
  return (
    <Details>
      {values.map(([name, value]) => (
        <Fragment key={name}>
          <DetailName>{name}</DetailName>
          <DetailValue>{value}</DetailValue>
        </Fragment>
      ))}
    </Details>
  );
}

function dataRows(data: Record<string, unknown>, keys: readonly string[]) {
  return keys.map((key): [string, ReactNode] => [
    label(key),
    rendered(key, data[key]),
  ]);
}

function EventPanel({ log, onClose }: { log: LogModel; onClose: () => void }) {
  const known = new Set<string>(['type', ...REQUEST_KEYS, ...ERROR_KEYS]);
  const request = REQUEST_KEYS.filter((key) => present(log.data[key]));
  const errors = ERROR_KEYS.filter((key) => present(log.data[key]));
  const other = Object.keys(log.data).filter(
    (key) => !known.has(key) && present(log.data[key]),
  );
  const overview: [string, ReactNode][] = [
    ['Level', levelLabel(log.level)],
    ['Message', log.message],
    ['Created', DATE_FORMAT.format(new Date(log.created))],
    ...(present(log.data.type)
      ? [['Type', String(log.data.type)] as [string, ReactNode]]
      : []),
    ['Id', log.id],
  ];
  return (
    <SidePanel
      title="Event"
      icon={<EventListIcon size={20} />}
      onClose={onClose}
    >
      <Accordion
        key={log.id}
        initialState={{ expanded: ['overview', 'request', 'error', 'other'] }}
        overrides={COMPACT_ACCORDION}
      >
        <Panel key="overview" title="Overview">
          <DetailList values={overview} />
        </Panel>
        {request.length > 0 && (
          <Panel key="request" title="Request">
            <DetailList values={dataRows(log.data, request)} />
          </Panel>
        )}
        {errors.length > 0 && (
          <Panel key="error" title="Error">
            <ErrorBody>
              <DetailList values={dataRows(log.data, errors)} />
              <Button
                type="button"
                kind={KIND.secondary}
                startEnhancer={<ContentCopyIcon size={16} />}
                onClick={() => void copyDetails(log)}
              >
                Copy details
              </Button>
            </ErrorBody>
          </Panel>
        )}
        {other.length > 0 && (
          <Panel key="other" title="Other data">
            <DetailList values={dataRows(log.data, other)} />
          </Panel>
        )}
      </Accordion>
    </SidePanel>
  );
}

export function Events({ icon }: { icon: ReactNode }) {
  const [items, setItems] = useState<LogModel[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string>();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [superusers, setSuperusers] = useState(false);
  const [open, setOpen] = useState<LogModel>();

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const busy = useRef(false);

  const load = useCallback(
    async (next: number) => {
      if (next > 1 && busy.current) return;
      busy.current = true;
      setLoading(true);
      try {
        const result = await nb.logs.getList(next, PAGE_SIZE, {
          filter: eventsFilter(query, superusers) || undefined,
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
        busy.current = false;
        setLoading(false);
      }
    },
    [query, superusers],
  );

  useEffect(() => {
    void load(1);
  }, [load]);

  return (
    <TablePage>
      <PageHeader
        variant="large"
        inset
        collapseLabelsBelow={560}
        title="Events"
        icon={icon}
        search={
          <PageHeaderSearch
            value={search}
            onChange={setSearch}
            label="Search events"
            placeholder="Search or filter"
          />
        }
        actions={
          <Toolbar>
            <Switch
              checked={superusers}
              onChange={(event) => setSuperusers(event.currentTarget.checked)}
            >
              Include superusers
            </Switch>
            <Button
              kind={KIND.secondary}
              shape={SHAPE.square}
              aria-label="Refresh"
              onClick={() => void load(1)}
            >
              <RefreshIcon size={16} />
            </Button>
          </Toolbar>
        }
      />
      <SidePanelLayout
        flush
        panel={
          open && (
            <EventPanel
              key={open.id}
              log={open}
              onClose={() => setOpen(undefined)}
            />
          )
        }
      >
        <TableBuilder
          data={items}
          framed
          divider={DIVIDER.grid}
          pageSize={Number.MAX_SAFE_INTEGER}
          isLoading={loading && items.length === 0}
          onRowClick={setOpen}
          overrides={{
            TableBodyRow: {
              style: ({ $theme, $row }: { $theme: Theme; $row: LogModel }) => {
                const tint =
                  $row.id === open?.id
                    ? undefined
                    : rowTint($row.level, $theme);
                return tint ? { backgroundColor: tint } : {};
              },
            },
            Root: {
              props: {
                onScroll: (event: UIEvent<HTMLElement>) => {
                  const { scrollTop, scrollHeight, clientHeight } =
                    event.currentTarget;
                  if (
                    hasMore &&
                    scrollHeight - scrollTop - clientHeight < LOAD_AHEAD
                  ) {
                    void load(page + 1);
                  }
                },
              },
            },
          }}
          isRowSelected={(log) => log.id === open?.id}
          emptyMessage={
            <EmptyState
              framed={false}
              icon={icon}
              title={
                failed ??
                (query ? 'No events match your search' : 'No events yet')
              }
            />
          }
        >
          <TableBuilderColumn<LogModel> header="Time" overrides={NOWRAP_COLUMN}>
            {(log) => DATE_FORMAT.format(new Date(log.created))}
          </TableBuilderColumn>
          <TableBuilderColumn<LogModel>
            header="Endpoint"
            overrides={MESSAGE_COLUMN}
          >
            {(log) => log.message}
          </TableBuilderColumn>
          <TableBuilderColumn<LogModel>
            header="Status"
            overrides={STATUS_COLUMN}
          >
            {(log) =>
              present(log.data.status) ? String(log.data.status) : null
            }
          </TableBuilderColumn>
          <TableBuilderColumn<LogModel>
            header="Duration"
            overrides={DURATION_COLUMN}
          >
            {(log) =>
              present(log.data.execTime)
                ? show('execTime', log.data.execTime)
                : null
            }
          </TableBuilderColumn>
        </TableBuilder>
        {loading && items.length > 0 && (
          <More>
            <Spinner $size={SPINNER_SIZE.small} />
          </More>
        )}
      </SidePanelLayout>
    </TablePage>
  );
}
