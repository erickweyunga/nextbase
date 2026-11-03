import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ArrowDownwardIcon, ArrowUpwardIcon } from '../../ui/icons/index.tsx';
import { styled, useStyletron } from '../../ui/styles/index.ts';

const shortDate = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});

export type DateFormat = (date: string) => string;

export const formatShortDate: DateFormat = (date) =>
  shortDate.format(new Date(date));

/** One bar of a bar chart, or one point of a line: a date range and its values. */
export interface ChartPoint {
  start: string;
  end: string;
  value: number;
  previous?: number;
}

/** The least a chart is tall; it grows to fill its card. */
const MIN_HEIGHT = 96;
const BAR_GAP = 2;

const Card = styled('section', ({ $theme }) => ({
  display: 'grid',
  gap: $theme.sizing.scale600,
  padding: $theme.sizing.scale700,
  borderRadius: $theme.borders.radius400,
  backgroundColor: $theme.colors.backgroundPrimary,
  border: `${$theme.borders.border200.borderWidth} solid ${$theme.borders.border200.borderColor}`,
  '@media (min-width: 560px)': {
    gridTemplateColumns: 'minmax(140px, 2fr) minmax(0, 3fr)',
  },
}));

const Summary = styled('div', ({ $theme }) => ({
  display: 'grid',
  alignContent: 'space-between',
  gap: $theme.sizing.scale500,
}));

const Title = styled('h2', ({ $theme }) => ({
  ...$theme.typography.LabelMedium,
  display: 'flex',
  alignItems: 'center',
  gap: $theme.sizing.scale300,
  margin: 0,
  color: $theme.colors.contentSecondary,
}));

const Value = styled('p', ({ $theme }) => ({
  ...$theme.typography.HeadingLarge,
  margin: 0,
  color: $theme.colors.contentPrimary,
}));

/** Where a figure will be, while it loads: as tall as the text it stands for. */
export const Placeholder = styled<'span', { $width: string }>(
  'span',
  ({ $theme, $width }) => ({
    display: 'inline-block',
    width: $width,
    maxWidth: '100%',
    height: '1em',
    verticalAlign: 'middle',
    borderRadius: $theme.borders.radius200,
    backgroundColor: $theme.colors.backgroundSecondary,
  }),
);

const Comparison = styled('p', ({ $theme }) => ({
  ...$theme.typography.ParagraphSmall,
  display: 'flex',
  alignItems: 'center',
  gap: $theme.sizing.scale200,
  margin: 0,
  color: $theme.colors.contentTertiary,
}));

const Change = styled<'span', { $tone: 'good' | 'bad' }>(
  'span',
  ({ $theme, $tone }) => ({
    ...$theme.typography.LabelSmall,
    display: 'inline-flex',
    alignItems: 'center',
    color:
      $tone === 'good'
        ? $theme.colors.contentPositive
        : $theme.colors.contentNegative,
  }),
);

const Note = styled('p', ({ $theme }) => ({
  ...$theme.typography.ParagraphSmall,
  alignSelf: 'center',
  margin: 0,
  color: $theme.colors.contentTertiary,
}));

/** "↑ 8% vs previous 7 days": green when the change is good or there is none, red when it is bad. */
export function ChangeLine({
  change,
  before,
  upIsGood = true,
}: {
  /** Null when there was nothing in the period before; it reads as no change. */
  change: number | null;
  before: string;
  upIsGood?: boolean;
}) {
  // A change that rounds to 0% reads as none: no arrow, and not bad news.
  const value = Math.round((change ?? 0) * 100) === 0 ? 0 : (change ?? 0);
  return (
    <>
      <Change $tone={value === 0 || value > 0 === upIsGood ? 'good' : 'bad'}>
        {value > 0 && <ArrowUpwardIcon size={14} aria-hidden />}
        {value < 0 && <ArrowDownwardIcon size={14} aria-hidden />}
        {Math.abs(Math.round(value * 100))}%
      </Change>
      vs {before}
    </>
  );
}

// Fills the card's height: legend on top, the plot stretching, dates at the bottom level with the comparison.
const Chart = styled('div', {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
});

const Plot = styled('div', {
  position: 'relative',
  flexGrow: 1,
  minHeight: `${MIN_HEIGHT}px`,
});

const Axis = styled('div', ({ $theme }) => ({
  ...$theme.typography.ParagraphXSmall,
  display: 'flex',
  justifyContent: 'space-between',
  marginTop: $theme.sizing.scale300,
  color: $theme.colors.contentTertiary,
}));

const Legend = styled('div', ({ $theme }) => ({
  ...$theme.typography.ParagraphXSmall,
  display: 'flex',
  gap: $theme.sizing.scale500,
  marginBottom: $theme.sizing.scale300,
  color: $theme.colors.contentTertiary,
}));

const Swatch = styled<'span', { $color: string }>(
  'span',
  ({ $theme, $color }) => ({
    display: 'inline-block',
    width: '8px',
    height: '8px',
    marginInlineEnd: $theme.sizing.scale200,
    borderRadius: '2px',
    backgroundColor: $color,
  }),
);

