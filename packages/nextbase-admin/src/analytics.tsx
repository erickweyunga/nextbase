import { filter, type LogStat } from '@nextbasejs/client';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { nb } from './api.ts';
import {
  ActivityCard,
  type ChartPoint,
} from './components/charts/activity-card.tsx';
import { TrendChart } from './components/charts/trend-chart.tsx';
import { desktopGutter } from './components/page.tsx';
import { eventsFilter } from './events.tsx';
import { Button, KIND } from './ui/button/index.ts';
import { DropdownMenu } from './ui/dropdown-menu/index.ts';
import { EmptyState } from './ui/empty-state/index.ts';
import {
  CalendarMonthIcon,
  ErrorIcon,
  ExpandMoreIcon,
  PercentIcon,
  WarningIcon,
} from './ui/icons/index.tsx';
import { PageHeader, PageHeaderButtonLabel } from './ui/page-header/index.ts';
import { DESKTOP } from './ui/sidebar/index.ts';
import { styled } from './ui/styles/index.ts';

type Interval = 'hour' | 'day';

interface Period {
  id: string;
  label: string;
  before: string;
  interval: Interval;
  count: number;
}

const PERIODS: readonly Period[] = [
  {
    id: '24h',
    label: 'Last 24 hours',
    before: 'previous 24 hours',
    interval: 'hour',
    count: 24,
  },
  {
    id: '3d',
    label: 'Last 3 days',
    before: 'previous 3 days',
    interval: 'hour',
    count: 72,
  },
  {
    id: '7d',
    label: 'Last 7 days',
    before: 'previous 7 days',
    interval: 'day',
    count: 7,
  },
];

const MAX_BARS = 12;

const HOUR = 60 * 60 * 1000;

const ERRORS = 'level >= 8';
const WARNINGS = 'level >= 4 && level < 8';

const HOURLY = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
});
const DAILY = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});

const COUNT = new Intl.NumberFormat();

interface Point {
  start: string;
  value: number;
  previous: number;
}

interface Activity {
  requests: Point[];
  errors: Point[];
  warnings: Point[];
}

export function boundaries(period: Period, now: Date): Date[] {
  const end = new Date(now);
  if (period.interval === 'hour') {
    end.setMinutes(0, 0, 0);
    end.setTime(end.getTime() + HOUR);
  } else {
    end.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() + 1);
  }
  return Array.from({ length: period.count * 2 + 1 }, (_, i) => {
    const date = new Date(end);
    const back = period.count * 2 - i;
    if (period.interval === 'hour') date.setTime(end.getTime() - back * HOUR);
    else date.setDate(end.getDate() - back);
    return date;
  });
}

export function series(
  stats: readonly LogStat[],
  edges: readonly Date[],
): Point[] {
  const counts = new Array<number>(edges.length - 1).fill(0);
  for (const stat of stats) {
    const at = Date.parse(stat.date);
    for (let i = 0; i < counts.length; i += 1) {
      const from = edges[i]?.getTime() ?? 0;
      const to = edges[i + 1]?.getTime() ?? 0;
      if (at >= from && at < to) {
        counts[i] = (counts[i] ?? 0) + stat.total;
        break;
      }
    }
  }
  const half = counts.length / 2;
  return counts.slice(half).map((value, i) => ({
    start: (edges[half + i] ?? new Date()).toISOString(),
    value,
    previous: counts[i] ?? 0,
  }));
}

function total(points: readonly Point[], key: 'value' | 'previous') {
  return points.reduce((sum, p) => sum + p[key], 0);
}

function change(current: number, previous: number): number | null {
  return previous === 0 ? null : (current - previous) / previous;
}

function rate(errors: number, requests: number): number {
  return requests === 0 ? 0 : errors / requests;
}

function bars(points: readonly Point[]): ChartPoint[] {
  const size = Math.ceil(points.length / MAX_BARS);
  const out: ChartPoint[] = [];
  for (let i = 0; i < points.length; i += size) {
    const group = points.slice(i, i + size);
    const first = group[0];
    const last = group.at(-1);
    if (!first || !last) continue;
    out.push({
      start: first.start,
      end: last.start,
      value: total(group, 'value'),
      previous: total(group, 'previous'),
    });
  }
  return out;
}

function line(
  points: readonly Point[],
  value: (p: Point, i: number) => number,
): ChartPoint[] {
  return points.map((p, i) => ({
    start: p.start,
    end: p.start,
    value: value(p, i),
  }));
}

const Column = styled('div', ({ $theme }) => ({
  boxSizing: 'border-box',
  width: '100%',
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr)',
  alignContent: 'start',
  gap: $theme.sizing.scale300,
  paddingInline: $theme.sizing.scale800,
  paddingBottom: $theme.sizing.scale1000,
  [DESKTOP]: desktopGutter($theme),
}));

const Cards = styled('div', ({ $theme }) => ({
  display: 'grid',
  gap: $theme.sizing.scale600,
  '@media (min-width: 1100px)': {
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  },
}));

