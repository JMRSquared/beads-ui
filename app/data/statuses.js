/**
 * @import { MessageType } from '../protocol.js'
 */
import { debug } from '../utils/logging.js';
import { humanizeStatus } from '../utils/status.js';

/**
 * A single board swimlane status, normalized from `bd statuses --json`.
 *
 * @typedef {{
 *   name: string,
 *   category: 'active'|'wip'|'done'|'frozen'|string,
 *   icon: string,
 *   label: string
 * }} BoardStatus
 */

/**
 * Fallback statuses used when bd cannot be queried. Mirrors bd's built-in set
 * and order so the board still renders coherent swimlanes offline.
 *
 * @type {BoardStatus[]}
 */
export const DEFAULT_STATUSES = [
  { name: 'open', category: 'active', icon: '○', label: 'Open' },
  { name: 'in_progress', category: 'wip', icon: '◐', label: 'In progress' },
  { name: 'blocked', category: 'wip', icon: '●', label: 'Blocked' },
  { name: 'deferred', category: 'frozen', icon: '❄', label: 'Deferred' },
  { name: 'closed', category: 'done', icon: '✓', label: 'Closed' },
  { name: 'pinned', category: 'frozen', icon: '📌', label: 'Pinned' },
  { name: 'hooked', category: 'wip', icon: '◇', label: 'Hooked' }
];

/**
 * Normalize raw `bd statuses --json` output into an ordered list of swimlane
 * statuses. Built-in statuses come first (in bd's semantic order), then any
 * custom statuses configured via `bd config set status.custom`.
 *
 * @param {unknown} raw
 * @returns {BoardStatus[]}
 */
export function normalizeStatuses(raw) {
  if (!raw || typeof raw !== 'object') {
    return DEFAULT_STATUSES.slice();
  }
  const any =
    /** @type {{ built_in_statuses?: unknown, custom_statuses?: unknown }} */ (
      raw
    );
  const built_in = Array.isArray(any.built_in_statuses)
    ? any.built_in_statuses
    : [];
  const custom = Array.isArray(any.custom_statuses) ? any.custom_statuses : [];

  /** @type {BoardStatus[]} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const entry of [...built_in, ...custom]) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const e =
      /** @type {{ name?: unknown, category?: unknown, icon?: unknown }} */ (
        entry
      );
    const name = String(e.name ?? '').trim();
    if (name.length === 0 || seen.has(name)) {
      continue;
    }
    seen.add(name);
    out.push({
      name,
      category: typeof e.category === 'string' ? e.category : '',
      icon: typeof e.icon === 'string' ? e.icon : '',
      label: humanizeStatus(name)
    });
  }
  return out.length > 0 ? out : DEFAULT_STATUSES.slice();
}

/**
 * Create a statuses provider that fetches and caches bd's configured statuses
 * over the ws transport. The cache is per-workspace; call {@link clear} on
 * workspace change to force a refetch.
 *
 * @param {(type: MessageType, payload?: unknown) => Promise<unknown>} transport
 * @returns {{ getStatuses: () => Promise<BoardStatus[]>, clear: () => void }}
 */
export function createStatusesProvider(transport) {
  const log = debug('data:statuses');
  /** @type {BoardStatus[] | null} */
  let cache = null;
  /** @type {Promise<BoardStatus[]> | null} */
  let inflight = null;

  async function getStatuses() {
    if (cache) {
      return cache;
    }
    if (inflight) {
      return inflight;
    }
    inflight = (async () => {
      try {
        const raw = await transport('get-statuses');
        const statuses = normalizeStatuses(raw);
        cache = statuses;
        return statuses;
      } catch (err) {
        log('get-statuses failed, using defaults: %o', err);
        return DEFAULT_STATUSES.slice();
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function clear() {
    cache = null;
    inflight = null;
  }

  return { getStatuses, clear };
}
