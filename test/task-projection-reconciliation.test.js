import { describe, expect, it } from '@jest/globals';

import { reconcileProjection } from '../skills/commitment-core/scripts/reconcile-projection.js';

describe('reconcileProjection', () => {
  it('reports matching normalized task projections as consistent', () => {
    const result = reconcileProjection({
      expected: [{ key: 'task-1', state: 'ready' }],
      actual: [{ key: 'task-1', state: 'ready' }],
    });

    expect(result).toEqual({
      consistent: true,
      missing: [],
      unexpected: [],
      stateMismatches: [],
      duplicateKeys: [],
    });
  });

  it('reports tasks missing from the actual projection', () => {
    const result = reconcileProjection({
      expected: [
        { key: 'task-2', state: 'ready', platformPayload: 'ignored' },
        { key: 'task-1', state: 'done' },
      ],
      actual: [{ key: 'task-2', state: 'ready' }],
    });

    expect(result).toEqual({
      consistent: false,
      missing: [{ key: 'task-1', state: 'done' }],
      unexpected: [],
      stateMismatches: [],
      duplicateKeys: [],
    });
  });

  it('reports tasks that only exist in the actual projection', () => {
    const result = reconcileProjection({
      expected: [{ key: 'task-1', state: 'ready' }],
      actual: [
        { key: 'task-1', state: 'ready' },
        { key: 'task-2', state: 'in_progress', externalId: 'om-2' },
      ],
    });

    expect(result).toEqual({
      consistent: false,
      missing: [],
      unexpected: [{ key: 'task-2', state: 'in_progress' }],
      stateMismatches: [],
      duplicateKeys: [],
    });
  });

  it('reports state mismatches for the same task key', () => {
    const result = reconcileProjection({
      expected: [{ key: 'task-1', state: 'ready' }],
      actual: [{ key: 'task-1', state: 'done' }],
    });

    expect(result).toEqual({
      consistent: false,
      missing: [],
      unexpected: [],
      stateMismatches: [{
        key: 'task-1',
        expectedState: 'ready',
        actualState: 'done',
      }],
      duplicateKeys: [],
    });
  });

  it('reports duplicate keys in the expected projection', () => {
    const result = reconcileProjection({
      expected: [
        { key: 'task-1', state: 'ready' },
        { key: 'task-1', state: 'ready' },
      ],
      actual: [{ key: 'task-1', state: 'ready' }],
    });

    expect(result).toEqual({
      consistent: false,
      missing: [],
      unexpected: [],
      stateMismatches: [],
      duplicateKeys: [{ side: 'expected', key: 'task-1', count: 2 }],
    });
  });

  it('reports duplicate keys in the actual projection', () => {
    const result = reconcileProjection({
      expected: [{ key: 'task-1', state: 'ready' }],
      actual: [
        { key: 'task-1', state: 'ready' },
        { key: 'task-1', state: 'done' },
      ],
    });

    expect(result).toEqual({
      consistent: false,
      missing: [],
      unexpected: [],
      stateMismatches: [],
      duplicateKeys: [{ side: 'actual', key: 'task-1', count: 2 }],
    });
  });

  it('does not guess a state comparison for an ambiguous duplicate key', () => {
    const result = reconcileProjection({
      expected: [
        { key: 'task-1', state: 'ready' },
        { key: 'task-1', state: 'done' },
      ],
      actual: [{ key: 'task-1', state: 'ready' }],
    });

    expect(result).toEqual({
      consistent: false,
      missing: [],
      unexpected: [],
      stateMismatches: [],
      duplicateKeys: [{ side: 'expected', key: 'task-1', count: 2 }],
    });
  });
});
