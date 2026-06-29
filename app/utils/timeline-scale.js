/**
 * Timeline scale utilities — pure date/geometry math for the Gantt view.
 *
 * Responsibilities (no DOM, no lit-html):
 * - Tolerant timestamp parsing (`due_at` arrives as an ISO string, while
 *   `created_at`/`closed_at` arrive as epoch-ms numbers).
 * - Per-issue bar geometry under decision C:
 *     start = created_at
 *     end   = due_at ?? closed_at ?? now
 *     `has_real_due` flags bars that carry a genuine schedule vs. elapsed-age.
 * - Auto-fit domain (always includes "today" so the today-line is visible).
 * - Zoom presets (Day / Week / Month) → pixels-per-day + gridline cadence.
 * - Tick generation for axis gridlines/labels.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Zoom presets. `px_per_day` controls horizontal density; `tick` chooses the
 * gridline cadence used by {@link computeTicks}.
 *
 * @type {Record<'day'|'week'|'month', { px_per_day: number, tick: 'day'|'week'|'month', label: string }>}
 */
export const ZOOM_LEVELS = {
  day: { px_per_day: 44, tick: 'day', label: 'Day' },
  week: { px_per_day: 14, tick: 'week', label: 'Week' },
  month: { px_per_day: 4.2, tick: 'month', label: 'Month' }
};

/** @type {Array<'day'|'week'|'month'>} */
export const ZOOM_ORDER = ['day', 'week', 'month'];

/** Minimum rendered bar width in px so zero-duration items stay clickable. */
export const MIN_BAR_PX = 8;

export { DAY_MS };

/**
 * Tolerant timestamp → epoch-ms. Accepts finite numbers (already ms), ISO/date
 * strings (via Date.parse), or numeric strings. Returns null for empty/invalid.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function toMs(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * @typedef {Object} Bar
 * @property {number} start - Epoch ms (left edge).
 * @property {number} end - Epoch ms (right edge).
 * @property {boolean} has_real_due - Whether `due_at` provided the end.
 * @property {boolean} is_closed - Whether the issue is closed.
 * @property {boolean} is_overdue - Open + due in the past.
 */

/**
 * Compute a single issue's bar under decision C.
 *
 * @param {{ created_at?: unknown, due_at?: unknown, closed_at?: unknown, status?: string }} issue
 * @param {number} now - Epoch ms "today".
 * @returns {Bar}
 */
export function computeBar(issue, now) {
  const start = toMs(issue?.created_at) ?? now;
  const due = toMs(issue?.due_at);
  const closed = toMs(issue?.closed_at);
  const is_closed = String(issue?.status || '') === 'closed';
  let end = due ?? closed ?? now;
  // Guard against inverted ranges (e.g. due before creation): keep a sane bar.
  if (end < start) {
    end = start;
  }
  const is_overdue = !is_closed && due !== null && due < now;
  return { start, end, has_real_due: due !== null, is_closed, is_overdue };
}

/**
 * Merge several child bars into a spanning parent (epic) bar.
 *
 * @param {Bar[]} bars
 * @param {number} now
 * @returns {Bar | null} Null when there are no bars to span.
 */
export function spanBars(bars, now) {
  const list = Array.isArray(bars) ? bars.filter(Boolean) : [];
  if (list.length === 0) {
    return null;
  }
  let start = Infinity;
  let end = -Infinity;
  let has_real_due = false;
  let all_closed = true;
  for (const b of list) {
    if (b.start < start) {
      start = b.start;
    }
    if (b.end > end) {
      end = b.end;
    }
    has_real_due = has_real_due || b.has_real_due;
    all_closed = all_closed && b.is_closed;
  }
  const is_overdue = !all_closed && has_real_due && end < now;
  return { start, end, has_real_due, is_closed: all_closed, is_overdue };
}

/**
 * Auto-fit domain over all bars. Always includes `now` and adds a small pad on
 * each side so end bars and the today-line aren't flush against the edge.
 *
 * @param {Bar[]} bars
 * @param {number} now
 * @returns {{ min: number, max: number }}
 */
export function computeDomain(bars, now) {
  let min = now;
  let max = now;
  for (const b of bars || []) {
    if (!b) {
      continue;
    }
    if (b.start < min) {
      min = b.start;
    }
    if (b.end > max) {
      max = b.end;
    }
  }
  // Pad by ~4% of span (min one day) so bars breathe.
  const span = Math.max(DAY_MS, max - min);
  const pad = Math.max(DAY_MS, Math.round(span * 0.04));
  return { min: min - pad, max: max + pad };
}

