import { html, render } from 'lit-html';
import { classMap } from 'lit-html/directives/class-map.js';
import { styleMap } from 'lit-html/directives/style-map.js';
import { createListSelectors } from '../data/list-selectors.js';
import {
  buildTimelineModel,
  dependencyHighlight
} from '../data/timeline-model.js';
import { createIssueIdRenderer } from '../utils/issue-id-renderer.js';
import { debug } from '../utils/logging.js';
import { emojiForPriority } from '../utils/priority-badge.js';
import { priority_levels } from '../utils/priority.js';
import {
  ZOOM_LEVELS,
  ZOOM_ORDER,
  barGeometry,
  chartWidth,
  computeDomain,
  computeTicks,
  formatRange,
  xForMs
} from '../utils/timeline-scale.js';
import { createTypeBadge } from '../utils/type-badge.js';

/**
 * Subscription client ids owned by the Timeline view. Kept distinct from the
 * Issues/Epics tabs so the two never fight over the same registry entry.
 */
export const TIMELINE_EPICS_ID = 'tab:timeline:epics';
export const TIMELINE_ISSUES_ID = 'tab:timeline:issues';

/**
 * @param {string} id
 * @returns {string}
 */
export function timelineDetailId(id) {
  return `timeline:detail:${id}`;
}

const SIDEBAR_WIDTH = 248;

/**
 * Create the Timeline (Gantt) view.
 *
 * Data model (all push-driven, no RPC reads):
 * - `tab:timeline:epics` (type `epics`) → epic group headers.
 * - per-epic `timeline:detail:{id}` (type `issue-detail`) → children membership,
 *   auto-subscribed eagerly so every bar is visible.
 * - `tab:timeline:issues` (type `all-issues`) → authoritative bar geometry and
 *   the orphan ("Ungrouped") lane.
 * - on bar select, the selected issue's `timeline:detail:{id}` is subscribed to
 *   surface its dependency links for the highlight overlay.
 *
 * @param {HTMLElement} mount_element
 * @param {unknown} _data - Unused (call-compat with sibling views).
 * @param {(id: string) => void} goto_issue
 * @param {{ subscribeList: (client_id: string, spec: { type: string, params?: Record<string, string|number|boolean> }) => Promise<() => Promise<void>> }} [subscriptions]
 * @param {{ snapshotFor?: (client_id: string) => any[], subscribe?: (fn: () => void) => () => void, register?: (id: string, spec: any) => void, unregister?: (id: string) => void }} [issue_stores]
 * @param {{ getState: () => any, setState: (patch: any) => void }} [store]
 * @returns {{ load: () => Promise<void>, clear: () => void, __setNow: (ts: number) => void }}
 */
