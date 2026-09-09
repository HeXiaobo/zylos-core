import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

import { openAssistantResponseStream } from '../../../skills/comm-bridge/scripts/assistant-response-stream.js';

const SEND_CLI = fileURLToPath(
  new URL('../../../skills/comm-bridge/scripts/c4-send.js', import.meta.url),
);
const STREAM_MODULE = pathToFileURL(
  fileURLToPath(new URL('../../../skills/comm-bridge/scripts/assistant-response-stream.js', import.meta.url)),
).href;

function withTmpDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-request-id-observability-'));
  try {
    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function setupMockChannel(tmpDir, channelName) {
  const skillDir = path.join(tmpDir, '.claude', 'skills', channelName, 'scripts');
  fs.mkdirSync(skillDir, { recursive: true });
  const sentFile = path.join(tmpDir, `${channelName}-sent.json`);
  fs.writeFileSync(path.join(skillDir, 'send.js'), `
    import fs from 'fs';
    fs.writeFileSync(${JSON.stringify(sentFile)}, JSON.stringify({
      args: process.argv.slice(2),
      assistantRequestId: process.env.C4_ASSISTANT_REQUEST_ID || null,
    }));
    process.exit(0);
  `);
  return sentFile;
}

// Seed the stream store exactly the way production does: through the module
// with ZYLOS_DIR pointing at the same root the spawned CLI will resolve.
function seedAssistantRequest(tmpDir, { channel, endpointId, requestId = 'assistant.mock.om_1' }) {
  const script = `
    import { openAssistantResponseStream } from ${JSON.stringify(STREAM_MODULE)};
    const stream = openAssistantResponseStream();
    stream.execute({
      type: 'AcceptAssistantRequest',
      requestId: ${JSON.stringify(requestId)},
      sourceId: 'om_1',
      route: { channel: ${JSON.stringify(channel)}, endpointId: ${JSON.stringify(endpointId)} },
      conversation: { content: '[mock] hi', status: 'pending', priority: 3, requireIdle: false },
    });
    stream.close();
  `;
  const result = spawnSync('node', ['--input-type=module', '-e', script], {
    env: { ...process.env, ZYLOS_DIR: tmpDir },
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
}

function runSend(tmpDir, args, input = 'Hello!\n') {
  return spawnSync('node', [SEND_CLI, ...args], {
    env: { ...process.env, ZYLOS_DIR: tmpDir },
    encoding: 'utf8',
    input,
    timeout: 15_000,
  });
}

function queryRequest(tmpDir, requestId) {
  const script = `
    import { openAssistantResponseStream } from ${JSON.stringify(STREAM_MODULE)};
    const stream = openAssistantResponseStream();
    const result = stream.query({ requestId: ${JSON.stringify(requestId)} });
    stream.close();
    console.log(JSON.stringify(result ? result.request : null));
  `;
  const result = spawnSync('node', ['--input-type=module', '-e', script], {
    env: { ...process.env, ZYLOS_DIR: tmpDir },
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

describe('an explicit send without --request-id must not silently decouple from an open assistant request (issue #26)', () => {
  it('warns out loud when the target route still has an open request', () => {
    withTmpDir((tmpDir) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');
      seedAssistantRequest(tmpDir, { channel: 'mock-channel', endpointId: 'endpoint1' });

      const result = runSend(tmpDir, ['mock-channel', 'endpoint1']);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(
        result.stderr.includes('assistant request assistant.mock.om_1 is still queued'),
        `expected a decoupling warning, got: ${result.stderr}`,
      );
      assert.ok(result.stderr.includes('no --request-id'), result.stderr);
      // The send itself stays legitimate: delivered as a plain message.
      const sent = JSON.parse(fs.readFileSync(sentFile, 'utf8'));
      assert.equal(sent.assistantRequestId, null);
      assert.deepEqual(sent.args, ['endpoint1', 'Hello!']);
    });
  });

  it('stays silent when no open request exists for the route', () => {
    withTmpDir((tmpDir) => {
      setupMockChannel(tmpDir, 'mock-channel');
      const result = runSend(tmpDir, ['mock-channel', 'endpoint1']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr.includes('no --request-id'), false, result.stderr);
    });
  });

  it('does not warn when the send carries its --request-id', () => {
    withTmpDir((tmpDir) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');
      seedAssistantRequest(tmpDir, { channel: 'mock-channel', endpointId: 'endpoint1' });

      const result = runSend(tmpDir, [
        'mock-channel', 'endpoint1', '--request-id', 'assistant.mock.om_1',
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr.includes('no --request-id'), false, result.stderr);
      const sent = JSON.parse(fs.readFileSync(sentFile, 'utf8'));
      assert.equal(sent.assistantRequestId, 'assistant.mock.om_1');
      // And the send terminates the request as the reply contract demands.
      assert.equal(queryRequest(tmpDir, 'assistant.mock.om_1').status, 'completed');
    });
  });

  it('does not warn for other endpoints or terminal requests on the route', () => {
    withTmpDir((tmpDir) => {
      setupMockChannel(tmpDir, 'mock-channel');
      seedAssistantRequest(tmpDir, { channel: 'mock-channel', endpointId: 'endpoint1' });
      // Terminate the seeded request, then send again on the same route.
      const complete = `
        import { openAssistantResponseStream } from ${JSON.stringify(STREAM_MODULE)};
        const stream = openAssistantResponseStream();
        stream.execute({
          type: 'CompleteRun',
          requestId: 'assistant.mock.om_1',
          output: 'done',
        });
        stream.close();
      `;
      const terminate = spawnSync('node', ['--input-type=module', '-e', complete], {
        env: { ...process.env, ZYLOS_DIR: tmpDir },
        encoding: 'utf8',
        timeout: 15_000,
      });
      assert.equal(terminate.status, 0, terminate.stderr);

      const result = runSend(tmpDir, ['mock-channel', 'endpoint1']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr.includes('no --request-id'), false, result.stderr);
    });
  });
});

describe('queryOpenRequestByRoute surfaces the open request behind a route (issue #26)', () => {
  it('returns the open request and clears once the request reaches a terminal', () => {
    const stream = openAssistantResponseStream({ dbPath: ':memory:', clock: () => 6_000 });
    try {
      stream.execute({
        type: 'AcceptAssistantRequest',
        requestId: 'assistant.feishu.route_1',
        sourceId: 'route_1',
        route: { channel: 'feishu', endpointId: 'oc_route' },
        conversation: {
          content: '[Feishu DM] hi',
          status: 'pending',
          priority: 3,
          requireIdle: false,
        },
      });
      assert.deepEqual(
        stream.queryOpenRequestByRoute({ channel: 'feishu', endpointId: 'oc_route' }),
        { requestId: 'assistant.feishu.route_1', status: 'queued' },
      );
      assert.equal(
        stream.queryOpenRequestByRoute({ channel: 'feishu', endpointId: 'oc_other' }),
        null,
      );
      assert.equal(
        stream.queryOpenRequestByRoute({ channel: 'telegram', endpointId: 'oc_route' }),
        null,
      );

      stream.execute({ type: 'CompleteRun', requestId: 'assistant.feishu.route_1', output: 'done' });
      assert.equal(
        stream.queryOpenRequestByRoute({ channel: 'feishu', endpointId: 'oc_route' }),
        null,
        'terminal requests must stop matching',
      );
    } finally {
      stream.close();
    }
  });

  it('validates its arguments', () => {
    const stream = openAssistantResponseStream({ dbPath: ':memory:' });
    try {
      assert.throws(() => stream.queryOpenRequestByRoute({ channel: '', endpointId: 'x' }), TypeError);
      assert.throws(() => stream.queryOpenRequestByRoute({ channel: 'feishu' }), TypeError);
    } finally {
      stream.close();
    }
  });
});
