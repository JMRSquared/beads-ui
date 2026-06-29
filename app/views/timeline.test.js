import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createSubscriptionIssueStore } from '../data/subscription-issue-store.js';
import { createSubscriptionStore } from '../data/subscriptions-store.js';
import {
  TIMELINE_EPICS_ID,
  TIMELINE_ISSUES_ID,
  createTimelineView,
  timelineDetailId
} from './timeline.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 5, 28);

/** Build an in-memory issue-store harness like the other view tests use. */
function makeHarness() {
  const stores = new Map();
  const listeners = new Set();
  const emit = () => {
    for (const fn of Array.from(listeners)) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  };
  /** @param {string} id */
  const getStore = (id) => {
    let s = stores.get(id);
    if (!s) {
      s = createSubscriptionIssueStore(id);
      stores.set(id, s);
      s.subscribe(emit);
    }
    return s;
  };
  return {
    getStore,
    register() {},
    unregister() {},
    /** @param {string} id */
    snapshotFor(id) {
      return getStore(id).snapshot().slice();
    },
    /** @param {() => void} fn */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }
  };
}

/**
 * Seed a snapshot push into a store id.
 *
 * @param {any} harness
 * @param {string} id
 * @param {any[]} issues
 */
function seed(harness, id, issues) {
  harness.getStore(id).applyPush({
    type: 'snapshot',
    id,
    revision: 1,
    issues
  });
}