export function createTimelineView(
  mount_element,
  _data,
  goto_issue,
  subscriptions = undefined,
  issue_stores = undefined,
  store = undefined
) {
  const log = debug('views:timeline');
  const selectors = issue_stores ? createListSelectors(issue_stores) : null;

  /** @type {'day'|'week'|'month'} */
  let zoom = 'week';
  if (store) {
    try {
      const z = store.getState()?.timeline?.zoom;
      if (z === 'day' || z === 'week' || z === 'month') {
        zoom = z;
      }
    } catch {
      // ignore store read errors
    }
  }

  /** Collapsed epic ids (groups default to expanded). @type {Set<string>} */
  const collapsed = new Set();
  /** Currently selected issue id (drives dependency highlight). @type {string|null} */
  let selected_id = null;
  /** Per-epic + per-selection detail unsubscribe handles. @type {Map<string, () => Promise<void>>} */
  const detail_unsubs = new Map();

  /**
   * Current wall-clock instant. Indirection keeps render deterministic within a
   * frame and makes the value injectable in tests via the returned `__setNow`.
   */
  let now = Date.now();

  /**
   * Eagerly ensure a `timeline:detail:{id}` subscription exists (children or a
   * selected issue's dependency data). Idempotent per id.
   *
   * @param {string} id
   */
  function ensureDetail(id) {
    if (!id || detail_unsubs.has(id)) {
      return;
    }
    if (!subscriptions || typeof subscriptions.subscribeList !== 'function') {
      return;
    }
    const client_id = timelineDetailId(id);
    const spec = { type: 'issue-detail', params: { id } };
    // Mark in-flight immediately so concurrent calls don't double-subscribe.
    detail_unsubs.set(id, async () => {});
    try {
      if (issue_stores && typeof issue_stores.register === 'function') {
        issue_stores.register(client_id, spec);
      }
    } catch {
      // ignore register errors
    }
    void subscriptions
      .subscribeList(client_id, spec)
      .then((unsub) => {
        detail_unsubs.set(id, unsub);
      })
      .catch((err) => {
        log('detail subscribe failed for %s: %o', id, err);
        detail_unsubs.delete(id);
      });
  }

  /**
   * @param {string} id
   */
  async function releaseDetail(id) {
    const unsub = detail_unsubs.get(id);
    detail_unsubs.delete(id);
    if (unsub) {
      try {
        await unsub();
      } catch {
        // ignore
      }
    }
    try {
      if (issue_stores && typeof issue_stores.unregister === 'function') {
        issue_stores.unregister(timelineDetailId(id));
      }
    } catch {
      // ignore
    }
  }

  /**
   * Epic entities from the epics subscription.
   *
   * @returns {any[]}
   */
  function epicsSnapshot() {
    return issue_stores && issue_stores.snapshotFor
      ? issue_stores.snapshotFor(TIMELINE_EPICS_ID) || []
      : [];
  }

  /**
   * Every issue from the `all-issues` stream (authoritative bar data).
   *
   * @returns {any[]}
   */
  function allIssuesSnapshot() {
    return issue_stores && issue_stores.snapshotFor
      ? issue_stores.snapshotFor(TIMELINE_ISSUES_ID) || []
      : [];
  }

  /**
   * Children of an epic from its detail subscription's `dependents`.
   *
   * @param {string} epic_id
   * @returns {any[]}
   */
  function childrenFor(epic_id) {
    const arr =
      issue_stores && issue_stores.snapshotFor
        ? issue_stores.snapshotFor(timelineDetailId(epic_id)) || []
        : [];
    const epic = arr.find((it) => String(it?.id || '') === String(epic_id));
    return Array.isArray(epic?.dependents) ? epic.dependents : [];
  }

  /** Subscribe to all epics' detail streams so every child bar resolves. */
  function ensureEpicDetails() {
    for (const epic of epicsSnapshot()) {
      const id = String(epic?.id || '');
      if (id) {
        ensureDetail(id);
      }
    }
  }

  /**
   * Whether any epic's detail stream has not yet delivered a snapshot. While
   * pending, an issue that is actually an epic child would otherwise show up in
   * the Ungrouped lane for a frame; callers use this to defer that lane until
   * membership is known, avoiding a load-time reshuffle.
   *
   * @returns {boolean}
   */
  function epicDetailsPending() {
    if (!issue_stores || typeof issue_stores.snapshotFor !== 'function') {
      return false;
    }
    for (const epic of epicsSnapshot()) {
      const id = String(epic?.id || '');
      if (!id) {
        continue;
      }
      const arr = issue_stores.snapshotFor(timelineDetailId(id)) || [];
      const has = arr.some((it) => String(it?.id || '') === id);
      if (!has) {
        return true;
      }
    }
    return false;
  }

  /** Build the current model snapshot. */
  function model() {
    return buildTimelineModel({
      epics: epicsSnapshot(),
      childrenFor,
      allIssues: allIssuesSnapshot(),
      now
    });
  }

  /** Dependency highlight sets for the current selection. */
  function highlightSets() {
    if (!selected_id) {
      return { active: false, blockers: new Set(), blocked: new Set() };
    }
    const arr =
      issue_stores && issue_stores.snapshotFor
        ? issue_stores.snapshotFor(timelineDetailId(selected_id)) || []
        : [];
    const detail = arr.find((it) => String(it?.id || '') === selected_id);
    const { blockers, blocked } = dependencyHighlight(detail);
    return { active: true, blockers, blocked };
  }

  // ── rendering ──────────────────────────────────────────────────────────

  function doRender() {
    render(template(), mount_element);
  }

  function template() {
    const m = model();
    const domain = computeDomain(m.bars, now);
    const px_per_day = ZOOM_LEVELS[zoom].px_per_day;
    const width = chartWidth(domain, px_per_day);
    const ticks = computeTicks(domain, ZOOM_LEVELS[zoom].tick, px_per_day);
    const today_x = xForMs(now, domain, px_per_day);
    const hl = highlightSets();
    const ctx = { domain, px_per_day, width, today_x, hl };

    // Until every epic's children are known, an epic child would briefly show
    // in Ungrouped. Defer that lane (show a slim loading row) to avoid a
    // load-time reshuffle. Once details arrive, the real lane renders.
    const pending = epicDetailsPending();
    const has_rows = m.groups.length > 0 || m.ungrouped.length > 0;

    return html`
      <div class="timeline-root">
        ${toolbarTemplate()}
        ${has_rows
          ? html`<div
              class="timeline-scroll"
              @click=${onBackgroundClick}
              role="region"
              aria-label="Issue timeline"
            >
              <div
                class="timeline-canvas"
                style=${styleMap({
                  '--timeline-chart-w': `${width}px`,
                  '--timeline-side-w': `${SIDEBAR_WIDTH}px`
                })}
              >
                ${gridLayerTemplate(ctx, ticks)} ${axisTemplate(ctx, ticks)}
                ${m.groups.map((g) => groupTemplate(g, ctx))}
                ${pending
                  ? html`<div class="timeline-row timeline-row--loading">
                      <div class="timeline-side muted">Loading…</div>
                      <div class="timeline-track"></div>
                    </div>`
                  : ungroupedTemplate(m.ungrouped, ctx)}
              </div>
            </div>`
          : html`<div class="timeline-empty muted">
              No issues to show on the timeline.
            </div>`}
      </div>
    `;
  }

  function toolbarTemplate() {
    return html`
      <div class="timeline-toolbar">
        <div
          class="timeline-zoom"
          role="group"
          aria-label="Timeline zoom level"
        >
          ${ZOOM_ORDER.map(
            (z) =>
              html`<button
                type="button"
                class="timeline-zoom__btn ${zoom === z ? 'is-active' : ''}"
                aria-pressed=${zoom === z}
                @click=${() => setZoom(z)}
              >
                ${ZOOM_LEVELS[z].label}
              </button>`
          )}
        </div>
        <div class="timeline-legend" aria-hidden="true">
          <span class="timeline-legend__item"
            ><span class="timeline-swatch timeline-swatch--scheduled"></span
            >Scheduled</span
          >
          <span class="timeline-legend__item"
            ><span class="timeline-swatch timeline-swatch--nodue"></span>No due
            date</span
          >
          <span class="timeline-legend__item"
            ><span class="timeline-swatch timeline-swatch--overdue"></span
            >Overdue</span
          >
        </div>
      </div>
    `;
  }

  /**
   * Background gridlines + today-line spanning all rows.
   *
   * @param {any} ctx
   * @param {import('../utils/timeline-scale.js').Tick[]} ticks
   */
  function gridLayerTemplate(ctx, ticks) {
    return html`<div class="timeline-gridlayer" aria-hidden="true">
      ${ticks.map(
        (t) =>
          html`<span
            class="timeline-gridline ${t.strong ? 'is-strong' : ''}"
            style=${styleMap({ left: `${t.x}px` })}
          ></span>`
      )}
      <span
        class="timeline-today"
        style=${styleMap({ left: `${ctx.today_x}px` })}
      ></span>
    </div>`;
  }

  /**
   * Sticky axis header (date ticks + Today marker label).
   *
   * @param {any} ctx
   * @param {import('../utils/timeline-scale.js').Tick[]} ticks
   */
  function axisTemplate(ctx, ticks) {
    return html`<div class="timeline-row timeline-axis">
      <div class="timeline-side timeline-axis__corner">
        <span class="timeline-axis__title">Timeline</span>
      </div>
      <div class="timeline-track timeline-axis__track">
        ${ticks.map(
          (t) =>
            html`<span
              class="timeline-tick ${t.strong ? 'is-strong' : ''}"
              style=${styleMap({ left: `${t.x}px` })}
              >${t.label}</span
            >`
        )}
        <span
          class="timeline-today-flag"
          style=${styleMap({ left: `${ctx.today_x}px` })}
          >Today</span
        >
      </div>
    </div>`;
  }

  /**
   * @param {import('../data/timeline-model.js').Group} g
   * @param {any} ctx
   */
  function groupTemplate(g, ctx) {
    const id = String(g.epic?.id || '');
    const is_collapsed = collapsed.has(id);
    return html`
      <div class="timeline-group" data-epic-id=${id}>
        <div
          class="timeline-row timeline-row--epic ${is_collapsed
            ? 'is-collapsed'
            : ''}"
        >
          <div
            class="timeline-side timeline-side--epic"
            role="button"
            tabindex="0"
            aria-expanded=${!is_collapsed}
            @click=${() => toggleGroup(id)}
            @keydown=${(/** @type {KeyboardEvent} */ ev) =>
              onSideKey(ev, () => toggleGroup(id))}
          >
            <svg
              class="timeline-chevron"
              viewBox="0 0 16 16"
              width="14"
              height="14"
              aria-hidden="true"
            >
              <path
                d="M6 4l4 4-4 4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            ${createTypeBadge(g.epic?.issue_type || 'epic')}
            <span class="timeline-side__title text-truncate"
              >${g.epic?.title || '(untitled epic)'}</span
            >
            <span class="timeline-side__count mono"
              >${g.closed}/${g.total}</span
            >
          </div>
          <div class="timeline-track">
            ${barTemplate(g.bar, ctx, { epic: true, id })}
          </div>
        </div>
        ${is_collapsed
          ? null
          : g.children.map((c) => rowTemplate(c, ctx, true))}
      </div>
    `;
  }

  /**
   * @param {import('../data/timeline-model.js').Row[]} rows
   * @param {any} ctx
   */
  function ungroupedTemplate(rows, ctx) {
    if (!rows.length) {
      return null;
    }
    const is_collapsed = collapsed.has('__ungrouped__');
    return html`
      <div class="timeline-group" data-epic-id="__ungrouped__">
        <div class="timeline-row timeline-row--epic">
          <div
            class="timeline-side timeline-side--epic"
            role="button"
            tabindex="0"
            aria-expanded=${!is_collapsed}
            @click=${() => toggleGroup('__ungrouped__')}
            @keydown=${(/** @type {KeyboardEvent} */ ev) =>
              onSideKey(ev, () => toggleGroup('__ungrouped__'))}
          >
            <svg
              class="timeline-chevron"
              viewBox="0 0 16 16"
              width="14"
              height="14"
              aria-hidden="true"
            >
              <path
                d="M6 4l4 4-4 4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <span class="timeline-side__title text-truncate">Ungrouped</span>
            <span class="timeline-side__count mono">${rows.length}</span>
          </div>
          <div class="timeline-track"></div>
        </div>
        ${is_collapsed ? null : rows.map((r) => rowTemplate(r, ctx, false))}
      </div>
    `;
  }

  /**
   * Compact emoji-only priority indicator (keeps the row title roomy).
   *
   * @param {number | undefined} priority
   */
  function priorityDot(priority) {
    const p = typeof priority === 'number' ? priority : 2;
    const i = Math.max(0, Math.min(4, p));
    const label = priority_levels[i] || 'Medium';
    return html`<span
      class="timeline-side__prio"
      role="img"
      title=${`Priority: ${label}`}
      aria-label=${`Priority: ${label}`}
      >${emojiForPriority(i)}</span
    >`;
  }

  /**
   * @param {import('../data/timeline-model.js').Row} row
   * @param {any} ctx
   * @param {boolean} indented
   */
  function rowTemplate(row, ctx, indented) {
    const id = String(row.issue?.id || '');
    const is_selected = id === selected_id;
    const role = ctx.hl.active
      ? ctx.hl.blockers.has(id)
        ? 'blocker'
        : ctx.hl.blocked.has(id)
          ? 'blocked'
          : is_selected
            ? 'selected'
            : 'dim'
      : 'none';
    return html`
      <div
        class=${classMap({
          'timeline-row': true,
          'timeline-row--issue': true,
          'is-indented': indented,
          'is-selected': is_selected,
          'is-dim': role === 'dim'
        })}
        data-issue-id=${id}
      >
        <div class="timeline-side timeline-side--issue">
          <span
            class="timeline-side__title text-truncate"
            role="link"
            tabindex="0"
            title=${row.issue?.title || id}
            @click=${() => goto_issue(id)}
            @keydown=${(/** @type {KeyboardEvent} */ ev) =>
              onSideKey(ev, () => goto_issue(id))}
            >${row.issue?.title || '(no title)'}</span
          >
          ${priorityDot(row.issue?.priority)}
          ${createIssueIdRenderer(id, { class_name: 'mono timeline-side__id' })}
        </div>
        <div class="timeline-track">
          ${barTemplate(row.bar, ctx, { id, role })}
        </div>
      </div>
    `;
  }

  /**
   * @param {import('../utils/timeline-scale.js').Bar} bar
   * @param {any} ctx
   * @param {{ epic?: boolean, id: string, role?: string }} opts
   */
  function barTemplate(bar, ctx, opts) {
    const { x, width } = barGeometry(bar, ctx.domain, ctx.px_per_day);
    const classes = classMap({
      'timeline-bar': true,
      'timeline-bar--epic': Boolean(opts.epic),
      'timeline-bar--nodue': !bar.has_real_due,
      'timeline-bar--closed': bar.is_closed,
      'timeline-bar--overdue': bar.is_overdue,
      'is-blocker': opts.role === 'blocker',
      'is-blocked': opts.role === 'blocked',
      'is-selected': opts.role === 'selected' || opts.id === selected_id
    });
    return html`<button
      type="button"
      class=${classes}
      style=${styleMap({ left: `${x}px`, width: `${width}px` })}
      title=${formatRange(bar)}
      @click=${(/** @type {MouseEvent} */ ev) => onBarClick(ev, opts.id)}
    >
      <span class="timeline-bar__fill"></span>
    </button>`;
  }

  // ── interaction ────────────────────────────────────────────────────────

  /**
   * @param {'day'|'week'|'month'} z
   */
  function setZoom(z) {
    if (z === zoom) {
      return;
    }
    zoom = z;
    if (store) {
      try {
        store.setState({ timeline: { zoom } });
      } catch {
        // ignore persist errors
      }
    }
    doRender();
  }

  /**
   * @param {string} id
   */
  function toggleGroup(id) {
    if (collapsed.has(id)) {
      collapsed.delete(id);
    } else {
      collapsed.add(id);
    }
    doRender();
  }

  /**
   * @param {MouseEvent} ev
   * @param {string} id
   */
  function onBarClick(ev, id) {
    ev.stopPropagation();
    if (selected_id === id) {
      // toggle off
      const prev = selected_id;
      selected_id = null;
      if (prev) {
        void maybeReleaseSelection(prev);
      }
      doRender();
      return;
    }
    const prev = selected_id;
    selected_id = id;
    ensureDetail(id);
    if (prev && prev !== id) {
      void maybeReleaseSelection(prev);
    }
    doRender();
  }

  /**
   * Release a selection's detail subscription unless it's still needed as an
   * epic's children stream.
   *
   * @param {string} id
   */
  async function maybeReleaseSelection(id) {
    const is_epic = epicsSnapshot().some((e) => String(e?.id || '') === id);
    if (!is_epic) {
      await releaseDetail(id);
    }
  }

  function onBackgroundClick() {
    if (selected_id) {
      const prev = selected_id;
      selected_id = null;
      void maybeReleaseSelection(prev);
      doRender();
    }
  }

  /**
   * @param {KeyboardEvent} ev
   * @param {() => void} fn
   */
  function onSideKey(ev, fn) {
    const key = String(ev.key || '');
    if (key === 'Enter' || key === ' ') {
      ev.preventDefault();
      fn();
    }
  }

  // Live re-render on any store push (membership, bar data, dependencies).
  if (selectors) {
    selectors.subscribe(() => {
      ensureEpicDetails();
      doRender();
    });
  }

  return {
    async load() {
      now = Date.now();
      ensureEpicDetails();
      doRender();
    },
    clear() {
      const ids = Array.from(detail_unsubs.keys());
      for (const id of ids) {
        void releaseDetail(id);
      }
      selected_id = null;
      mount_element.replaceChildren();
    },
    /**
     * Test seam: pin the wall-clock instant.
     *
     * @param {number} ts
     */
    __setNow(ts) {
      now = ts;
    }
  };
}