export const Tooltip = styled('div', ({ $theme }) => ({
  ...$theme.typography.ParagraphXSmall,
  // Placed by tooltipAt, beside the hovered mark.
  position: 'absolute',
  zIndex: 1,
  padding: `${$theme.sizing.scale200} ${$theme.sizing.scale400}`,
  borderRadius: $theme.borders.radius200,
  backgroundColor: $theme.colors.backgroundInversePrimary,
  color: $theme.colors.contentInversePrimary,
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
}));

/** The element's width as it lays out, so marks are drawn in real pixels and keep their shape. */
/** Where a tooltip sits for a mark at (`left`, `top`): beside it, kept inside the chart. */
export function tooltipAt(left: number, width: number, top: number) {
  const shift =
    left < width * 0.25 ? '0' : left > width * 0.75 ? '-100%' : '-50%';
  // Above the mark, or below it when that would leave the chart at the top.
  const vertical = top < 40 ? '8px' : 'calc(-100% - 8px)';
  return { left, top, transform: `translate(${shift}, ${vertical})` };
}

/** The element's size as it lays out, so marks are drawn in real pixels and keep their shape. */
function useSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({
        width: entry?.contentRect.width ?? 0,
        height: entry?.contentRect.height ?? 0,
      }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

export function useWidth() {
  const [ref, size] = useSize();
  return [ref, size.width] as const;
}

export const range = (p: ChartPoint, format: DateFormat = formatShortDate) =>
  p.start === p.end || format(p.start) === format(p.end)
    ? format(p.start)
    : `${format(p.start)} – ${format(p.end)}`;

/** A bar per point, with the period before beside it when given. */
const plain = (v: number) => v.toLocaleString('en-US');

function Bars({
  points,
  label,
  width,
  height: HEIGHT,
  formatDate,
}: {
  points: ChartPoint[];
  label: string;
  width: number;
  height: number;
  formatDate: DateFormat;
}) {
  const [css, theme] = useStyletron();
  const [hover, setHover] = useState<number | null>(null);
  const paired = points.some((p) => p.previous !== undefined);
  const max = Math.max(1, ...points.flatMap((p) => [p.value, p.previous ?? 0]));
  const slot = width / Math.max(points.length, 1);
  const bar = Math.max(
    2,
    Math.min(14, (slot * 0.6 - (paired ? BAR_GAP : 0)) / (paired ? 2 : 1)),
  );
  const group = bar * (paired ? 2 : 1) + (paired ? BAR_GAP : 0);
  const height = (v: number) =>
    v === 0 ? 0 : Math.max(2, (v / max) * (HEIGHT - 4));
  // A bar rounded at its top only, standing on the baseline.
  const path = (x: number, h: number) => {
    const r = Math.min(4, bar / 2, h);
    const y = HEIGHT - h;
    return `M${x},${HEIGHT}V${y + r}Q${x},${y} ${x + r},${y}H${x + bar - r}Q${x + bar},${y} ${x + bar},${y + r}V${HEIGHT}Z`;
  };
  const hovered = hover === null ? null : points[hover];
  return (
    <>
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={label}
        className={css({ display: 'block' })}
        onMouseMove={(event) => {
          const left = event.currentTarget.getBoundingClientRect().left;
          setHover(
            Math.max(
              0,
              Math.min(
                points.length - 1,
                Math.floor((event.clientX - left) / Math.max(slot, 1)),
              ),
            ),
          );
        }}
        onMouseLeave={() => setHover(null)}
      >
        <line
          x1={0}
          x2={width}
          y1={HEIGHT - 0.5}
          y2={HEIGHT - 0.5}
          stroke={theme.colors.borderOpaque}
        />
        {points.map((p, i) => {
          const x = i * slot + (slot - group) / 2;
          return (
            <g key={p.start} opacity={hover === null || hover === i ? 1 : 0.5}>
              {paired && height(p.previous ?? 0) > 0 && (
                <path
                  d={path(x, height(p.previous ?? 0))}
                  fill={theme.colors.borderAccentLight}
                />
              )}
              {height(p.value) > 0 && (
                <path
                  d={path(paired ? x + bar + BAR_GAP : x, height(p.value))}
                  fill={theme.colors.backgroundAccent}
                />
              )}
            </g>
          );
        })}
      </svg>
      {hovered && hover !== null && (
        <Tooltip
          style={tooltipAt(
            hover * slot + slot / 2,
            width,
            HEIGHT - height(Math.max(hovered.value, hovered.previous ?? 0)),
          )}
        >
          {range(hovered, formatDate)}: {hovered.value.toLocaleString('en-US')}
          {paired &&
            ` (before: ${(hovered.previous ?? 0).toLocaleString('en-US')})`}
        </Tooltip>
      )}
    </>
  );
}

/** A 2px line through the points, with a crosshair and marker where the pointer is. */
function Line({
  points,
  label,
  width,
  height: HEIGHT,
  format,
  formatDate,
}: {
  points: ChartPoint[];
  label: string;
  width: number;
  height: number;
  format: (value: number) => string;
  formatDate: DateFormat;
}) {
  const [css, theme] = useStyletron();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...points.map((p) => p.value));
  const step = points.length > 1 ? width / (points.length - 1) : 0;
  const x = (i: number) => (points.length > 1 ? i * step : width / 2);
  const y = (v: number) => HEIGHT - 4 - (v / max) * (HEIGHT - 8);
  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.value)}`)
    .join('');
  const hovered = hover === null ? null : points[hover];
  return (
    <>
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={label}
        className={css({ display: 'block', overflow: 'visible' })}
        onMouseMove={(event) => {
          const left = event.currentTarget.getBoundingClientRect().left;
          setHover(
            Math.max(
              0,
              Math.min(
                points.length - 1,
                Math.round((event.clientX - left) / Math.max(step, 1)),
              ),
            ),
          );
        }}
        onMouseLeave={() => setHover(null)}
      >
        <line
          x1={0}
          x2={width}
          y1={HEIGHT - 0.5}
          y2={HEIGHT - 0.5}
          stroke={theme.colors.borderOpaque}
        />
        <path
          d={d}
          fill="none"
          stroke={theme.colors.backgroundAccent}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {hovered && hover !== null && (
          <>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={0}
              y2={HEIGHT}
              stroke={theme.colors.borderOpaque}
            />
            <circle
              cx={x(hover)}
              cy={y(hovered.value)}
              r={4}
              fill={theme.colors.backgroundAccent}
              stroke={theme.colors.backgroundPrimary}
            />
          </>
        )}
        <rect x={0} y={0} width={width} height={HEIGHT} fill="transparent" />
      </svg>
      {hovered && hover !== null && (
        <Tooltip style={tooltipAt(x(hover), width, y(hovered.value))}>
          {range(hovered, formatDate)}: {format(hovered.value)}
        </Tooltip>
      )}
    </>
  );
}

/** A figure with its change on the period before, and a chart of it over the period. */
export function ActivityCard({
  icon,
  title,
  value,
  change,
  before,
  chart,
  points = [],
  upIsGood = true,
  note,
  format = plain,
  formatDate = formatShortDate,
}: {
  icon: ReactNode;
  title: string;
  /** Left out while the figures load: the card shows with placeholders in their place. */
  value?: string;
  /** The change on the period before, as a fraction; null when there was nothing before. */
  change?: number | null;
  /** The period before, e.g. "previous 30 days". */
  before: string;
  /** Without a chart, the note explains the figure in its place. */
  chart?: 'bars' | 'line';
  points?: ChartPoint[];
  /** False when a rise is bad news, e.g. more inactive customers. */
  upIsGood?: boolean;
  note?: ReactNode;
  /** How the line's values read on hover, e.g. as a percentage. */
  format?: (value: number) => string;
  /** How the points' dates read, e.g. with the hour for hourly points. */
  formatDate?: DateFormat;
}) {
  const [css, theme] = useStyletron();
  const [ref, size] = useSize();
  const loading = value === undefined;
  // Bars always come with the period before, so the legend is there before they are.
  const paired =
    chart === 'bars' &&
    (loading || points.some((p) => p.previous !== undefined));
  const first = points[0];
  const last = points.at(-1);
  const label =
    first && last
      ? `${title} from ${formatDate(first.start)} to ${formatDate(last.end)}`
      : title;
  return (
    <Card aria-busy={loading || undefined}>
      <Summary>
        <div className={css({ display: 'grid', gap: theme.sizing.scale500 })}>
          <Title>
            {icon}
            {title}
          </Title>
          <Value>{loading ? <Placeholder $width="96px" /> : value}</Value>
        </div>
        <Comparison>
          {loading ? (
            <Placeholder $width="140px" />
          ) : (
            <ChangeLine
              change={change ?? null}
              before={before}
              upIsGood={upIsGood}
            />
          )}
        </Comparison>
      </Summary>
      {!chart ? (
        <Note>{note}</Note>
      ) : (
        <Chart>
          {paired && (
            <Legend>
              <span>
                <Swatch $color={theme.colors.backgroundAccent} />
                This period
              </span>
              <span>
                <Swatch $color={theme.colors.borderAccentLight} />
                The {before}
              </span>
            </Legend>
          )}
          <Plot ref={ref}>
            {size.width > 0 &&
              (chart === 'bars' ? (
                <Bars
                  points={points}
                  label={label}
                  width={size.width}
                  height={Math.max(size.height, MIN_HEIGHT)}
                  formatDate={formatDate}
                />
              ) : (
                <Line
                  points={points}
                  label={label}
                  width={size.width}
                  height={Math.max(size.height, MIN_HEIGHT)}
                  format={format}
                  formatDate={formatDate}
                />
              ))}
          </Plot>
          <Axis aria-hidden>
            <span>{first && formatDate(first.start)}</span>
            <span>{last && formatDate(last.end)}</span>
          </Axis>
          {note && <Note>{note}</Note>}
        </Chart>
      )}
    </Card>
  );
}
