import { describe, expect, test } from 'vitest';
import {
  DEFAULT_STATUSES,
  createStatusesProvider,
  normalizeStatuses
} from './statuses.js';

describe('data/statuses normalizeStatuses', () => {
  test('orders built-in statuses first, then custom, and humanizes labels', () => {
    const raw = {
      built_in_statuses: [
        { name: 'open', category: 'active', icon: '○' },
        { name: 'in_progress', category: 'wip', icon: '◐' }
      ],
      custom_statuses: [{ name: 'qa_testing', category: 'wip' }],
      schema_version: 1
    };
    const out = normalizeStatuses(raw);
    expect(out.map((s) => s.name)).toEqual([
      'open',
      'in_progress',
      'qa_testing'
    ]);
    expect(out[0].label).toBe('Open');
    expect(out[1].label).toBe('In progress');
    // Custom status name is humanized from snake_case
    expect(out[2].label).toBe('Qa Testing');
    expect(out[0].icon).toBe('○');
  });

  test('dedupes by name and skips entries without a name', () => {
    const raw = {
      built_in_statuses: [
        { name: 'open', category: 'active' },
        { name: 'open', category: 'active' },
        { category: 'wip' }
      ],
      custom_statuses: [{ name: 'open', category: 'active' }]
    };
    const out = normalizeStatuses(raw);
    expect(out.map((s) => s.name)).toEqual(['open']);
  });

  test('falls back to defaults for empty or invalid input', () => {
    expect(normalizeStatuses(null)).toEqual(DEFAULT_STATUSES);
    expect(normalizeStatuses({})).toEqual(DEFAULT_STATUSES);
    expect(normalizeStatuses([])).toEqual(DEFAULT_STATUSES);
  });
});

describe('data/statuses createStatusesProvider', () => {
  test('fetches once and caches until cleared', async () => {
    let calls = 0;
    const raw = {
      built_in_statuses: [{ name: 'open', category: 'active', icon: '○' }]
    };
    /**
     * @param {string} type
     */
    const transport = async (type) => {
      expect(type).toBe('get-statuses');
      calls += 1;
      return raw;
    };
    const provider = createStatusesProvider(transport);

    const a = await provider.getStatuses();
    const b = await provider.getStatuses();
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(a.map((s) => s.name)).toEqual(['open']);

    provider.clear();
    await provider.getStatuses();
    expect(calls).toBe(2);
  });

  test('falls back to defaults when transport rejects', async () => {
    const transport = async () => {
      throw new Error('offline');
    };
    const provider = createStatusesProvider(transport);
    const out = await provider.getStatuses();
    expect(out).toEqual(DEFAULT_STATUSES);
  });
});
