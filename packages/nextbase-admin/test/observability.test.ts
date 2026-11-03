// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://localhost:3001/api/nextbase/_/"}
import { describe, expect, it } from 'vitest';
import { boundaries, series } from '../src/analytics.tsx';
import { eventsFilter } from '../src/events.tsx';

describe('the events filter', () => {
  it('leaves out superusers unless asked', () => {
    expect(eventsFilter('', false)).toBe('data.auth != "_superusers"');
    expect(eventsFilter('', true)).toBe('');
  });

  it('searches messages for plain words', () => {
    expect(eventsFilter('posts', true)).toBe('message ~ "posts"');
    expect(eventsFilter('posts', false)).toBe(
      '(message ~ "posts") && (data.auth != "_superusers")',
    );
  });

  it('passes a filter expression through', () => {
    expect(eventsFilter('level >= 8', true)).toBe('level >= 8');
  });
});

describe('the analytics buckets', () => {
  const day = {
    id: '24h',
    label: 'Last 24 hours',
    before: 'previous 24 hours',
    interval: 'hour' as const,
    count: 2,
  };

  it('ends at the next hour and reaches as far back again', () => {
    const edges = boundaries(day, new Date('2026-11-02T10:30:00.000Z'));
    expect(edges.map((d) => d.toISOString())).toEqual([
      '2026-11-02T07:00:00.000Z',
      '2026-11-02T08:00:00.000Z',
      '2026-11-02T09:00:00.000Z',
      '2026-11-02T10:00:00.000Z',
      '2026-11-02T11:00:00.000Z',
    ]);
  });

  it('pairs each bucket with the same one in the period before', () => {
    const edges = boundaries(day, new Date('2026-11-02T10:30:00.000Z'));
    expect(
      series(
        [
          { date: '2026-11-02T07:00:00.000Z', total: 3 },
          { date: '2026-11-02T10:00:00.000Z', total: 5 },
        ],
        edges,
      ),
    ).toEqual([
      { start: '2026-11-02T09:00:00.000Z', value: 0, previous: 3 },
      { start: '2026-11-02T10:00:00.000Z', value: 5, previous: 0 },
    ]);
  });
});
