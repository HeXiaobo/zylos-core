/**
 * Compare two platform-neutral task projections without performing I/O.
 *
 * The Interface accepts `expected` and `actual` arrays. Each normalized record
 * must provide non-empty string `key` and `state` values. Additional fields are
 * ignored so adapters keep platform-specific data outside this module. A key
 * duplicated on either side is reported as ambiguous and excluded from other
 * comparisons. Invalid input fails closed with TypeError; no diff is returned.
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
 * @throws {TypeError} When a projection is not an array or a record is not normalized.
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

function assertProjectionArray(records, side) {
  if (!Array.isArray(records)) {
    throw new TypeError(`${side} must be an array`);
  }
}

function assertProjectionRecords(records, side) {
  records.forEach((record, index) => {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new TypeError(`${side}[${index}] must be an object`);
    }
    if (typeof record.key !== 'string' || record.key.trim() === '') {
      throw new TypeError(`${side}[${index}].key must be a non-empty string`);
    }
    if (typeof record.state !== 'string' || record.state.trim() === '') {
      throw new TypeError(`${side}[${index}].state must be a non-empty string`);
    }
  });
}

export function reconcileProjection({ expected, actual } = {}) {
  assertProjectionArray(expected, 'expected');
  assertProjectionArray(actual, 'actual');
  assertProjectionRecords(expected, 'expected');
  assertProjectionRecords(actual, 'actual');

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
