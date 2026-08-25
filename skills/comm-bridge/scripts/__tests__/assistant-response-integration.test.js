import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { openAssistantResponseStream } from '../assistant-response-stream.js';

const RECEIVE = fileURLToPath(new URL('../c4-receive.js', import.meta.url));
const SEND = fileURLToPath(new URL('../c4-send.js', import.meta.url));
const EVENT_CLI = fileURLToPath(new URL('../c4-assistant-event.js', import.meta.url));
const INIT_SQL = fileURLToPath(new URL('../../init-db.sql', import.meta.url));

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
  deliveryId: process.env.C4_DELIVERY_ID || null,
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
    assert.match(adapter.deliveryId, /^c4\.outbound\.\d+$/);
    assert.notEqual(adapter.deliveryId, adapter.requestId);
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

test('media delivery completes the stream without exposing its local transport path as answer text', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-assistant-media-'));
  try {
    const scripts = path.join(temp, '.claude', 'skills', 'feishu', 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'send.js'), 'process.exit(0);');
    const env = { ...process.env, ZYLOS_DIR: temp };
    const receive = spawnSync('node', [
      RECEIVE,
      '--channel', 'feishu',
      '--endpoint', 'oc_1|type:p2p|msg:om_media',
      '--assistant-request-id', 'assistant.feishu.om_media',
      '--assistant-source-id', 'om_media',
      '--json',
      '--content', 'send the report',
    ], { env, encoding: 'utf8' });
    assert.equal(receive.status, 0, receive.stderr || receive.stdout);

    const mediaCommand = '[MEDIA:file]/Users/operator/private/report.pdf';
    const send = spawnSync('node', [
      SEND,
      'feishu',
      'oc_1|type:p2p|msg:om_media',
      '--request-id', 'assistant.feishu.om_media',
    ], { env, input: mediaCommand, encoding: 'utf8' });
    assert.equal(send.status, 0, send.stderr || send.stdout);

    const database = new Database(path.join(temp, 'comm-bridge', 'c4.db'));
    const completed = database.prepare(`
      SELECT payload_json FROM assistant_response_events
      WHERE request_id = 'assistant.feishu.om_media' AND event_type = 'RunCompleted'
    `).get();
    const request = database.prepare(`
      SELECT output_text FROM assistant_requests
      WHERE request_id = 'assistant.feishu.om_media'
    `).get();
    database.close();
    assert.deepEqual(JSON.parse(completed.payload_json), { output: '' });
    assert.equal(request.output_text, '');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('a conflicting second full answer fails visibly without changing the canonical terminal output', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-assistant-terminal-conflict-'));
  try {
    const scripts = path.join(temp, '.claude', 'skills', 'feishu', 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'send.js'), 'process.exit(0);');
    const env = { ...process.env, ZYLOS_DIR: temp };
    const endpoint = 'oc_1|type:p2p|msg:om_terminal';
    const requestId = 'assistant.feishu.om_terminal';
    const receive = spawnSync('node', [
      RECEIVE,
      '--channel', 'feishu',
      '--endpoint', endpoint,
      '--assistant-request-id', requestId,
      '--assistant-source-id', 'om_terminal',
      '--json',
      '--content', 'hello',
    ], { env, encoding: 'utf8' });
    assert.equal(receive.status, 0, receive.stderr || receive.stdout);

    const first = spawnSync('node', [SEND, 'feishu', endpoint, '--request-id', requestId], {
      env,
      input: 'canonical answer',
      encoding: 'utf8',
    });
    const conflict = spawnSync('node', [SEND, 'feishu', endpoint, '--request-id', requestId], {
      env,
      input: 'different answer',
      encoding: 'utf8',
    });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.equal(conflict.status, 1, conflict.stderr || conflict.stdout);
    assert.match(conflict.stderr, /different output/);

    const database = new Database(path.join(temp, 'comm-bridge', 'c4.db'));
    const request = database.prepare(`
      SELECT status, output_text FROM assistant_requests WHERE request_id = ?
    `).get(requestId);
    database.close();
    assert.deepEqual(request, { status: 'completed', output_text: 'canonical answer' });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('an outbound message without an explicit request id cannot claim an active stream by endpoint', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-assistant-causality-'));
  try {
    const scripts = path.join(temp, '.claude', 'skills', 'feishu', 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'send.js'), `
import fs from 'node:fs';
import path from 'node:path';
fs.writeFileSync(path.join(process.env.ZYLOS_DIR, 'causality.json'), JSON.stringify({
  requestId: process.env.C4_ASSISTANT_REQUEST_ID || null,
}));
`);
    const env = { ...process.env, ZYLOS_DIR: temp };
    const endpoint = 'oc_1|type:p2p|msg:om_causal';
    const requestId = 'assistant.feishu.om_causal';
    const receive = spawnSync('node', [
      RECEIVE,
      '--channel', 'feishu',
      '--endpoint', endpoint,
      '--assistant-request-id', requestId,
      '--assistant-source-id', 'om_causal',
      '--json',
      '--content', 'user request',
    ], { env, encoding: 'utf8' });
    assert.equal(receive.status, 0, receive.stderr || receive.stdout);

    const unrelated = spawnSync('node', [SEND, 'feishu', endpoint], {
      env,
      input: 'independent health notification',
      encoding: 'utf8',
    });
    assert.equal(unrelated.status, 0, unrelated.stderr || unrelated.stdout);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(temp, 'causality.json'), 'utf8')),
      { requestId: null },
    );

    const database = new Database(path.join(temp, 'comm-bridge', 'c4.db'));
    const request = database.prepare(`
      SELECT status, output_text FROM assistant_requests WHERE request_id = ?
    `).get(requestId);
    const completed = database.prepare(`
      SELECT count(*) AS count FROM assistant_response_events
      WHERE request_id = ? AND event_type = 'RunCompleted'
    `).get(requestId).count;
    database.close();
    assert.deepEqual(request, { status: 'queued', output_text: '' });
    assert.equal(completed, 0);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('an explicit request id is rejected when its channel route does not match the send target', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-assistant-route-proof-'));
  try {
    const scripts = path.join(temp, '.claude', 'skills', 'feishu', 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'send.js'), `
import fs from 'node:fs';
import path from 'node:path';
fs.writeFileSync(path.join(process.env.ZYLOS_DIR, 'wrong-route-sent'), 'yes');
`);
    const env = { ...process.env, ZYLOS_DIR: temp };
    const requestId = 'assistant.feishu.om_route';
    const receive = spawnSync('node', [
      RECEIVE,
      '--channel', 'feishu',
      '--endpoint', 'oc_expected|type:p2p|msg:om_route',
      '--assistant-request-id', requestId,
      '--assistant-source-id', 'om_route',
      '--json',
      '--content', 'user request',
    ], { env, encoding: 'utf8' });
    assert.equal(receive.status, 0, receive.stderr || receive.stdout);

    const send = spawnSync('node', [
      SEND,
      'feishu',
      'oc_other|type:p2p|msg:om_other',
      '--request-id', requestId,
    ], { env, input: 'misrouted answer', encoding: 'utf8' });
    assert.equal(send.status, 1, send.stderr || send.stdout);
    assert.match(send.stderr, /does not match its channel route/);
    assert.equal(fs.existsSync(path.join(temp, 'wrong-route-sent')), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('operator CLI can inspect and redrive dead-letter response deliveries', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-assistant-redrive-cli-'));
  try {
    const dbPath = path.join(temp, 'comm-bridge', 'c4.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const initialDatabase = new Database(dbPath);
    initialDatabase.exec(fs.readFileSync(INIT_SQL, 'utf8'));
    initialDatabase.close();
    const stream = openAssistantResponseStream({ dbPath, clock: () => 10_000 });
    stream.execute({
      type: 'AcceptAssistantRequest',
      requestId: 'assistant.feishu.om_redrive',
      sourceId: 'om_redrive',
      route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_redrive' },
      conversation: {
        content: 'redrive me',
        status: 'pending',
        priority: 3,
        requireIdle: false,
      },
    });
    const leased = stream.claimDeliveries({ limit: 10 });
    stream.retryDeliveries(leased.map(item => ({
      deliveryId: item.deliveryId,
      leaseToken: item.leaseToken,
      error: 'adapter unavailable',
    })), { maxAttempts: 1 });
    stream.close();

    const env = { ...process.env, ZYLOS_DIR: temp };
    const query = spawnSync('node', [EVENT_CLI], {
      env,
      input: JSON.stringify({
        type: 'QueryDeliveries',
        requestId: 'assistant.feishu.om_redrive',
        status: 'dead_letter',
        limit: 10,
      }),
      encoding: 'utf8',
    });
    assert.equal(query.status, 0, query.stderr || query.stdout);
    assert.equal(parseLastJson(query.stdout).deliveries.length, 2);

    const redrive = spawnSync('node', [EVENT_CLI], {
      env,
      input: JSON.stringify({
        type: 'RedriveDeadLetters',
        requestId: 'assistant.feishu.om_redrive',
        limit: 10,
      }),
      encoding: 'utf8',
    });
    assert.equal(redrive.status, 0, redrive.stderr || redrive.stdout);
    assert.equal(parseLastJson(redrive.stdout).redriven, 2);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
