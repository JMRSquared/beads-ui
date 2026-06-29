import { describe, expect, test } from 'vitest';
import { DAY_MS } from '../utils/timeline-scale.js';
import { buildTimelineModel, dependencyHighlight } from './timeline-model.js';

const NOW = Date.UTC(2026, 5, 28);

describe('data/timeline-model', () => {
  test('groups epics with children and computes spanning bar', () => {
    const epics = [{ id: 'E-1', title: 'Launch', issue_type: 'epic' }];
    /** @type {Record<string, any[]>} */
    const childMap = {
      'E-1': [
        { id: 'A', dependency_type: 'parent-child' },
        { id: 'B', dependency_type: 'parent-child' }
      ]
    };
    const allIssues = [
      { id: 'A', created_at: NOW, due_at: NOW + 4 * DAY_MS, status: 'open' },
      {
        id: 'B',
        created_at: NOW - 2 * DAY_MS,
        due_at: NOW + 8 * DAY_MS,
        status: 'open'
      },
      { id: 'C', created_at: NOW, status: 'open' } // orphan
    ];
    const model = buildTimelineModel({
      epics,
      childrenFor: (id) => childMap[id] || [],
      allIssues,
      now: NOW
    });
    expect(model.groups).toHaveLength(1);
    const g = model.groups[0];
    expect(g.children.map((c) => c.issue.id)).toEqual(['B', 'A']); // sorted by start
    expect(g.bar.start).toBe(NOW - 2 * DAY_MS);
    expect(g.bar.end).toBe(NOW + 8 * DAY_MS);
    expect(g.total).toBe(2);
    // C is the only orphan
    expect(model.ungrouped.map((r) => r.issue.id)).toEqual(['C']);
  });

  test('children pull authoritative bar data from allIssues, not the dependent stub', () => {
    const epics = [{ id: 'E-1', issue_type: 'epic' }];
    const model = buildTimelineModel({
      epics,
      childrenFor: () => [{ id: 'A', dependency_type: 'parent-child' }],
      allIssues: [
        { id: 'A', created_at: NOW, due_at: NOW + 3 * DAY_MS, status: 'open' }
      ],
      now: NOW
    });
    const child = model.groups[0].children[0];
    expect(child.bar.has_real_due).toBe(true);
    expect(child.bar.end).toBe(NOW + 3 * DAY_MS);
  });

  test('epic with no children falls back to its own bar', () => {
    const model = buildTimelineModel({
      epics: [
        { id: 'E-1', created_at: NOW, issue_type: 'epic', status: 'open' }
      ],
      childrenFor: () => [],
      allIssues: [],
      now: NOW
    });
    expect(model.groups[0].bar.start).toBe(NOW);
    expect(model.groups[0].children).toHaveLength(0);
  });

  test('epics excluded from ungrouped lane', () => {
    const model = buildTimelineModel({
      epics: [{ id: 'E-1', issue_type: 'epic' }],
      childrenFor: () => [],
      allIssues: [
        { id: 'E-1', issue_type: 'epic', created_at: NOW },
        { id: 'X', issue_type: 'task', created_at: NOW }
      ],
      now: NOW
    });
    expect(model.ungrouped.map((r) => r.issue.id)).toEqual(['X']);
  });

  test('closed child counted', () => {
    const model = buildTimelineModel({
      epics: [{ id: 'E-1', issue_type: 'epic' }],
      childrenFor: () => [
        { id: 'A', dependency_type: 'parent-child' },
        { id: 'B', dependency_type: 'parent-child' }
      ],
      allIssues: [
        { id: 'A', created_at: NOW, status: 'closed', closed_at: NOW },
        { id: 'B', created_at: NOW, status: 'open' }
      ],
      now: NOW
    });
    expect(model.groups[0].closed).toBe(1);
  });

  describe('dependencyHighlight', () => {
    test('partitions blockers and blocked, ignoring parent-child', () => {
      const detail = {
        id: 'A',
        dependencies: [
          { id: 'B', dependency_type: 'blocks' },
          { id: 'E', dependency_type: 'parent-child' }
        ],
        dependents: [{ id: 'C', dependency_type: 'blocks' }]
      };
      const { blockers, blocked } = dependencyHighlight(detail);
      expect([...blockers]).toEqual(['B']);
      expect([...blocked]).toEqual(['C']);
    });
    test('handles missing detail', () => {
      const { blockers, blocked } = dependencyHighlight(null);
      expect(blockers.size).toBe(0);
      expect(blocked.size).toBe(0);
    });
  });
});
