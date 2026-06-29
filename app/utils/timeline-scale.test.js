import { describe, expect, test } from 'vitest';
import {
  DAY_MS,
  MIN_BAR_PX,
  ZOOM_LEVELS,
  barGeometry,
  chartWidth,
  computeBar,
  computeDomain,
  computeTicks,
  formatDate,
  spanBars,
  toMs,
  xForMs
} from './timeline-scale.js';

const NOW = Date.UTC(2026, 5, 28); // 2026-06-28

describe('utils/timeline-scale', () => {
  describe('toMs', () => {
    test('passes finite numbers through', () => {
      expect(toMs(123456)).toBe(123456);
    });
    test('parses ISO strings', () => {
      expect(toMs('2026-07-12T10:00:00Z')).toBe(
        Date.parse('2026-07-12T10:00:00Z')
      );
    });
    test('returns null for empty/invalid', () => {
      expect(toMs(null)).toBeNull();
      expect(toMs(undefined)).toBeNull();
      expect(toMs('')).toBeNull();
      expect(toMs('not-a-date')).toBeNull();
    });
  });

  describe('computeBar (decision C)', () => {
    test('open issue with real due → start=created, end=due, has_real_due', () => {
      const bar = computeBar(
        {
          created_at: NOW,
          due_at: '2026-07-12T00:00:00Z',
          status: 'open'
        },
        NOW
      );
      expect(bar.start).toBe(NOW);
      expect(bar.end).toBe(Date.parse('2026-07-12T00:00:00Z'));
      expect(bar.has_real_due).toBe(true);
      expect(bar.is_closed).toBe(false);
    });

    test('open issue without due → ends at now, dashed (no real due)', () => {
      const created = NOW - 5 * DAY_MS;
      const bar = computeBar({ created_at: created, status: 'open' }, NOW);
      expect(bar.start).toBe(created);
      expect(bar.end).toBe(NOW);
      expect(bar.has_real_due).toBe(false);
    });

    test('closed issue without due → ends at closed_at', () => {
      const created = NOW - 10 * DAY_MS;
      const closed = NOW - 2 * DAY_MS;
      const bar = computeBar(
        { created_at: created, closed_at: closed, status: 'closed' },
        NOW
      );
      expect(bar.end).toBe(closed);
      expect(bar.is_closed).toBe(true);
      expect(bar.has_real_due).toBe(false);
    });

    test('overdue: open + due in past', () => {
      const bar = computeBar(
        {
          created_at: NOW - 10 * DAY_MS,
          due_at: NOW - 2 * DAY_MS,
          status: 'open'
        },
        NOW
      );
      expect(bar.is_overdue).toBe(true);
    });

    test('inverted range clamps end to start', () => {
      const bar = computeBar(
        { created_at: NOW, due_at: NOW - 5 * DAY_MS, status: 'open' },
        NOW
      );
      expect(bar.end).toBe(bar.start);
    });
  });

  describe('spanBars', () => {
    test('spans min start to max end across children', () => {
      const a = computeBar({ created_at: NOW, due_at: NOW + 3 * DAY_MS }, NOW);
      const b = computeBar(
        { created_at: NOW - 2 * DAY_MS, due_at: NOW + 8 * DAY_MS },
        NOW
      );
      const span = spanBars([a, b], NOW);
      expect(span?.start).toBe(NOW - 2 * DAY_MS);
      expect(span?.end).toBe(NOW + 8 * DAY_MS);
      expect(span?.has_real_due).toBe(true);
    });
    test('returns null for empty input', () => {
      expect(spanBars([], NOW)).toBeNull();
    });
    test('closed only when all children closed', () => {
      const a = computeBar(
        { created_at: NOW, status: 'closed', closed_at: NOW },
        NOW
      );
      const b = computeBar({ created_at: NOW, status: 'open' }, NOW);
      expect(spanBars([a, b], NOW)?.is_closed).toBe(false);
      expect(spanBars([a], NOW)?.is_closed).toBe(true);
    });
  });

  describe('computeDomain', () => {
    test('always includes now and pads both sides', () => {
      const bar = computeBar(
        { created_at: NOW, due_at: NOW + 4 * DAY_MS },
        NOW
      );
      const d = computeDomain([bar], NOW);
      expect(d.min).toBeLessThan(NOW);
      expect(d.max).toBeGreaterThan(NOW + 4 * DAY_MS);
    });
    test('empty bars → domain around now', () => {
      const d = computeDomain([], NOW);
      expect(d.min).toBeLessThan(NOW);
      expect(d.max).toBeGreaterThan(NOW);
    });
  });

  describe('geometry', () => {
    const domain = { min: NOW, max: NOW + 10 * DAY_MS };
    const ppd = ZOOM_LEVELS.day.px_per_day;
    test('xForMs is zero at domain min', () => {
      expect(xForMs(NOW, domain, ppd)).toBe(0);
    });
    test('xForMs scales by px-per-day', () => {
      expect(xForMs(NOW + 2 * DAY_MS, domain, ppd)).toBeCloseTo(2 * ppd);
    });
    test('barGeometry enforces MIN_BAR_PX', () => {
      const bar = computeBar(
        { created_at: NOW, due_at: NOW, status: 'open' },
        NOW
      );
      const g = barGeometry(bar, domain, ppd);
      expect(g.width).toBe(MIN_BAR_PX);
    });
    test('chartWidth spans the domain', () => {
      expect(chartWidth(domain, ppd)).toBeCloseTo(10 * ppd);
    });
  });

  describe('computeTicks', () => {
    const domain = { min: NOW, max: NOW + 30 * DAY_MS };
    test('week cadence steps ~weekly and aligns to Monday', () => {
      const ticks = computeTicks(domain, 'week', ZOOM_LEVELS.week.px_per_day);
      expect(ticks.length).toBeGreaterThanOrEqual(4);
      for (const t of ticks) {
        expect(new Date(t.ms).getUTCDay()).toBe(1); // Monday
      }
    });
    test('month cadence emits one tick per month', () => {
      const big = { min: Date.UTC(2026, 0, 1), max: Date.UTC(2026, 3, 1) };
      const ticks = computeTicks(big, 'month', ZOOM_LEVELS.month.px_per_day);
      expect(ticks.length).toBe(4); // Jan, Feb, Mar, Apr
      expect(ticks[0].label).toBe('2026'); // January shows year
    });
    test('ticks ascend in x', () => {
      const ticks = computeTicks(domain, 'day', ZOOM_LEVELS.day.px_per_day);
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i].x).toBeGreaterThan(ticks[i - 1].x);
      }
    });
    test('degenerate domain → no ticks', () => {
      expect(computeTicks({ min: NOW, max: NOW }, 'day', 10)).toEqual([]);
    });
  });

  describe('formatDate', () => {
    test('formats month + day', () => {
      expect(formatDate(Date.UTC(2026, 6, 12))).toBe('Jul 12');
    });
  });
});
