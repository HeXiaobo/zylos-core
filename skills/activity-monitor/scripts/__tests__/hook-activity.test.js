import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-activity-test-'));
const monitorDir = path.join(tmpDir, 'activity-monitor');
const eventsFile = path.join(monitorDir, 'tool-events.jsonl');

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(monitorDir, { recursive: true, force: true });
});

async function runHook(payload, nowMs = 1000) {
  process.env.ZYLOS_DIR = tmpDir;
  process.env.CLAUDE_SESSION_ID = 'env-session';
  process.env.HOOK_ACTIVITY_DISABLE_MAIN = '1';
  const modulePath = new URL('../hook-activity.js', import.meta.url);
  const { handleHookActivity } = await import(`${modulePath.href}?t=${Date.now()}-${Math.random()}`);
  handleHookActivity(payload, { nowMs, claudePid: 4242 });
}

function readEvents() {
  return fs.readFileSync(eventsFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('hook-activity', () => {
  it('uses Claude tool_use_id as event_id when present', async () => {
    await runHook({
      hook_event_name: 'PreToolUse',
      session_id: 'payload-session',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com/path' },
      tool_use_id: 'toolu_01ABC123'
    }, 1000);

    const [event] = readEvents();
    assert.equal(event.event, 'pre_tool');
    assert.equal(event.session_id, 'payload-session');
    assert.equal(event.tool, 'WebFetch');
    assert.equal(event.event_id, 'toolu_01ABC123');
    assert.deepEqual(event.summary, { type: 'url-host', value: 'example.com' });
  });

  it('falls back to a generated event_id when tool_use_id is absent', async () => {
    await runHook({
      hook_event_name: 'PreToolUse',
      session_id: 'payload-session',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com/fallback' }
    }, 1000);

    const [event] = readEvents();
    assert.match(event.event_id, /^evt_/);
  });

  it('appends PostToolUseFailure with the same event_id and summary', async () => {
    await runHook({
      hook_event_name: 'PreToolUse',
      session_id: 'session-1',
      tool_name: 'WebSearch',
      tool_input: { query: 'issue 492' },
      tool_use_id: 'toolu_search_1'
    }, 1000);
    await runHook({
      hook_event_name: 'PostToolUseFailure',
      session_id: 'session-1',
      tool_name: 'WebSearch',
      tool_input: { query: 'issue 492' },
      tool_use_id: 'toolu_search_1'
    }, 1100);

    const events = readEvents();
    assert.equal(events.length, 2);
    assert.equal(events[0].event, 'pre_tool');
    assert.equal(events[1].event, 'post_tool_failure');
    assert.equal(events[1].session_id, 'session-1');
    assert.equal(events[1].event_id, 'toolu_search_1');
    assert.deepEqual(events[1].summary, { type: 'query-preview', value: 'issue 492' });
  });

  it('records prompt events without tool fields', async () => {
    await runHook({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-2'
    }, 1200);

    const [event] = readEvents();
    assert.equal(event.event, 'prompt');
    assert.equal(event.session_id, 'session-2');
    assert.equal(Object.hasOwn(event, 'tool'), false);
  });

  it('records PostToolUse as post_tool event', async () => {
    await runHook({
      hook_event_name: 'PostToolUse',
      session_id: 'session-3',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com' },
      tool_use_id: 'toolu_post_1'
    }, 2000);

    const [event] = readEvents();
    assert.equal(event.event, 'post_tool');
    assert.equal(event.tool, 'WebFetch');
    assert.equal(event.event_id, 'toolu_post_1');
  });

  it('records Stop as stop event without tool fields', async () => {
    await runHook({
      hook_event_name: 'Stop',
      session_id: 'session-4'
    }, 3000);

    const [event] = readEvents();
    assert.equal(event.event, 'stop');
    assert.equal(event.session_id, 'session-4');
    assert.equal(Object.hasOwn(event, 'tool'), false);
  });

  it('records Notification as idle event', async () => {
    await runHook({
      hook_event_name: 'Notification',
      session_id: 'session-5'
    }, 4000);

    const [event] = readEvents();
    assert.equal(event.event, 'idle');
  });

  it('ignores subagent hook events when agent_id is present', async () => {
    process.env.ZYLOS_DIR = tmpDir;
    process.env.HOOK_ACTIVITY_DISABLE_MAIN = '1';
    const modulePath = new URL('../hook-activity.js', import.meta.url);
    const { handleHookActivity } = await import(`${modulePath.href}?t=${Date.now()}-${Math.random()}`);
    const result = handleHookActivity({
      hook_event_name: 'PreToolUse',
      session_id: 'session-subagent',
      agent_id: 'agent-123',
      agent_type: 'Explore',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com/subagent' },
      tool_use_id: 'toolu_subagent_1'
    }, { nowMs: 4500, claudePid: 4242 });
    assert.equal(result, null);
    assert.equal(fs.existsSync(eventsFile), false);
  });

  it('still records root-agent events when only agent_type is present', async () => {
    await runHook({
      hook_event_name: 'PreToolUse',
      session_id: 'session-agent-mode',
      agent_type: 'security-reviewer',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com/root-agent' },
      tool_use_id: 'toolu_root_agent_1'
    }, 4600);

    const [event] = readEvents();
    assert.equal(event.event, 'pre_tool');
    assert.equal(event.session_id, 'session-agent-mode');
    assert.equal(event.event_id, 'toolu_root_agent_1');
  });

  it('returns null for unknown hook event', async () => {
    process.env.ZYLOS_DIR = tmpDir;
    process.env.HOOK_ACTIVITY_DISABLE_MAIN = '1';
    const modulePath = new URL('../hook-activity.js', import.meta.url);
    const { handleHookActivity } = await import(`${modulePath.href}?t=${Date.now()}-${Math.random()}`);
    const result = handleHookActivity({ hook_event_name: 'UnknownEvent' }, { nowMs: 5000, claudePid: 4242 });
    assert.equal(result, null);
  });

  it('returns null when session_id is missing', async () => {
    process.env.ZYLOS_DIR = tmpDir;
    delete process.env.CLAUDE_SESSION_ID;
    process.env.HOOK_ACTIVITY_DISABLE_MAIN = '1';
    const modulePath = new URL('../hook-activity.js', import.meta.url);
    const { handleHookActivity } = await import(`${modulePath.href}?t=${Date.now()}-${Math.random()}`);
    const result = handleHookActivity({
      hook_event_name: 'PreToolUse',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com' }
    }, { nowMs: 6000, claudePid: 4242 });
    assert.equal(result, null);
    // Restore for other tests
    process.env.CLAUDE_SESSION_ID = 'env-session';
  });

  it('assigns rule_id for tools matching a watchdog rule', async () => {
    await runHook({
      hook_event_name: 'PreToolUse',
      session_id: 'session-6',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com' },
      tool_use_id: 'toolu_rule_1'
    }, 7000);

    const [event] = readEvents();
    assert.equal(event.rule_id, 'web-tools-timeout');
  });

  it('does not assign rule_id for non-matching tools', async () => {
    await runHook({
      hook_event_name: 'PreToolUse',
      session_id: 'session-7',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/foo' },
      tool_use_id: 'toolu_read_1'
    }, 8000);

    const [event] = readEvents();
    assert.equal(Object.hasOwn(event, 'rule_id'), false);
  });

  it('projects real tool start and completion as safe public progress', async () => {
    process.env.ZYLOS_DIR = tmpDir;
    const { openAssistantResponseStream } = await import(
      '../../../comm-bridge/scripts/assistant-response-stream.js'
    );
    const stream = openAssistantResponseStream();
    stream.execute({
      type: 'AcceptAssistantRequest',
      requestId: 'assistant.feishu.hook-progress',
      sourceId: 'om_hook_progress',
      route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_hook_progress' },
      conversation: {
        content: '[Feishu DM] progress test',
        status: 'pending',
        priority: 3,
        requireIdle: false,
      },
    });
    stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.hook-progress' });

    await runHook({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-hook-progress',
    }, 9000);
    await runHook({
      hook_event_name: 'PreToolUse',
      session_id: 'session-hook-progress',
      tool_name: 'WebSearch',
      tool_input: { query: 'private customer information must not escape' },
      tool_use_id: 'toolu_hook_progress',
    }, 9100);
    await runHook({
      hook_event_name: 'PostToolUse',
      session_id: 'session-hook-progress',
      tool_name: 'WebSearch',
      tool_input: { query: 'private customer information must not escape' },
      tool_use_id: 'toolu_hook_progress',
    }, 9200);

    const progress = stream.query({ requestId: 'assistant.feishu.hook-progress' }).events
      .filter(event => event.type === 'ProgressUpdated');
    assert.deepEqual(progress.map(event => event.payload), [
      {
        stage: 'organizing',
        action: 'analyze_request',
        status: 'started',
        summary: 'Analyzing the request',
      },
      {
        stage: 'searching',
        action: 'search_sources',
        status: 'started',
        summary: 'Searching relevant sources',
      },
      {
        stage: 'searching',
        action: 'search_sources',
        status: 'completed',
        summary: 'Relevant sources found',
      },
    ]);
    const serialized = JSON.stringify(progress);
    assert.equal(serialized.includes('private customer'), false);
    assert.equal(serialized.includes('WebSearch'), false);
    stream.close();
  });

  it('binds the pending run on the first tool event when prompt binding was missed', async () => {
    process.env.ZYLOS_DIR = tmpDir;
    const { openAssistantResponseStream } = await import(
      '../../../comm-bridge/scripts/assistant-response-stream.js'
    );
    const stream = openAssistantResponseStream();
    stream.execute({
      type: 'AcceptAssistantRequest',
      requestId: 'assistant.feishu.tool-bind-fallback',
      sourceId: 'om_tool_bind_fallback',
      route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_tool_bind_fallback' },
      conversation: {
        content: '[Feishu DM] tool binding fallback test',
        status: 'pending',
        priority: 3,
        requireIdle: false,
      },
    });
    stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.tool-bind-fallback' });

    await runHook({
      hook_event_name: 'PreToolUse',
      session_id: 'session-tool-bind-fallback',
      tool_name: 'WebSearch',
      tool_input: { query: 'private query must not escape' },
      tool_use_id: 'toolu_tool_bind_fallback',
    }, 9200);

    const { request, events } = stream.query({
      requestId: 'assistant.feishu.tool-bind-fallback',
    });
    assert.equal(request.runtimeSessionId, 'session-tool-bind-fallback');
    assert.deepEqual(events.map(item => item.type), [
      'AssistantRequestAccepted',
      'RunQueued',
      'RunStarted',
      'ProgressUpdated',
      'ProgressUpdated',
    ]);
    assert.equal(JSON.stringify(events).includes('private query must not escape'), false);
    assert.equal(JSON.stringify(events).includes('WebSearch'), false);
    stream.close();
  });

  it('projects MessageDisplay batches as answer deltas without copying text into activity logs', async () => {
    process.env.ZYLOS_DIR = tmpDir;
    const { openAssistantResponseStream } = await import(
      '../../../comm-bridge/scripts/assistant-response-stream.js'
    );
    const stream = openAssistantResponseStream();
    stream.execute({
      type: 'AcceptAssistantRequest',
      requestId: 'assistant.feishu.display-delta',
      sourceId: 'om_display_delta',
      route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_display_delta' },
      conversation: {
        content: '[Feishu DM] display delta test',
        status: 'pending',
        priority: 3,
        requireIdle: false,
      },
    });
    stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.display-delta' });

    await runHook({
      hook_event_name: 'MessageDisplay',
      session_id: 'session-display-delta',
      turn_id: 'turn-display-1',
      message_id: 'message-display-1',
      index: 0,
      final: false,
      delta: '这是公开回答的第一段。\n',
    }, 9300);

    const result = stream.query({ requestId: 'assistant.feishu.display-delta' });
    assert.equal(result.request.runtimeSessionId, 'session-display-delta');
    assert.deepEqual(result.events.at(-1), {
      schemaVersion: 1,
      eventId: 'assistant.feishu.display-delta:5',
      requestId: 'assistant.feishu.display-delta',
      sequence: 5,
      type: 'OutputDelta',
      occurredAt: result.events.at(-1).occurredAt,
      payload: { delta: '这是公开回答的第一段。\n' },
    });
    assert.equal(fs.existsSync(eventsFile), false);
    stream.close();
  });

  it('routes explicit public reasoning lines separately from visible answer text', async () => {
    process.env.ZYLOS_DIR = tmpDir;
    const { openAssistantResponseStream } = await import(
      '../../../comm-bridge/scripts/assistant-response-stream.js'
    );
    const stream = openAssistantResponseStream();
    stream.execute({
      type: 'AcceptAssistantRequest',
      requestId: 'assistant.feishu.public-reasoning-line',
      sourceId: 'om_public_reasoning_line',
      route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_public_reasoning_line' },
      conversation: {
        content: '[Feishu DM] public reasoning line test',
        status: 'pending',
        priority: 3,
        requireIdle: false,
      },
    });
    stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.public-reasoning-line' });

    await runHook({
      hook_event_name: 'MessageDisplay',
      session_id: 'session-public-reasoning-line',
      message_id: 'message-public-reasoning-line',
      index: 0,
      final: false,
      delta: '[PUBLIC_REASONING] 正在核对任务边界。\n这是给用户的答案。\n',
    }, 9350);

    const result = stream.query({ requestId: 'assistant.feishu.public-reasoning-line' });
    assert.deepEqual(result.events.slice(-2).map(event => ({
      type: event.type,
      payload: event.payload,
    })), [
      {
        type: 'PublicReasoningDelta',
        payload: { delta: '正在核对任务边界。\n' },
      },
      {
        type: 'OutputDelta',
        payload: { delta: '这是给用户的答案。\n' },
      },
    ]);
    assert.equal(result.request.output, '这是给用户的答案。\n');
    stream.close();
  });

  it('redacts path and credential-shaped fragments from Claude public reasoning lines', async () => {
    process.env.ZYLOS_DIR = tmpDir;
    const { openAssistantResponseStream } = await import(
      '../../../comm-bridge/scripts/assistant-response-stream.js'
    );
    const stream = openAssistantResponseStream();
    stream.execute({
      type: 'AcceptAssistantRequest',
      requestId: 'assistant.feishu.public-reasoning-redact',
      sourceId: 'om_public_reasoning_redact',
      route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_public_reasoning_redact' },
      conversation: {
        content: '[Feishu DM] public reasoning redact test',
        status: 'pending',
        priority: 3,
        requireIdle: false,
      },
    });
    stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.public-reasoning-redact' });
    await runHook({
      hook_event_name: 'MessageDisplay',
      session_id: 'session-public-reasoning-redact',
      message_id: 'message-public-reasoning-redact',
      index: 0,
      final: false,
      delta: '[PUBLIC_REASONING] Checking /Users/example/private.txt with token=secret-value\n',
    }, 9375);

    const serialized = JSON.stringify(stream.query({
      requestId: 'assistant.feishu.public-reasoning-redact',
    }).events);
    assert.equal(serialized.includes('/Users/example'), false);
    assert.equal(serialized.includes('secret-value'), false);
    assert.match(serialized, /\[local path\]/);
    assert.match(serialized, /\[redacted\]/);
    stream.close();
  });

  it('uses the public Stop message as the canonical answer after streamed batches', async () => {
    process.env.ZYLOS_DIR = tmpDir;
    const { openAssistantResponseStream } = await import(
      '../../../comm-bridge/scripts/assistant-response-stream.js'
    );
    const stream = openAssistantResponseStream();
    stream.execute({
      type: 'AcceptAssistantRequest',
      requestId: 'assistant.feishu.stop-complete',
      sourceId: 'om_stop_complete',
      route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_stop_complete' },
      conversation: {
        content: '[Feishu DM] stop completion test',
        status: 'pending',
        priority: 3,
        requireIdle: false,
      },
    });
    stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.stop-complete' });

    await runHook({
      hook_event_name: 'MessageDisplay',
      session_id: 'session-stop-complete',
      turn_id: 'turn-stop-1',
      message_id: 'message-stop-1',
      index: 0,
      final: true,
      delta: '逐步形成的答案',
    }, 9400);
    await runHook({
      hook_event_name: 'Stop',
      session_id: 'session-stop-complete',
      last_assistant_message: '最终完整答案',
      stop_hook_active: false,
    }, 9500);

    const result = stream.query({ requestId: 'assistant.feishu.stop-complete' });
    assert.equal(result.request.status, 'completed');
    assert.equal(result.request.output, '最终完整答案');
    assert.deepEqual(result.events.at(-1).payload, { output: '最终完整答案' });
    assert.equal(JSON.stringify(readEvents()).includes('最终完整答案'), false);
    stream.close();
  });

  it('removes public reasoning marker lines from the canonical Stop answer', async () => {
    process.env.ZYLOS_DIR = tmpDir;
    const { openAssistantResponseStream } = await import(
      '../../../comm-bridge/scripts/assistant-response-stream.js'
    );
    const stream = openAssistantResponseStream();
    stream.execute({
      type: 'AcceptAssistantRequest',
      requestId: 'assistant.feishu.stop-filter-reasoning',
      sourceId: 'om_stop_filter_reasoning',
      route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_stop_filter_reasoning' },
      conversation: {
        content: '[Feishu DM] stop filter test',
        status: 'pending',
        priority: 3,
        requireIdle: false,
      },
    });
    stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.stop-filter-reasoning' });
    await runHook({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-stop-filter-reasoning',
    }, 9600);
    await runHook({
      hook_event_name: 'Stop',
      session_id: 'session-stop-filter-reasoning',
      last_assistant_message: '[PUBLIC_REASONING] 正在检查。\n最终答案。',
      stop_hook_active: false,
    }, 9700);

    const result = stream.query({ requestId: 'assistant.feishu.stop-filter-reasoning' });
    assert.equal(result.request.output, '最终答案。');
    assert.equal(JSON.stringify(result.events).includes('PUBLIC_REASONING'), false);
    stream.close();
  });
});
