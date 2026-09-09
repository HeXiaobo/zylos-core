import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openAssistantResponseStream } from '../assistant-response-stream.js';

const CLI_PATH = fileURLToPath(new URL('../c4-session-init.js', import.meta.url));
const RECEIVE_PATH = fileURLToPath(new URL('../c4-receive.js', import.meta.url));
const CHECKPOINT_PATH = fileURLToPath(new URL('../c4-checkpoint.js', import.meta.url));

function cli(args, env = {}) {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function receive(args, env = {}) {
  return spawnSync('node', [RECEIVE_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function checkpoint(args, env = {}) {
  return spawnSync('node', [CHECKPOINT_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function createAssistantRequest(tmpDir, {
  requestId,
  content,
  status = 'pending',
  start = false,
}) {
  const stream = openAssistantResponseStream({
    dbPath: path.join(tmpDir, 'comm-bridge', 'c4.db'),
  });
  try {
    const accepted = stream.execute({
      type: 'AcceptAssistantRequest',
      requestId,
      sourceId: `${requestId}:source`,
      route: { channel: 'telegram', endpointId: '123' },
      conversation: {
        content,
        status,
        priority: 3,
        requireIdle: false,
      },
    });
    if (start) {
      stream.execute({ type: 'StartRun', requestId });
    }
    return accepted.request;
  } finally {
    stream.close();
  }
}

function withTmpDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-session-init-'));
  const env = { ZYLOS_DIR: tmpDir };
  // Warm up DB
  checkpoint(['latest'], env);
  try {
    return fn({ tmpDir, env });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Render a stored UTC stamp ('YYYY-MM-DD HH:MM:SS') as the wall-clock string a
// process pinned to `timeZone` must show. Derived via Intl so the expectation
// does not reuse the code under test (#61).
function localFromUtc(utcStamp, timeZone) {
  const iso = `${utcStamp.replace(' ', 'T')}Z`;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
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

// -- basic behavior --

describe('c4-session-init', () => {
  it('reports no new conversations on fresh DB', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cli([], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('No new conversations since last checkpoint'));
    });
  });

  it('outputs last checkpoint summary', () => {
    withTmpDir(({ env }) => {
      receive(['--channel', 'system', '--no-reply', '--content', 'msg1'], env);
      checkpoint(['create', '1', '--summary', 'Synced first batch'], env);
      receive(['--channel', 'system', '--no-reply', '--content', 'msg2'], env);

      const { stdout, status } = cli([], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('=== LAST CHECKPOINT SUMMARY ==='));
      assert.ok(stdout.includes('=== END LAST CHECKPOINT SUMMARY ==='));
      assert.ok(stdout.includes('Synced first batch'));
      assert.ok(stdout.includes('msg2'));
    });
  });

  it('emits a fallback block when the last checkpoint has no summary', () => {
    withTmpDir(({ env }) => {
      receive(['--channel', 'system', '--no-reply', '--content', 'msg1'], env);
      // Checkpoint created without --summary → summary is null.
      checkpoint(['create', '1'], env);
      receive(['--channel', 'system', '--no-reply', '--content', 'msg2'], env);

      const { stdout, status } = cli([], env);
      assert.equal(status, 0);
      // The checkpoint block must still appear (not silently vanish).
      assert.ok(stdout.includes('=== LAST CHECKPOINT ==='));
      assert.ok(stdout.includes('no summary'));
      // And it must NOT masquerade as a summary block.
      assert.ok(!stdout.includes('=== LAST CHECKPOINT SUMMARY ==='));
    });
  });

  it('prints the no-summary fallback line in local time, not UTC (#61)', () => {
    withTmpDir(({ env }) => {
      receive(['--channel', 'system', '--no-reply', '--content', 'msg1'], env);
      // Checkpoint created without --summary → summary is null.
      checkpoint(['create', '1'], env);

      const latest = JSON.parse(checkpoint(['latest'], env).stdout);
      const expectedLocal = localFromUtc(latest.timestamp, 'Asia/Shanghai');
      assert.notEqual(expectedLocal, latest.timestamp);

      const { stdout, status } = cli([], { ...env, TZ: 'Asia/Shanghai' });
      assert.equal(status, 0);
      assert.ok(stdout.includes('=== LAST CHECKPOINT ==='));
      assert.ok(stdout.includes(`no summary — checkpoint #${latest.id}, ${expectedLocal})`));
      // The UTC clock must not leak into the startup block.
      assert.ok(!stdout.includes(latest.timestamp));
    });
  });

  it('shows recent conversations when under threshold', () => {
    withTmpDir(({ env }) => {
      for (let i = 1; i <= 3; i++) {
        receive(['--channel', 'system', '--no-reply', '--content', `msg${i}`], env);
      }

      const { stdout, status } = cli([], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('=== RECENT CONVERSATIONS ==='));
      assert.ok(stdout.includes('=== END RECENT CONVERSATIONS ==='));
      assert.ok(stdout.includes('msg1'));
      assert.ok(stdout.includes('msg2'));
      assert.ok(stdout.includes('msg3'));
      // Should NOT trigger Memory Sync instruction
      assert.ok(!stdout.includes('ACTION REQUIRED'));
    });
  });

  it('adds reply routing for inbound endpoint messages', () => {
    withTmpDir(({ tmpDir, env }) => {
      fs.mkdirSync(path.join(tmpDir, '.claude', 'skills', 'telegram'), { recursive: true });
      receive(['--channel', 'telegram', '--endpoint', '123', '--content', 'hello'], env);

      const { stdout, status } = cli([], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('hello ---- reply via: node'));
      assert.ok(stdout.includes('"telegram" "123"'));
    });
  });

  it('does not add reply routing for no-reply messages', () => {
    withTmpDir(({ env }) => {
      receive(['--channel', 'system', '--no-reply', '--content', 'system note'], env);

      const { stdout, status } = cli([], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('system note'));
      assert.ok(!stdout.includes('reply via:'));
    });
  });

  it('does not add reply routing for no-reply messages even when endpoint was provided', () => {
    withTmpDir(({ tmpDir, env }) => {
      fs.mkdirSync(path.join(tmpDir, '.claude', 'skills', 'telegram'), { recursive: true });
      receive(['--channel', 'telegram', '--endpoint', '123', '--no-reply', '--content', 'no callback'], env);

      const { stdout, status } = cli([], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('no callback'));
      assert.ok(!stdout.includes('reply via:'));
    });
  });

  it('does not duplicate legacy stored reply routing', () => {
    withTmpDir(({ tmpDir, env }) => {
      fs.mkdirSync(path.join(tmpDir, '.claude', 'skills', 'telegram'), { recursive: true });
      receive([
        '--channel', 'telegram',
        '--endpoint', '123',
        '--content', 'legacy ---- reply via: node /tmp/c4-send.js "telegram" "123"'
      ], env);

      const { stdout, status } = cli([], env);
      assert.equal(status, 0);
      assert.equal((stdout.match(/reply via:/g) || []).length, 1);
    });
  });

  it('keeps queued assistant requests out of startup context across a restart', () => {
    withTmpDir(({ tmpDir, env }) => {
      receive(['--channel', 'system', '--no-reply', '--content', 'ordinary history'], env);
      const requestId = 'assistant.telegram.queued-startup';
      createAssistantRequest(tmpDir, {
        requestId,
        content: 'queued assistant request must wait for dispatcher',
      });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const { stdout, status } = cli([], env);
        assert.equal(status, 0);
        assert.ok(stdout.includes('ordinary history'));
        assert.ok(!stdout.includes('queued assistant request must wait for dispatcher'));
        assert.ok(!stdout.includes(requestId));
      }

      const stream = openAssistantResponseStream({
        dbPath: path.join(tmpDir, 'comm-bridge', 'c4.db'),
      });
      try {
        assert.equal(stream.query({ requestId }).request.status, 'queued');
      } finally {
        stream.close();
      }
    });
  });

  it('keeps a started assistant request request-bound after a session restart', () => {
    withTmpDir(({ tmpDir, env }) => {
      const requestId = 'assistant.telegram.started-startup';
      createAssistantRequest(tmpDir, {
        requestId,
        content: 'started assistant request must be resumable',
        status: 'delivered',
        start: true,
      });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const { stdout, status } = cli([], env);
        assert.equal(status, 0);
        assert.ok(stdout.includes('started assistant request must be resumable'));
        assert.match(stdout, new RegExp(`--request-id "${requestId}"`));
        assert.ok(!stdout.includes('history and do not reply'));
      }
    });
  });

  it('triggers Memory Sync with the mechanically resolved Deployment Profile', () => {
    withTmpDir(({ tmpDir, env }) => {
      fs.mkdirSync(path.join(tmpDir, '.zylos'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '.zylos', 'config.json'),
        JSON.stringify({ profiles: { agent: 'mylos', deployment: '3ai' } }),
      );
      // CHECKPOINT_THRESHOLD is 15; insert 31 messages (well over threshold)
      for (let i = 1; i <= 31; i++) {
        receive(['--channel', 'system', '--no-reply', '--content', `msg${i}`], env);
      }

      const { stdout, status } = cli([], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('=== ACTION REQUIRED ==='));
      assert.ok(stdout.includes('zylos-memory'));
      assert.match(stdout, /Deployment Profile "3ai"/);
      assert.match(stdout, /sha256 [a-f0-9]{64}/);
      // Should show limited conversations (SESSION_INIT_RECENT_COUNT = 6)
      assert.ok(stdout.includes('msg31'));
      assert.ok(stdout.includes('msg26'));
      // msg1 should NOT be included (limited to recent)
      assert.ok(!stdout.match(/IN \(system\):\nmsg1\n/));
    });
  });
});