export function Analytics({ icon }: { icon: ReactNode }) {
  const [period, setPeriod] = useState<Period>(PERIODS[0] as Period);
  const [activity, setActivity] = useState<Activity>();
  const [failed, setFailed] = useState<string>();

  const load = useCallback(async () => {
    const edges = boundaries(period, new Date());
    const since = filter('created >= {:since}', { since: edges[0] });
    const stats = (where: string) =>
      nb.logs.getStats({
        filter: [since, eventsFilter('', false), where]
          .filter(Boolean)
          .map((part) => `(${part})`)
          .join(' && '),
      });
    try {
      const [requests, errors, warnings] = await Promise.all([
        stats(''),
        stats(ERRORS),
        stats(WARNINGS),
      ]);
      setActivity({
        requests: series(requests, edges),
        errors: series(errors, edges),
        warnings: series(warnings, edges),
      });
      setFailed(undefined);
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
    }
  }, [period]);

  useEffect(() => {
    void load();
  }, [load]);

  const formatDate = (date: string) =>
    (period.interval === 'hour' ? HOURLY : DAILY).format(new Date(date));
  const requests = activity && total(activity.requests, 'value');
  const previousRequests = activity && total(activity.requests, 'previous');
  const errors = activity && total(activity.errors, 'value');
  const previousErrors = activity && total(activity.errors, 'previous');
  const warnings = activity && total(activity.warnings, 'value');
  const previousWarnings = activity && total(activity.warnings, 'previous');
  const first = activity?.requests[0];
  const last = activity?.requests.at(-1);

  return (
    <Column>
      <PageHeader
        variant="large"
        inset
        collapseLabelsBelow={560}
        icon={icon}
        title="Analytics"
        actions={
          <DropdownMenu
            items={PERIODS.map((p) => ({
              label: p.label,
              onSelect: () => setPeriod(p),
            }))}
          >
            <Button
              kind={KIND.secondary}
              aria-label={`Period: ${period.label}`}
            >
              <PageHeaderButtonLabel
                icon={<CalendarMonthIcon size={16} />}
                end={<ExpandMoreIcon size={16} />}
              >
                {period.label}
              </PageHeaderButtonLabel>
            </Button>
          </DropdownMenu>
        }
      />
      {failed ? (
        <EmptyState icon={icon} title={failed} />
      ) : (
        <Cards>
          <ActivityCard
            icon={icon}
            title="Requests"
            value={requests === undefined ? undefined : COUNT.format(requests)}
            change={activity && change(requests ?? 0, previousRequests ?? 0)}
            before={period.before}
            chart="bars"
            points={activity && bars(activity.requests)}
            formatDate={formatDate}
          />
          <ActivityCard
            icon={<ErrorIcon size={16} aria-hidden />}
            title="Errors"
            value={errors === undefined ? undefined : COUNT.format(errors)}
            change={activity && change(errors ?? 0, previousErrors ?? 0)}
            before={period.before}
            upIsGood={false}
            chart="line"
            points={activity && line(activity.errors, (p) => p.value)}
            formatDate={formatDate}
          />
          <ActivityCard
            icon={<WarningIcon size={16} aria-hidden />}
            title="Warnings"
            value={warnings === undefined ? undefined : COUNT.format(warnings)}
            change={activity && change(warnings ?? 0, previousWarnings ?? 0)}
            before={period.before}
            upIsGood={false}
            chart="line"
            points={activity && line(activity.warnings, (p) => p.value)}
            formatDate={formatDate}
          />
          <ActivityCard
            icon={<PercentIcon size={16} aria-hidden />}
            title="Error rate"
            value={
              activity &&
              `${Math.round(rate(errors ?? 0, requests ?? 0) * 1000) / 10}%`
            }
            change={
              activity &&
              change(
                rate(errors ?? 0, requests ?? 0),
                rate(previousErrors ?? 0, previousRequests ?? 0),
              )
            }
            before={period.before}
            upIsGood={false}
            chart="line"
            points={
              activity &&
              line(activity.errors, (p, i) =>
                Math.round(
                  rate(p.value, activity.requests[i]?.value ?? 0) * 100,
                ),
              )
            }
            format={(v) => `${v}%`}
            formatDate={formatDate}
          />
          <TrendChart
            icon={icon}
            title="Requests over time"
            value={requests === undefined ? undefined : COUNT.format(requests)}
            change={activity && change(requests ?? 0, previousRequests ?? 0)}
            before={period.before}
            periodLabel={
              first && last
                ? `${formatDate(first.start)} – ${formatDate(last.start)}`
                : undefined
            }
            previousLabel={period.before.replace(/^p/, 'P')}
            points={activity?.requests.map((p) => ({
              start: p.start,
              end: p.start,
              value: p.value,
              previous: p.previous,
            }))}
            formatDate={formatDate}
          />
        </Cards>
      )}
    </Column>
  );
}
