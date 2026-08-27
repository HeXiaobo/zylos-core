import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDueAt } from '../deadline.js';

test('resolves Chinese relative deadlines against the message time zone', () => {
  const common = {
    receivedAt: '2026-08-25T02:00:00.000Z',
    timeZone: 'Asia/Shanghai',
  };
  assert.equal(
    resolveDueAt({ ...common, dueText: '明天18:00前' }),
    '2026-08-26T10:00:00.000Z',
  );
  assert.equal(
    resolveDueAt({ ...common, dueText: '本周五前' }),
    '2026-08-28T10:00:00.000Z',
  );
  assert.equal(
    resolveDueAt({ ...common, dueText: '下周一上午9点' }),
    '2026-08-31T01:00:00.000Z',
  );
});

test('uses 18:00 local time for date-only deadlines and rejects invalid dates', () => {
  const common = {
    receivedAt: '2026-08-25T02:00:00.000Z',
    timeZone: 'Asia/Shanghai',
  };
  assert.equal(
    resolveDueAt({ ...common, dueText: '8月28日前' }),
    '2026-08-28T10:00:00.000Z',
  );
  assert.throws(
    () => resolveDueAt({ ...common, dueText: '2026-02-30前' }),
    /invalid calendar date/,
  );
});
