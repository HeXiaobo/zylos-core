import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const RECEIVE = fileURLToPath(new URL('../c4-receive.js', import.meta.url));
const SEND = fileURLToPath(new URL('../c4-send.js', import.meta.url));

function parseLastJson(stdout) {
  return JSON.parse(stdout.trim().split('\n').filter(line => line.startsWith('{')).at(-1));
}

test('c4 receive opens one durable stream and c4 send completes through the legacy answer path', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-assistant-e2e-'));
  try {
    const scripts = path.join(temp, '.claude', 'skills', 'feishu', 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'send.js'), `
import fs from 'node:fs';
import path from 'node:path';
fs.writeFileSync(path.join(process.env.ZYLOS_DIR, 'send-result.json'), JSON.stringify({
  args: process.argv.slice(2),
  requestId: process.env.C4_ASSISTANT_REQUEST_ID || null,
}));
`);
    const env = { ...process.env, ZYLOS_DIR: temp };
    const receiveArgs = [
      RECEIVE,
      '--channel', 'feishu',
      '--endpoint', 'oc_1|type:p2p|msg:om_1',
      '--assistant-request-id', 'assistant.feishu.om_1',
      '--assistant-source-id', 'om_1',
      '--json',
      '--content', 'hello',
    ];
    const first = spawnSync('node', receiveArgs, { env, encoding: 'utf8' });
    const replay = spawnSync('node', receiveArgs, { env, encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.equal(replay.status, 0, replay.stderr || replay.stdout);
    const firstJson = parseLastJson(first.stdout);
    const replayJson = parseLastJson(replay.stdout);
    assert.equal(firstJson.assistantResponse.replayed, false);
    assert.equal(replayJson.assistantResponse.replayed, true);
    assert.equal(firstJson.id, replayJson.id);

    const send = spawnSync('node', [
      SEND,
      'feishu',
      'oc_1|type:p2p|msg:om_1',
      '--request-id', 'assistant.feishu.om_1',
    ], { env, input: '完整答案', encoding: 'utf8' });
    assert.equal(send.status, 0, send.stderr || send.stdout);
    const adapter = JSON.parse(fs.readFileSync(path.join(temp, 'send-result.json'), 'utf8'));
    assert.equal(adapter.requestId, 'assistant.feishu.om_1');
    assert.deepEqual(adapter.args, ['oc_1|type:p2p|msg:om_1', '完整答案']);

    const database = new Database(path.join(temp, 'comm-bridge', 'c4.db'));
    const conversations = database.prepare('SELECT count(*) AS count FROM conversations WHERE direction = \'in\'').get().count;
    const events = database.prepare(`
      SELECT event_type FROM assistant_response_events
      WHERE request_id = 'assistant.feishu.om_1'
      ORDER BY sequence
    `).all().map(row => row.event_type);
    database.close();
    assert.equal(conversations, 1);
    assert.deepEqual(events, [
      'AssistantRequestAccepted',
      'RunQueued',
      'RunStarted',
      'RunCompleted',
    ]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('unavailable runtime produces a durable failed terminal without a second channel send', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-assistant-unavailable-'));
  try {
    const skillDirectory = path.join(temp, '.claude', 'skills', 'feishu');
    const activityDirectory = path.join(temp, 'activity-monitor');
    fs.mkdirSync(skillDirectory, { recursive: true });
    fs.mkdirSync(activityDirectory, { recursive: true });
    fs.writeFileSync(path.join(activityDirectory, 'agent-status.json'), JSON.stringify({
      health: 'rate_limited',
      unavailable_reason: 'quota',
    }));
    const env = { ...process.env, ZYLOS_DIR: temp };
    const receiveArgs = [
      RECEIVE,
      '--channel', 'feishu',
      '--endpoint', 'oc_1|type:p2p|msg:om_unavailable',
      '--assistant-request-id', 'assistant.feishu.om_unavailable',
      '--assistant-source-id', 'om_unavailable',
      '--json',
      '--content', 'hello while unavailable',
    ];
    const result = spawnSync('node', receiveArgs, { env, encoding: 'utf8' });
    const replay = spawnSync('node', receiveArgs, { env, encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(replay.status, 0, replay.stderr || replay.stdout);
    const response = parseLastJson(result.stdout);
    const replayResponse = parseLastJson(replay.stdout);
    assert.equal(response.action, 'delivered');
    assert.deepEqual(response.assistantResponse.events.map(item => item.type), [
      'AssistantRequestAccepted',
      'RunQueued',
      'RunFailed',
    ]);
    assert.deepEqual(response.assistantResponse.events.at(-1).payload, {
      code: 'RUNTIME_UNAVAILABLE',
      retryable: true,
    });
    assert.equal(replayResponse.assistantResponse.replayed, true);
    assert.deepEqual(replayResponse.assistantResponse.events.map(item => item.type), [
      'AssistantRequestAccepted',
      'RunQueued',
      'RunFailed',
    ]);

    const database = new Database(path.join(temp, 'comm-bridge', 'c4.db'));
    const request = database.prepare(`
      SELECT status FROM assistant_requests
      WHERE request_id = 'assistant.feishu.om_unavailable'
    `).get();
    const outbound = database.prepare(`
      SELECT count(*) AS count FROM conversations WHERE direction = 'out'
    `).get().count;
    database.close();
    assert.equal(request.status, 'failed');
    assert.equal(outbound, 0);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