describe('views/timeline', () => {
  /** @type {HTMLElement} */
  let mount;
  beforeEach(() => {
    document.body.innerHTML = '<div id="m"></div>';
    mount = /** @type {HTMLElement} */ (document.getElementById('m'));
  });

  test('renders empty state with no data', async () => {
    const harness = makeHarness();
    const subs = createSubscriptionStore(async () => {});
    const view = createTimelineView(
      mount,
      null,
      () => {},
      subs,
      /** @type {any} */ (harness)
    );
    view.__setNow(NOW);
    await view.load();
    expect(mount.querySelector('.timeline-empty')).toBeTruthy();
  });

  test('renders epic group with children bars and ungrouped lane', async () => {
    const harness = makeHarness();
    const subs = createSubscriptionStore(async () => {});

    seed(harness, TIMELINE_EPICS_ID, [
      { id: 'E-1', title: 'Launch', issue_type: 'epic' }
    ]);
    seed(harness, timelineDetailId('E-1'), [
      {
        id: 'E-1',
        title: 'Launch',
        issue_type: 'epic',
        dependents: [
          { id: 'A', dependency_type: 'parent-child' },
          { id: 'B', dependency_type: 'parent-child' }
        ]
      }
    ]);
    seed(harness, TIMELINE_ISSUES_ID, [
      {
        id: 'A',
        title: 'Design',
        created_at: NOW,
        due_at: NOW + 4 * DAY,
        status: 'open'
      },
      {
        id: 'B',
        title: 'Build',
        created_at: NOW + 2 * DAY,
        due_at: NOW + 9 * DAY,
        status: 'open'
      },
      { id: 'C', title: 'Loose end', created_at: NOW, status: 'open' }
    ]);

    const view = createTimelineView(
      mount,
      null,
      () => {},
      subs,
      /** @type {any} */ (harness)
    );
    view.__setNow(NOW);
    await view.load();

    expect(
      mount.querySelector('.timeline-group[data-epic-id="E-1"]')
    ).toBeTruthy();
    const childRows = mount.querySelectorAll(
      '.timeline-group[data-epic-id="E-1"] .timeline-row--issue'
    );
    expect(childRows.length).toBe(2);
    // Ungrouped lane holds C
    expect(
      mount.querySelector('.timeline-group[data-epic-id="__ungrouped__"]')
    ).toBeTruthy();
    // Today line present
    expect(mount.querySelector('.timeline-today')).toBeTruthy();
    // Bars carry geometry
    const bar = /** @type {HTMLElement} */ (
      mount.querySelector('.timeline-bar')
    );
    expect(bar.style.width).toMatch(/px$/);
  });

  test('no-due issue gets the dashed (nodue) bar class', async () => {
    const harness = makeHarness();
    const subs = createSubscriptionStore(async () => {});
    seed(harness, TIMELINE_ISSUES_ID, [
      { id: 'C', title: 'Loose end', created_at: NOW - 3 * DAY, status: 'open' }
    ]);
    const view = createTimelineView(
      mount,
      null,
      () => {},
      subs,
      /** @type {any} */ (harness)
    );
    view.__setNow(NOW);
    await view.load();
    expect(mount.querySelector('.timeline-bar--nodue')).toBeTruthy();
  });

  test('zoom toggle changes chart width', async () => {
    const harness = makeHarness();
    const subs = createSubscriptionStore(async () => {});
    seed(harness, TIMELINE_ISSUES_ID, [
      { id: 'A', created_at: NOW, due_at: NOW + 30 * DAY, status: 'open' }
    ]);
    const setState = vi.fn();
    const store = {
      getState: () => ({ timeline: { zoom: 'week' } }),
      setState
    };
    const view = createTimelineView(
      mount,
      null,
      () => {},
      subs,
      /** @type {any} */ (harness),
      /** @type {any} */ (store)
    );
    view.__setNow(NOW);
    await view.load();
    const widthAt = () =>
      parseFloat(
        getComputedStyle(
          /** @type {HTMLElement} */ (mount.querySelector('.timeline-canvas'))
        ).getPropertyValue('--timeline-chart-w')
      );
    const weekW = widthAt();
    // Switch to month (denser → narrower)
    const monthBtn = Array.from(
      mount.querySelectorAll('.timeline-zoom__btn')
    ).find((b) => b.textContent?.trim() === 'Month');
    /** @type {HTMLButtonElement} */ (monthBtn).click();
    expect(setState).toHaveBeenCalledWith({ timeline: { zoom: 'month' } });
    expect(widthAt()).toBeLessThan(weekW);
  });

  test('clicking an epic side collapses its children', async () => {
    const harness = makeHarness();
    const subs = createSubscriptionStore(async () => {});
    seed(harness, TIMELINE_EPICS_ID, [
      { id: 'E-1', issue_type: 'epic', title: 'E' }
    ]);
    seed(harness, timelineDetailId('E-1'), [
      {
        id: 'E-1',
        issue_type: 'epic',
        dependents: [{ id: 'A', dependency_type: 'parent-child' }]
      }
    ]);
    seed(harness, TIMELINE_ISSUES_ID, [
      { id: 'A', created_at: NOW, due_at: NOW + 2 * DAY, status: 'open' }
    ]);
    const view = createTimelineView(
      mount,
      null,
      () => {},
      subs,
      /** @type {any} */ (harness)
    );
    view.__setNow(NOW);
    await view.load();
    expect(
      mount.querySelectorAll(
        '.timeline-group[data-epic-id="E-1"] .timeline-row--issue'
      ).length
    ).toBe(1);
    /** @type {HTMLElement} */ (
      mount.querySelector(
        '.timeline-group[data-epic-id="E-1"] .timeline-side--epic'
      )
    ).click();
    expect(
      mount.querySelectorAll(
        '.timeline-group[data-epic-id="E-1"] .timeline-row--issue'
      ).length
    ).toBe(0);
  });

  test('clicking a row title navigates to the issue', async () => {
    const harness = makeHarness();
    const subs = createSubscriptionStore(async () => {});
    seed(harness, TIMELINE_ISSUES_ID, [
      {
        id: 'A',
        title: 'Design',
        created_at: NOW,
        due_at: NOW + 2 * DAY,
        status: 'open'
      }
    ]);
    const nav = /** @type {string[]} */ ([]);
    const view = createTimelineView(
      mount,
      null,
      (id) => nav.push(id),
      subs,
      /** @type {any} */ (harness)
    );
    view.__setNow(NOW);
    await view.load();
    /** @type {HTMLElement} */ (
      mount.querySelector('.timeline-side--issue .timeline-side__title')
    ).click();
    expect(nav).toEqual(['A']);
  });

  test('selecting a bar highlights its blockers and dims unrelated rows', async () => {
    const harness = makeHarness();
    const subs = createSubscriptionStore(async () => {});
    seed(harness, TIMELINE_ISSUES_ID, [
      {
        id: 'A',
        title: 'Build',
        created_at: NOW,
        due_at: NOW + 4 * DAY,
        status: 'open'
      },
      {
        id: 'B',
        title: 'Design',
        created_at: NOW,
        due_at: NOW + 2 * DAY,
        status: 'open'
      },
      {
        id: 'Z',
        title: 'Unrelated',
        created_at: NOW,
        due_at: NOW + 3 * DAY,
        status: 'open'
      }
    ]);
    // A depends on B (B blocks A)
    seed(harness, timelineDetailId('A'), [
      {
        id: 'A',
        dependencies: [{ id: 'B', dependency_type: 'blocks' }],
        dependents: []
      }
    ]);
    const view = createTimelineView(
      mount,
      null,
      () => {},
      subs,
      /** @type {any} */ (harness)
    );
    view.__setNow(NOW);
    await view.load();
    // Click A's bar
    const rowA = mount.querySelector(
      '.timeline-row--issue[data-issue-id="A"] .timeline-bar'
    );
    /** @type {HTMLElement} */ (rowA).click();
    // B's bar becomes a blocker; Z's row dims
    expect(
      mount.querySelector(
        '.timeline-row--issue[data-issue-id="B"] .timeline-bar.is-blocker'
      )
    ).toBeTruthy();
    expect(
      mount.querySelector('.timeline-row--issue[data-issue-id="Z"].is-dim')
    ).toBeTruthy();
    // A itself is selected
    expect(
      mount.querySelector('.timeline-row--issue[data-issue-id="A"].is-selected')
    ).toBeTruthy();
  });

  test('overdue open issue gets overdue bar class', async () => {
    const harness = makeHarness();
    const subs = createSubscriptionStore(async () => {});
    seed(harness, TIMELINE_ISSUES_ID, [
      {
        id: 'A',
        title: 'Late',
        created_at: NOW - 10 * DAY,
        due_at: NOW - 2 * DAY,
        status: 'open'
      }
    ]);
    const view = createTimelineView(
      mount,
      null,
      () => {},
      subs,
      /** @type {any} */ (harness)
    );
    view.__setNow(NOW);
    await view.load();
    expect(mount.querySelector('.timeline-bar--overdue')).toBeTruthy();
  });
});
