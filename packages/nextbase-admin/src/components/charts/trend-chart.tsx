import { type ReactNode, useState } from 'react';
import { styled, useStyletron } from '../../ui/styles/index.ts';
import {
  ChangeLine,
  type ChartPoint,
  type DateFormat,
  formatShortDate,
  Placeholder,
  range,
  Tooltip,
  tooltipAt,
  useWidth,
} from './activity-card.tsx';

const HEIGHT = 220;
const AXIS_WIDTH = 40;
const TICKS = 4;

const Card = styled('section', ({ $theme }) => ({
  display: 'grid',
  gap: $theme.sizing.scale600,
  padding: $theme.sizing.scale700,
  borderRadius: $theme.borders.radius400,
  backgroundColor: $theme.colors.backgroundPrimary,
  border: `${$theme.borders.border200.borderWidth} solid ${$theme.borders.border200.borderColor}`,
  '@media (min-width: 1100px)': { gridColumn: '1 / -1' },
}));

const Head = styled('div', ({ $theme }) => ({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-end',
  justifyContent: 'space-between',
  gap: $theme.sizing.scale500,
}));

const Title = styled('h2', ({ $theme }) => ({
  ...$theme.typography.LabelMedium,
  display: 'flex',
  alignItems: 'center',
  gap: $theme.sizing.scale300,
  margin: 0,
  marginBottom: $theme.sizing.scale400,
  color: $theme.colors.contentSecondary,
}));

const Figure = styled('p', ({ $theme }) => ({
  ...$theme.typography.ParagraphSmall,
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  gap: $theme.sizing.scale400,
  margin: 0,
  color: $theme.colors.contentTertiary,
}));

const Value = styled('span', ({ $theme }) => ({
  ...$theme.typography.HeadingLarge,
  color: $theme.colors.contentPrimary,
}));

const Keys = styled('div', ({ $theme }) => ({
  display: 'flex',
  flexWrap: 'wrap',
  gap: $theme.sizing.scale300,
}));

const Key = styled('span', ({ $theme }) => ({
  ...$theme.typography.ParagraphXSmall,
  display: 'inline-flex',
  alignItems: 'center',
  gap: $theme.sizing.scale300,
  padding: `${$theme.sizing.scale200} ${$theme.sizing.scale400}`,
  borderRadius: $theme.borders.radius300,
  backgroundColor: $theme.colors.backgroundSecondary,
  color: $theme.colors.contentSecondary,
}));

const Plot = styled('div', { position: 'relative', minWidth: 0 });

/** The smallest step of 1, 2 or 5 times a power of ten that fits the scale in TICKS steps. */
function niceStep(max: number) {
  const raw = Math.max(max, 1) / TICKS;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw;
  return Math.max(1, step);
}

const compact = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/**
 * A count over a period, this period against the one before: a line with a light area under it, the period
 * before dashed, a scale on the left and dates along the bottom.
 */