/**
 * Convert an epoch-ms instant to an x offset (px) within the chart.
 *
 * @param {number} ms
 * @param {{ min: number }} domain
 * @param {number} px_per_day
 * @returns {number}
 */
export function xForMs(ms, domain, px_per_day) {
  return ((ms - domain.min) / DAY_MS) * px_per_day;
}

/**
 * Geometry (x, width) for a bar in px.
 *
 * @param {Bar} bar
 * @param {{ min: number }} domain
 * @param {number} px_per_day
 * @returns {{ x: number, width: number }}
 */
export function barGeometry(bar, domain, px_per_day) {
  const x = xForMs(bar.start, domain, px_per_day);
  const raw = ((bar.end - bar.start) / DAY_MS) * px_per_day;
  return { x, width: Math.max(MIN_BAR_PX, raw) };
}

/**
 * Total chart width in px for a domain at a zoom.
 *
 * @param {{ min: number, max: number }} domain
 * @param {number} px_per_day
 * @returns {number}
 */
export function chartWidth(domain, px_per_day) {
  return Math.max(1, ((domain.max - domain.min) / DAY_MS) * px_per_day);
}

/**
 * Start-of-UTC-day for an instant (gridlines align to whole days).
 *
 * @param {number} ms
 * @returns {number}
 */
function startOfUTCDay(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
];

/**
 * @typedef {Object} Tick
 * @property {number} ms - Instant of the gridline.
 * @property {number} x - Px offset within the chart.
 * @property {string} label - Short axis label.
 * @property {boolean} strong - Emphasized (month boundary / month tick).
 */

/**
 * Generate axis ticks for the domain at the given cadence.
 * Day cadence emphasizes Mondays; week cadence steps Monday→Monday; month
 * cadence steps by calendar month.
 *
 * @param {{ min: number, max: number }} domain
 * @param {'day'|'week'|'month'} cadence
 * @param {number} px_per_day
 * @returns {Tick[]}
 */
export function computeTicks(domain, cadence, px_per_day) {
  /** @type {Tick[]} */
  const ticks = [];
  if (!domain || domain.max <= domain.min) {
    return ticks;
  }
  // Safety cap to avoid runaway loops on absurd domains.
  const MAX_TICKS = 500;

  if (cadence === 'month') {
    const d = new Date(domain.min);
    let cursor = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    while (cursor <= domain.max && ticks.length < MAX_TICKS) {
      if (cursor >= domain.min) {
        const cd = new Date(cursor);
        const label =
          cd.getUTCMonth() === 0
            ? String(cd.getUTCFullYear())
            : MONTH_NAMES[cd.getUTCMonth()];
        ticks.push({
          ms: cursor,
          x: xForMs(cursor, domain, px_per_day),
          label,
          strong: cd.getUTCMonth() === 0
        });
      }
      const nd = new Date(cursor);
      cursor = Date.UTC(nd.getUTCFullYear(), nd.getUTCMonth() + 1, 1);
    }
    return ticks;
  }

  const step = cadence === 'week' ? 7 * DAY_MS : DAY_MS;
  // Align start to a whole day; for weeks, back up to Monday.
  let cursor = startOfUTCDay(domain.min);
  if (cadence === 'week') {
    const dow = new Date(cursor).getUTCDay(); // 0=Sun..6=Sat
    const back = (dow + 6) % 7; // days since Monday
    cursor -= back * DAY_MS;
  }
  while (cursor <= domain.max && ticks.length < MAX_TICKS) {
    if (cursor >= domain.min) {
      const cd = new Date(cursor);
      const is_month_start = cd.getUTCDate() <= (cadence === 'week' ? 7 : 1);
      const label =
        cadence === 'week'
          ? `${MONTH_NAMES[cd.getUTCMonth()]} ${cd.getUTCDate()}`
          : `${cd.getUTCDate()}`;
      ticks.push({
        ms: cursor,
        x: xForMs(cursor, domain, px_per_day),
        label,
        strong: is_month_start
      });
    }
    cursor += step;
  }
  return ticks;
}

/**
 * Format a bar's date range for tooltips/labels.
 *
 * @param {Bar} bar
 * @returns {string}
 */
export function formatRange(bar) {
  return `${formatDate(bar.start)} → ${formatDate(bar.end)}`;
}

/**
 * Compact UTC date label, e.g. "Jul 12".
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatDate(ms) {
  const d = new Date(ms);
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
