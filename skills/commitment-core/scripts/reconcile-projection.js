/**
 * Compare two platform-neutral task projections without performing I/O.
 *
 * The Interface accepts `expected` and `actual` arrays. Each normalized record
 * must provide string `key` and `state` values. Additional fields are ignored
 * so adapters keep platform-specific data outside this module. A key duplicated
 * on either side is reported as ambiguous and excluded from other comparisons.
 * The inputs are never mutated.
 *
 * @param {{expected: Array<{key: string, state: string}>, actual: Array<{key: string, state: string}>}} projections
 * @returns {{
 *   consistent: boolean,
 *   missing: Array<{key: string, state: string}>,
 *   unexpected: Array<{key: string, state: string}>,
 *   stateMismatches: Array<{key: string, expectedState: string, actualState: string}>,
 *   duplicateKeys: Array<{side: 'expected'|'actual', key: string, count: number}>
 * }}
 */
function findDuplicateKeys(records, side) {
  const counts = new Map();
  for (const { key } of records) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([key, count]) => ({ side, key, count }));
}

export function reconcileProjection({ expected, actual }) {
  const duplicateKeys = [
    ...findDuplicateKeys(expected, 'expected'),
    ...findDuplicateKeys(actual, 'actual'),
  ];
  const ambiguousKeys = new Set(duplicateKeys.map(({ key }) => key));
  const expectedKeys = new Set(expected.map((record) => record.key));
  const actualKeys = new Set(actual.map((record) => record.key));
  const actualByKey = new Map(actual.map((record) => [record.key, record]));
  const missing = expected
    .filter((record) => !ambiguousKeys.has(record.key) && !actualKeys.has(record.key))
    .map(({ key, state }) => ({ key, state }));
  const unexpected = actual
    .filter((record) => !ambiguousKeys.has(record.key) && !expectedKeys.has(record.key))
    .map(({ key, state }) => ({ key, state }));
  const stateMismatches = expected
    .filter((record) => {
      const actualRecord = actualByKey.get(record.key);
      return !ambiguousKeys.has(record.key)
        && actualRecord
        && record.state !== actualRecord.state;
    })
    .map((record) => ({
      key: record.key,
      expectedState: record.state,
      actualState: actualByKey.get(record.key).state,
    }));
  return {
    consistent: missing.length === 0
      && unexpected.length === 0
      && stateMismatches.length === 0
      && duplicateKeys.length === 0,
    missing,
    unexpected,
    stateMismatches,
    duplicateKeys,
  };
}
