/**
 * Timeline model — composes Gantt rows from the push stores.
 *
 * Inputs mirror what the existing Epics view already has access to:
 * - `epics`: epic entities from the `tab:timeline:epics` (`epics`) subscription.
 * - `childrenFor(id)`: children of an epic, sourced from its `detail:{id}`
 *   subscription's `dependents` array (parent-child links).
 * - `allIssues`: every issue from the `tab:timeline:issues` (`all-issues`)
 *   subscription — the authoritative source for bar geometry + orphan rows.
 *
 * Output is an ordered list of groups (epic + its children) plus an
 * "Ungrouped" lane of issues that belong to no epic.
 */
import { computeBar, spanBars } from '../utils/timeline-scale.js';

/**
 * @typedef {{ id: string, title?: string, status?: string, issue_type?: string,
 *   priority?: number, created_at?: unknown, due_at?: unknown, closed_at?: unknown,
 *   estimated_minutes?: number, dependents?: any[], dependency_type?: string }} IssueLike
 */

/**
 * @typedef {Object} Row
 * @property {IssueLike} issue
 * @property {import('../utils/timeline-scale.js').Bar} bar
 */

/**
 * @typedef {Object} Group
 * @property {IssueLike} epic
 * @property {import('../utils/timeline-scale.js').Bar} bar - Spanning bar.
 * @property {Row[]} children
 * @property {number} total
 * @property {number} closed
 */

/**
 * @typedef {Object} TimelineModel
 * @property {Group[]} groups
 * @property {Row[]} ungrouped
 * @property {import('../utils/timeline-scale.js').Bar[]} bars - All bars (for domain).
 */

/**
 * Build the ordered timeline model.
 *
 * @param {{
 *   epics: IssueLike[],
 *   childrenFor: (epic_id: string) => IssueLike[],
 *   allIssues: IssueLike[],
 *   now: number
 * }} input
 * @returns {TimelineModel}
 */
export function buildTimelineModel(input) {
  const { epics, childrenFor, allIssues, now } = input;
  const epic_list = Array.isArray(epics) ? epics : [];
  const all_list = Array.isArray(allIssues) ? allIssues : [];

  // Authoritative bar data keyed by id (all-issues is fully normalized).
  /** @type {Map<string, IssueLike>} */
  const by_id = new Map();
  for (const it of all_list) {
    if (it && typeof it.id === 'string' && it.id.length > 0) {
      by_id.set(it.id, it);
    }
  }

  /** @type {Set<string>} ids that belong to some epic (so they leave Ungrouped). */
  const claimed = new Set();
  /** @type {Set<string>} epic ids (never appear as their own children/orphans). */
  const epic_ids = new Set();
  for (const e of epic_list) {
    if (e && typeof e.id === 'string') {
      epic_ids.add(e.id);
    }
  }

  /** @type {Group[]} */
  const groups = [];
  /** @type {import('../utils/timeline-scale.js').Bar[]} */
  const bars = [];

  for (const epic of epic_list) {
    const epic_id = String(epic?.id || '');
    if (!epic_id) {
      continue;
    }
    const raw_children = childrenFor(epic_id) || [];
    /** @type {Row[]} */
    const children = [];
    let closed = 0;
    for (const child of raw_children) {
      const cid = String(child?.id || '');
      if (!cid || epic_ids.has(cid)) {
        continue;
      }
      claimed.add(cid);
      // Prefer authoritative all-issues entry; fall back to the dependent.
      const issue = by_id.get(cid) || child;
      const bar = computeBar(issue, now);
      if (bar.is_closed) {
        closed++;
      }
      children.push({ issue, bar });
      bars.push(bar);
    }
    children.sort((a, b) => a.bar.start - b.bar.start);

    const child_bars = children.map((c) => c.bar);
    const span = spanBars(child_bars, now) || computeBar(epic, now);
    bars.push(span);
    groups.push({
      epic,
      bar: span,
      children,
      total: children.length,
      closed
    });
  }

  // Order groups by their span start (earliest work first).
  groups.sort((a, b) => a.bar.start - b.bar.start);

  // Ungrouped: issues not claimed by any epic and not epics themselves.
  /** @type {Row[]} */
  const ungrouped = [];
  for (const it of all_list) {
    const id = String(it?.id || '');
    if (!id || claimed.has(id) || epic_ids.has(id)) {
      continue;
    }
    if (String(it?.issue_type || '') === 'epic') {
      continue;
    }
    const bar = computeBar(it, now);
    ungrouped.push({ issue: it, bar });
    bars.push(bar);
  }
  ungrouped.sort((a, b) => a.bar.start - b.bar.start);

  return { groups, ungrouped, bars };
}

/**
 * Collect the set of issue ids linked to a focus issue, partitioned by role,
 * from whatever detail entity is available in the store.
 *
 * - `blockers`: issues this one depends on (its `dependencies` of type blocks).
 * - `blocked`: issues that depend on this one (its `dependents` of type blocks).
 *
 * Parent-child links are ignored (they drive grouping, not the dep highlight).
 *
 * @param {IssueLike | undefined | null} detail
 * @returns {{ blockers: Set<string>, blocked: Set<string> }}
 */
export function dependencyHighlight(detail) {
  const blockers = new Set();
  const blocked = new Set();
  if (!detail || typeof detail !== 'object') {
    return { blockers, blocked };
  }
  const deps = Array.isArray(/** @type {any} */ (detail).dependencies)
    ? /** @type {any[]} */ (/** @type {any} */ (detail).dependencies)
    : [];
  for (const d of deps) {
    if (!d || typeof d.id !== 'string') {
      continue;
    }
    if (String(d.dependency_type || '') === 'parent-child') {
      continue;
    }
    blockers.add(d.id);
  }
  const dependents = Array.isArray(/** @type {any} */ (detail).dependents)
    ? /** @type {any[]} */ (/** @type {any} */ (detail).dependents)
    : [];
  for (const d of dependents) {
    if (!d || typeof d.id !== 'string') {
      continue;
    }
    if (String(d.dependency_type || '') === 'parent-child') {
      continue;
    }
    blocked.add(d.id);
  }
  return { blockers, blocked };
}
