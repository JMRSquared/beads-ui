import { describe, expect, test } from 'vitest';
import { createSubscriptionIssueStore } from '../data/subscription-issue-store.js';
import { boardStatusClientId, createBoardView } from './board.js';

/**
 * Minimal statuses provider stub for the board's dynamic swimlanes.
 *
 * @param {Array<{ name: string, category?: string, icon?: string, label?: string }>} list
 */
function stubStatusesProvider(list) {
  return {
    getStatuses: async () =>
      list.map((s) => ({
        name: s.name,
        category: s.category || '',
        icon: s.icon || '',
        label: s.label || s.name
      }))
  };
}

/** Common swimlane set used across tests. */
const STATUSES = [
  { name: 'blocked', category: 'wip', label: 'Blocked' },
  { name: 'open', category: 'active', label: 'Open' },
  { name: 'in_progress', category: 'wip', label: 'In progress' },
  { name: 'closed', category: 'done', label: 'Closed' }
];

function createTestIssueStores() {
  /** @type {Map<string, any>} */
  const stores = new Map();
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /**
   * @param {string} id
   * @returns {any}
   */
  function getStore(id) {
    let s = stores.get(id);
    if (!s) {
      s = createSubscriptionIssueStore(id);
      stores.set(id, s);
      s.subscribe(() => {
        for (const fn of Array.from(listeners)) {
          try {
            fn();
          } catch {
            /* ignore */
          }
        }
      });
    }
    return s;
  }
  return {
    getStore,
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
 * Push a status snapshot into the per-subscription store backing a swimlane.
 *
 * @param {ReturnType<typeof createTestIssueStores>} issueStores
 * @param {string} status
 * @param {any[]} issues
 */
function pushStatus(issueStores, status, issues) {
  const id = boardStatusClientId(status);
  issueStores.getStore(id).applyPush({
    type: 'snapshot',
    id,
    revision: 1,
    issues
  });
}

describe('views/board', () => {
  test('renders one column per bd status with sorted cards and navigates on click', async () => {
    document.body.innerHTML = '<div id="m"></div>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('m'));

    const now = Date.now();
    const issues = [
      // Blocked
      {
        id: 'B-2',
        title: 'b2',
        priority: 1,
        created_at: new Date('2025-10-22T07:00:00.000Z').getTime(),
        updated_at: new Date('2025-10-22T07:00:00.000Z').getTime(),
        issue_type: 'task'
      },
      {
        id: 'B-1',
        title: 'b1',
        priority: 0,
        created_at: new Date('2025-10-21T07:00:00.000Z').getTime(),
        updated_at: new Date('2025-10-21T07:00:00.000Z').getTime(),
        issue_type: 'bug'
      },
      // Open
      {
        id: 'R-2',
        title: 'r2',
        priority: 1,
        created_at: new Date('2025-10-20T08:00:00.000Z').getTime(),
        updated_at: new Date('2025-10-20T08:00:00.000Z').getTime(),
        issue_type: 'task'
      },
      {
        id: 'R-1',
        title: 'r1',
        priority: 0,
        created_at: new Date('2025-10-21T08:00:00.000Z').getTime(),
        updated_at: new Date('2025-10-21T08:00:00.000Z').getTime(),
        issue_type: 'bug'
      },
      {
        id: 'R-3',
        title: 'r3',
        priority: 1,
        created_at: new Date('2025-10-22T08:00:00.000Z').getTime(),
        updated_at: new Date('2025-10-22T08:00:00.000Z').getTime(),
        issue_type: 'feature'
      },
      // In progress
      {
        id: 'P-1',
        title: 'p1',
        created_at: new Date('2025-10-23T09:00:00.000Z').getTime(),
        updated_at: new Date('2025-10-23T09:00:00.000Z').getTime(),
        issue_type: 'task'
      },
      {
        id: 'P-2',
        title: 'p2',
        created_at: new Date('2025-10-22T09:00:00.000Z').getTime(),
        updated_at: new Date('2025-10-22T09:00:00.000Z').getTime(),
        issue_type: 'feature'
      },
      // Closed
      {
        id: 'C-2',
        title: 'c2',
        updated_at: new Date('2025-10-20T09:00:00.000Z').getTime(),
        closed_at: new Date(now).getTime(),
        issue_type: 'task'
      },
      {
        id: 'C-1',
        title: 'c1',
        updated_at: new Date('2025-10-21T09:00:00.000Z').getTime(),
        closed_at: new Date(now - 1000).getTime(),
        issue_type: 'bug'
      }
    ];
    const issueStores = createTestIssueStores();
    pushStatus(
      issueStores,
      'blocked',
      issues.filter((i) => i.id.startsWith('B-'))
    );
    pushStatus(
      issueStores,
      'open',
      issues.filter((i) => i.id.startsWith('R-'))
    );
    pushStatus(
      issueStores,
      'in_progress',
      issues.filter((i) => i.id.startsWith('P-'))
    );
    pushStatus(
      issueStores,
      'closed',
      issues.filter((i) => i.id.startsWith('C-'))
    );

    /** @type {string[]} */
    const navigations = [];
    const view = createBoardView(
      mount,
      null,
      (id) => {
        navigations.push(id);
      },
      undefined,
      issueStores,
      undefined,
      stubStatusesProvider(STATUSES)
    );

    await view.load();

    // Blocked: priority asc, then created_at asc for equal priority
    const blocked_ids = Array.from(
      mount.querySelectorAll('#status-col-blocked .board-card .mono')
    ).map((el) => el.textContent?.trim());
    expect(blocked_ids).toEqual(['B-1', 'B-2']);

    // Open: priority asc, then created_at asc for equal priority
    const open_ids = Array.from(
      mount.querySelectorAll('#status-col-open .board-card .mono')
    ).map((el) => el.textContent?.trim());
    expect(open_ids).toEqual(['R-1', 'R-2', 'R-3']);

    // In progress: priority asc (default), then created_at asc
    const prog_ids = Array.from(
      mount.querySelectorAll('#status-col-in_progress .board-card .mono')
    ).map((el) => el.textContent?.trim());
    expect(prog_ids).toEqual(['P-2', 'P-1']);

    // Closed: closed_at desc
    const closed_ids = Array.from(
      mount.querySelectorAll('#status-col-closed .board-card .mono')
    ).map((el) => el.textContent?.trim());
    expect(closed_ids).toEqual(['C-2', 'C-1']);

    // Click navigates
    const first_open = /** @type {HTMLElement|null} */ (
      mount.querySelector('#status-col-open .board-card')
    );
    first_open?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(navigations[0]).toBe('R-1');
  });

  test('shows column count badges next to titles', async () => {
    document.body.innerHTML = '<div id="m"></div>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('m'));

    const now = Date.now();
    const issueStores = createTestIssueStores();
    pushStatus(issueStores, 'blocked', [
      {
        id: 'B-1',
        title: 'blocked 1',
        created_at: now - 5,
        updated_at: now - 5,
        issue_type: 'task'
      },
      {
        id: 'B-2',
        title: 'blocked 2',
        created_at: now - 4,
        updated_at: now - 4,
        issue_type: 'task'
      }
    ]);
    pushStatus(issueStores, 'open', [
      {
        id: 'R-1',
        title: 'open 1',
        created_at: now - 3,
        updated_at: now - 3,
        issue_type: 'feature'
      },
      {
        id: 'R-2',
        title: 'open 2',
        created_at: now - 2,
        updated_at: now - 2,
        issue_type: 'task'
      },
      {
        id: 'R-3',
        title: 'open 3',
        created_at: now - 1,
        updated_at: now - 1,
        issue_type: 'task'
      }
    ]);
    pushStatus(issueStores, 'in_progress', [
      {
        id: 'P-1',
        title: 'progress 1',
        created_at: now,
        updated_at: now,
        issue_type: 'feature'
      }
    ]);
    pushStatus(issueStores, 'closed', [
      {
        id: 'C-1',
        title: 'closed 1',
        updated_at: now,
        closed_at: now,
        issue_type: 'chore'
      }
    ]);

    const view = createBoardView(
      mount,
      null,
      () => {},
      undefined,
      issueStores,
      undefined,
      stubStatusesProvider(STATUSES)
    );

    await view.load();

    const blocked_count = mount
      .querySelector('#status-col-blocked .board-column__count')
      ?.textContent?.trim();
    const open_count = mount
      .querySelector('#status-col-open .board-column__count')
      ?.textContent?.trim();
    const in_progress_count = mount
      .querySelector('#status-col-in_progress .board-column__count')
      ?.textContent?.trim();
    const closed_count = mount
      .querySelector('#status-col-closed .board-column__count')
      ?.textContent?.trim();

    expect(blocked_count).toBe('2');
    expect(open_count).toBe('3');
    expect(in_progress_count).toBe('1');
    expect(closed_count).toBe('1');

    const closed_label = mount
      .querySelector('#status-col-closed .board-column__count')
      ?.getAttribute('aria-label');
    expect(closed_label).toBe('1 issue');
  });

  test('renders custom statuses as swimlanes and drag-drop sets target status', async () => {
    document.body.innerHTML = '<div id="m"></div>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('m'));

    const statuses = [
      { name: 'open', category: 'active', label: 'Open' },
      { name: 'in_review', category: 'active', label: 'In review' },
      { name: 'closed', category: 'done', label: 'Closed' }
    ];

    const issueStores = createTestIssueStores();
    pushStatus(issueStores, 'open', [
      {
        id: 'X-1',
        title: 'x1',
        created_at: 1,
        updated_at: 1,
        issue_type: 'task'
      }
    ]);

    /** @type {Array<{ type: string, payload: any }>} */
    const sent = [];
    /**
     * @param {string} type
     * @param {unknown} payload
     */
    const transport = async (type, payload) => {
      sent.push({ type, payload });
      return {};
    };

    const view = createBoardView(
      mount,
      null,
      () => {},
      undefined,
      issueStores,
      transport,
      stubStatusesProvider(statuses)
    );

    await view.load();

    // Custom status column exists
    const review_col = mount.querySelector('#status-col-in_review');
    expect(review_col).not.toBeNull();
    expect(review_col?.getAttribute('data-status')).toBe('in_review');

    // Drag a card from open onto the in_review column → update-status
    const data = new Map();
    const dataTransfer = {
      /**
       * @param {string} k - key
       * @param {string} v - value
       */
      setData: (k, v) => data.set(k, v),
      /** @param {string} k - key */
      getData: (k) => data.get(k) || '',
      effectAllowed: '',
      dropEffect: ''
    };
    const card = /** @type {HTMLElement} */ (
      mount.querySelector('#status-col-open .board-card')
    );
    card.dispatchEvent(
      Object.assign(new Event('dragstart', { bubbles: true }), { dataTransfer })
    );
    const review_body = /** @type {HTMLElement} */ (
      mount.querySelector('#status-col-in_review .board-column__body')
    );
    review_body.dispatchEvent(
      Object.assign(new Event('drop', { bubbles: true }), { dataTransfer })
    );

    // Allow the async transport call to settle
    await Promise.resolve();

    expect(sent).toContainEqual({
      type: 'update-status',
      payload: { id: 'X-1', status: 'in_review' }
    });
  });
});
