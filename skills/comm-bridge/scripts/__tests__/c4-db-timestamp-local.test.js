import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Deterministic clock (#60): this file pins the process to a non-UTC zone so
// SQLite's 'localtime' modifier resolves against a fixed offset. node:test
// runs each file in its own process, so setting TZ before the first SQLite
// call is sufficient and does not leak into other test files.
process.env.TZ = 'Asia/Shanghai';

const ORIG_ZYLOS_DIR = process.env.ZYLOS_DIR;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-db-tz-test-'));
process.env.ZYLOS_DIR = TMP_DIR;

const mod = await import(new URL('../c4-db.js', import.meta.url));
const db = mod.getDb();

if (ORIG_ZYLOS_DIR === undefined) delete process.env.ZYLOS_DIR;
else process.env.ZYLOS_DIR = ORIG_ZYLOS_DIR;

const TZ = 'Asia/Shanghai';
const UTC_STAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function resetTables() {
  db.exec('DELETE FROM checkpoints');
  db.exec('DELETE FROM conversations');
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('checkpoints', 'conversations')");
}

// Format a stored UTC stamp ('YYYY-MM-DD HH:MM:SS') as the wall-clock string
// SQLite's datetime(…, 'localtime') must produce under the pinned TZ. Derived
// independently via Intl so the expectation does not reuse the code under test.
function expectedLocal(utcStamp) {
  const iso = `${utcStamp.replace(' ', 'T')}Z`;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function insertConv(content, channel = 'system') {
  return mod.insertConversation('in', channel, null, content);
}

describe('timestamp_local projection (#60)', () => {
  beforeEach(resetTables);

  it('getLastCheckpoint projects timestamp_local alongside the raw UTC stamp', () => {
    mod.createCheckpoint(10, 'First');
    const cp = mod.getLastCheckpoint();
    assert.match(cp.timestamp, UTC_STAMP_RE);
    assert.equal(cp.timestamp_local, expectedLocal(cp.timestamp));
  });

  it('getUnsummarizedConversations projects timestamp_local (no limit)', () => {
    insertConv('m1');
    insertConv('m2');
    for (const conv of mod.getUnsummarizedConversations()) {
      assert.match(conv.timestamp, UTC_STAMP_RE);
      assert.equal(conv.timestamp_local, expectedLocal(conv.timestamp));
    }
  });

  it('getUnsummarizedConversations projects timestamp_local (with limit)', () => {
    insertConv('m1');
    insertConv('m2');
    insertConv('m3');
    const rows = mod.getUnsummarizedConversations(2);
    assert.equal(rows.length, 2);
    for (const conv of rows) {
      assert.equal(conv.timestamp_local, expectedLocal(conv.timestamp));
    }
  });

  it('getConversationsByRange projects timestamp_local', () => {
    insertConv('m1');
    insertConv('m2');
    for (const conv of mod.getConversationsByRange(1, 2)) {
      assert.equal(conv.timestamp_local, expectedLocal(conv.timestamp));
    }
  });

  it('getRecentConversations projects timestamp_local', () => {
    insertConv('m1');
    insertConv('m2');
    for (const conv of mod.getRecentConversations(10)) {
      assert.equal(conv.timestamp_local, expectedLocal(conv.timestamp));
    }
  });

  it('formatConversations renders local stamps, not UTC', () => {
    insertConv('hello');
    const conv = mod.getRecentConversations(1)[0];
    const text = mod.formatConversations([conv]);
    assert.ok(text.includes(`[${conv.timestamp_local}] IN (system):`));
    assert.ok(!text.includes(`[${conv.timestamp}]`));
  });

  it('formatConversationsForAgent renders local stamps, not UTC', () => {
    insertConv('hello');
    const conv = mod.getRecentConversations(1)[0];
    const text = mod.formatConversationsForAgent([conv]);
    assert.ok(text.includes(`[${conv.timestamp_local}] IN (system):`));
    assert.ok(!text.includes(`[${conv.timestamp}]`));
  });

  it('formatters render a loud marker when a row skipped the projection', () => {
    const text = mod.formatConversations([{ id: 7, direction: 'in', channel: 'system', content: 'x' }]);
    assert.ok(text.includes('TZ-ERROR: missing timestamp_local (id=7)'));
  });
});