export function TrendChart({
  icon,
  title,
  value,
  change,
  before,
  periodLabel,
  previousLabel,
  points: given,
  formatDate = formatShortDate,
}: {
  icon: ReactNode;
  title: string;
  /** Left out while the figures load: the card shows with placeholders, and an empty plot of its size. */
  value?: string;
  change?: number | null;
  /** The period before, e.g. "previous 30 days". */
  before: string;
  /** The two periods' dates, for the legend. */
  periodLabel?: string;
  previousLabel?: string;
  points?: ChartPoint[];
  /** How the points' dates read, e.g. with the hour for hourly points. */
  formatDate?: DateFormat;
}) {
  const loading = value === undefined || !given;
  const points = given ?? [];
  const [css, theme] = useStyletron();
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const plotWidth = Math.max(width - AXIS_WIDTH, 0);
  const step = niceStep(
    Math.max(...points.flatMap((p) => [p.value, p.previous ?? 0])),
  );
  const top = step * TICKS;
  const x = (i: number) =>
    AXIS_WIDTH +
    (points.length > 1 ? (i * plotWidth) / (points.length - 1) : plotWidth / 2);
  const y = (v: number) => 8 + (HEIGHT - 16) * (1 - v / top);
  const line = (values: number[]) =>
    values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(v)}`).join('');
  const current = line(points.map((p) => p.value));
  const area = `${current}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z`;
  const previous = line(points.map((p) => p.previous ?? 0));
  // Dates along the bottom: about one every 80px, always the first and last.
  // Each date takes about 7px a character, so the labels never run into each other.
  const labelWidth =
    Math.max(0, ...points.map((p) => formatDate(p.start).length)) * 7 + 24;
  const every = Math.max(
    1,
    Math.ceil(points.length / Math.max(2, Math.floor(plotWidth / labelWidth))),
  );
  const lastIndex = points.length - 1;
  const dated = points.flatMap((point, i) =>
    i === lastIndex || (i % every === 0 && (i === 0 || lastIndex - i >= every))
      ? [{ point, i }]
      : [],
  );
  const hovered = hover === null ? null : points[hover];

  return (
    <Card aria-busy={loading || undefined}>
      <Head>
        <div>
          <Title>
            {icon}
            {title}
          </Title>
          <Figure>
            {loading ? (
              <>
                <Value>
                  <Placeholder $width="96px" />
                </Value>
                <Placeholder $width="140px" />
              </>
            ) : (
              <>
                <Value>{value}</Value>
                <ChangeLine change={change ?? null} before={before} />
              </>
            )}
          </Figure>
        </div>
        <Keys aria-label="Legend">
          <Key>
            <svg width={16} height={8} aria-hidden>
              <line
                x1={0}
                x2={16}
                y1={4}
                y2={4}
                stroke={theme.colors.contentTertiary}
                strokeWidth={2}
                strokeDasharray="4 3"
              />
            </svg>
            {previousLabel ?? <Placeholder $width="88px" />}
          </Key>
          <Key>
            <svg width={16} height={8} aria-hidden>
              <line
                x1={0}
                x2={16}
                y1={4}
                y2={4}
                stroke={theme.colors.backgroundAccent}
                strokeWidth={2}
              />
            </svg>
            {periodLabel ?? <Placeholder $width="88px" />}
          </Key>
        </Keys>
      </Head>
      <Plot ref={ref} style={loading ? { height: HEIGHT + 24 } : undefined}>
        {width > 0 && !loading && (
          <svg
            width={width}
            height={HEIGHT + 24}
            role="img"
            aria-label={`${title}, ${periodLabel} against ${previousLabel}`}
            className={css({ display: 'block', overflow: 'visible' })}
            onMouseMove={(event) => {
              const left =
                event.currentTarget.getBoundingClientRect().left + AXIS_WIDTH;
              const ratio = (event.clientX - left) / Math.max(plotWidth, 1);
              setHover(
                Math.max(
                  0,
                  Math.min(
                    points.length - 1,
                    Math.round(ratio * (points.length - 1)),
                  ),
                ),
              );
            }}
            onMouseLeave={() => setHover(null)}
          >
            {Array.from({ length: TICKS + 1 }, (_, i) => i * step).map(
              (tick) => (
                <g key={tick}>
                  <line
                    x1={AXIS_WIDTH}
                    x2={width}
                    y1={y(tick)}
                    y2={y(tick)}
                    stroke={theme.colors.borderOpaque}
                    strokeWidth={1}
                  />
                  <text
                    x={AXIS_WIDTH - 8}
                    y={y(tick)}
                    textAnchor="end"
                    dominantBaseline="middle"
                    fill={theme.colors.contentTertiary}
                    fontSize={12}
                  >
                    {compact.format(tick)}
                  </text>
                </g>
              ),
            )}
            <path
              d={area}
              fill={theme.colors.backgroundAccent}
              fillOpacity={0.08}
            />
            <path
              d={previous}
              fill="none"
              stroke={theme.colors.contentTertiary}
              strokeWidth={2}
              strokeDasharray="4 3"
              strokeLinejoin="round"
            />
            <path
              d={current}
              fill="none"
              stroke={theme.colors.backgroundAccent}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {dated.map(({ point, i }) => (
              <text
                key={point.start}
                x={x(i)}
                y={HEIGHT + 18}
                textAnchor={
                  i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'
                }
                fill={theme.colors.contentTertiary}
                fontSize={12}
              >
                {formatDate(point.start)}
              </text>
            ))}
            {hovered && hover !== null && (
              <>
                <line
                  x1={x(hover)}
                  x2={x(hover)}
                  y1={8}
                  y2={HEIGHT - 8}
                  stroke={theme.colors.borderOpaque}
                />
                <circle
                  cx={x(hover)}
                  cy={y(hovered.value)}
                  r={4}
                  fill={theme.colors.backgroundAccent}
                  stroke={theme.colors.backgroundPrimary}
                  strokeWidth={2}
                />
              </>
            )}
          </svg>
        )}
        {hovered && hover !== null && (
          <Tooltip
            style={tooltipAt(
              x(hover),
              width,
              y(Math.max(hovered.value, hovered.previous ?? 0)),
            )}
          >
            {range(hovered, formatDate)}:{' '}
            {hovered.value.toLocaleString('en-US')} (before:{' '}
            {(hovered.previous ?? 0).toLocaleString('en-US')})
          </Tooltip>
        )}
      </Plot>
    </Card>
  );
}
