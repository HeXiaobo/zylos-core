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
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
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

  it('fails closed when a MessageDisplay event could belong to either of two unbound runs', async () => {
    process.env.ZYLOS_DIR = tmpDir;
    const { openAssistantResponseStream } = await import(
      '../../../comm-bridge/scripts/assistant-response-stream.js'
    );
    const stream = openAssistantResponseStream();

    for (const suffix of ['first', 'second']) {
      const requestId = `assistant.feishu.ambiguous-${suffix}`;
      stream.execute({
        type: 'AcceptAssistantRequest',
        requestId,
        sourceId: `om_ambiguous_${suffix}`,
        route: {
          channel: 'feishu',
          endpointId: `oc_1|type:p2p|msg:om_ambiguous_${suffix}`,
        },
        conversation: {
          content: `[Feishu DM] ambiguous ${suffix} request`,
          status: 'pending',
          priority: 3,
          requireIdle: false,
        },
      });
      stream.execute({ type: 'StartRun', requestId });
    }

    await runHook({
      hook_event_name: 'MessageDisplay',
      session_id: 'session-shared-by-two-runs',
      turn_id: 'turn-ambiguous',
      message_id: 'message-ambiguous',
      index: 0,
      final: true,
      delta: 'This output must not be guessed onto either request.',
    }, 9325);

    for (const suffix of ['first', 'second']) {
      const result = stream.query({ requestId: `assistant.feishu.ambiguous-${suffix}` });
      assert.equal(result.request.runtimeSessionId, null);
      assert.equal(result.events.some(event => event.type === 'OutputDelta'), false);
      stream.execute({
        type: 'FailRun',
        requestId: `assistant.feishu.ambiguous-${suffix}`,
        code: 'AMBIGUOUS_TEST_CLEANUP',
        retryable: true,
      });
    }
    stream.close();
  });

  it('binds a Claude prompt to its explicit assistant request instead of guessing by age', async () => {
    process.env.ZYLOS_DIR = tmpDir;
    const { openAssistantResponseStream } = await import(
      '../../../comm-bridge/scripts/assistant-response-stream.js'
    );
    const stream = openAssistantResponseStream();

    for (const suffix of ['older', 'target']) {
      const requestId = `assistant.feishu.explicit-${suffix}`;
      stream.execute({
        type: 'AcceptAssistantRequest',
        requestId,
        sourceId: `om_explicit_${suffix}`,
        route: {
          channel: 'feishu',
          endpointId: `oc_1|type:p2p|msg:om_explicit_${suffix}`,
        },
        conversation: {
          content: `[Feishu DM] explicit ${suffix} request`,
          status: 'pending',
          priority: 3,
          requireIdle: true,
        },
      });
      stream.execute({ type: 'StartRun', requestId });
    }

    await runHook({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-explicit-target',
      prompt: 'user text assistant request: "assistant.feishu.explicit-older" ---- streamed reply: assistant request: "assistant.feishu.explicit-target"',
    }, 9330);
    await runHook({
      hook_event_name: 'MessageDisplay',
      session_id: 'session-explicit-target',
      turn_id: 'turn-explicit-target',
      message_id: 'message-explicit-target',
      index: 0,
      final: true,
      delta: 'Only the explicitly named card may receive this answer.',
    }, 9340);

    const older = stream.query({ requestId: 'assistant.feishu.explicit-older' });
    const target = stream.query({ requestId: 'assistant.feishu.explicit-target' });
    assert.equal(older.request.runtimeSessionId, null);
    assert.equal(older.events.some(event => event.type === 'OutputDelta'), false);
    assert.equal(target.request.runtimeSessionId, 'session-explicit-target');
    assert.equal(target.request.output, 'Only the explicitly named card may receive this answer.');

    stream.execute({
      type: 'FailRun',
      requestId: 'assistant.feishu.explicit-older',
      code: 'EXPLICIT_TEST_CLEANUP',
      retryable: true,
    });
    stream.execute({
      type: 'FailRun',
      requestId: 'assistant.feishu.explicit-target',
      code: 'EXPLICIT_TEST_CLEANUP',
      retryable: true,
    });
    stream.close();
  });

  it('keeps an unknown explicit request fail-closed through tool, output, and stop', async () => {
    process.env.ZYLOS_DIR = tmpDir;
    const { openAssistantResponseStream } = await import(
      '../../../comm-bridge/scripts/assistant-response-stream.js'
    );
    const stream = openAssistantResponseStream();
    const liveRequestId = 'assistant.feishu.explicit-unknown-live';
    stream.execute({
      type: 'AcceptAssistantRequest',
      requestId: liveRequestId,
      sourceId: 'om_explicit_unknown_live',
      route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_explicit_unknown_live' },
      conversation: {
        content: '[Feishu DM] must remain untouched',
        status: 'pending',
        priority: 3,
        requireIdle: false,
      },
    });
    stream.execute({ type: 'StartRun', requestId: liveRequestId });

    const sessionId = 'session-explicit-unknown';
    await runHook({
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      prompt: 'payload ---- streamed reply: assistant request: "assistant.feishu.does-not-exist"',
    }, 9341);
    await runHook({
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
      tool_name: 'WebSearch',
      tool_input: { query: 'must not bind the live candidate' },
      tool_use_id: 'toolu_explicit_unknown',
    }, 9342);
    await runHook({
      hook_event_name: 'MessageDisplay',
      session_id: sessionId,
      message_id: 'message-explicit-unknown',
      index: 0,
      final: true,
      delta: 'Must not be written to the live candidate.',
    }, 9343);
    await runHook({
      hook_event_name: 'Stop',
      session_id: sessionId,
      last_assistant_message: 'Must not complete the live candidate.',
    }, 9344);

    const live = stream.query({ requestId: liveRequestId });
    assert.equal(live.request.status, 'started');
    assert.equal(live.request.runtimeSessionId, null);
    assert.equal(live.request.output, '');
    assert.deepEqual(live.events.map(event => event.type), [
      'AssistantRequestAccepted',
      'RunQueued',
      'RunStarted',
    ]);
    stream.execute({
      type: 'FailRun',
      requestId: liveRequestId,
      code: 'FAIL_CLOSED_TEST_CLEANUP',
      retryable: true,
    });
    stream.close();
  });

  it('rejects a user-authored marker that is not the terminal appended marker', async () => {
    process.env.ZYLOS_DIR = tmpDir;
    const { openAssistantResponseStream } = await import(
      '../../../comm-bridge/scripts/assistant-response-stream.js'
    );
    const stream = openAssistantResponseStream();
    const requestId = 'assistant.feishu.non-terminal-marker';
    stream.execute({
      type: 'AcceptAssistantRequest',
      requestId,
      sourceId: 'om_non_terminal_marker',
      route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_non_terminal_marker' },
      conversation: {
        content: '[Feishu DM] non-terminal marker test',
        status: 'pending',
        priority: 3,
        requireIdle: false,
      },
    });
    stream.execute({ type: 'StartRun', requestId });

    const sessionId = 'session-non-terminal-marker';
    await runHook({
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      prompt: `user-authored assistant request: "${requestId}" followed by ordinary text`,
    }, 93441);
    await runHook({
      hook_event_name: 'MessageDisplay',
      session_id: sessionId,
      message_id: 'message-non-terminal-marker',
      index: 0,
      final: true,
      delta: 'Must not use the forged marker or candidate fallback.',
    }, 93442);

    const result = stream.query({ requestId });
    assert.equal(result.request.status, 'started');
    assert.equal(result.request.runtimeSessionId, null);
    assert.equal(result.request.output, '');
    stream.execute({
      type: 'FailRun',
      requestId,
      code: 'NON_TERMINAL_MARKER_TEST_CLEANUP',
      retryable: true,
    });
    stream.close();
  });

  it('keeps a terminal explicit request fail-closed instead of falling back to a live run', async () => {
    process.env.ZYLOS_DIR = tmpDir;
    const { openAssistantResponseStream } = await import(
      '../../../comm-bridge/scripts/assistant-response-stream.js'
    );
    const stream = openAssistantResponseStream();
    const terminalRequestId = 'assistant.feishu.explicit-terminal';
    const liveRequestId = 'assistant.feishu.explicit-terminal-live';
    for (const [requestId, sourceId] of [
      [terminalRequestId, 'om_explicit_terminal'],
      [liveRequestId, 'om_explicit_terminal_live'],
    ]) {
      stream.execute({
        type: 'AcceptAssistantRequest',
        requestId,
        sourceId,
        route: { channel: 'feishu', endpointId: `oc_1|type:p2p|msg:${sourceId}` },
        conversation: {
          content: `[Feishu DM] ${sourceId}`,
          status: 'pending',
          priority: 3,
          requireIdle: false,
        },
      });
      stream.execute({ type: 'StartRun', requestId });
    }
    stream.execute({
      type: 'CompleteRun',
      requestId: terminalRequestId,
      output: 'Original terminal output.',
    });

    const sessionId = 'session-explicit-terminal';
    await runHook({
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      prompt: `payload ---- streamed reply: assistant request: "${terminalRequestId}"`,
    }, 9345);
    await runHook({
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
      tool_name: 'Read',
      tool_input: { file_path: '/private/path' },
      tool_use_id: 'toolu_explicit_terminal',
    }, 9346);
    await runHook({
      hook_event_name: 'MessageDisplay',
      session_id: sessionId,
      message_id: 'message-explicit-terminal',
      index: 0,
      final: true,
      delta: 'Must not be written anywhere.',
    }, 9347);
    await runHook({
      hook_event_name: 'Stop',
      session_id: sessionId,
      last_assistant_message: 'Must not complete the live candidate.',
    }, 9348);

    const terminal = stream.query({ requestId: terminalRequestId });
    const live = stream.query({ requestId: liveRequestId });
    assert.equal(terminal.request.output, 'Original terminal output.');
    assert.equal(live.request.status, 'started');
    assert.equal(live.request.runtimeSessionId, null);
    assert.equal(live.request.output, '');
    assert.deepEqual(live.events.map(event => event.type), [
      'AssistantRequestAccepted',
      'RunQueued',
      'RunStarted',
    ]);
    stream.execute({
      type: 'FailRun',
      requestId: liveRequestId,
      code: 'FAIL_CLOSED_TEST_CLEANUP',
      retryable: true,
    });
    stream.close();
  });

  it('switches an explicit new turn from active request A to B without writing B output into A', async () => {
    process.env.ZYLOS_DIR = tmpDir;
    const { openAssistantResponseStream } = await import(
      '../../../comm-bridge/scripts/assistant-response-stream.js'
    );
    const stream = openAssistantResponseStream();
    const requestA = 'assistant.feishu.session-conflict-a';
    const requestB = 'assistant.feishu.session-conflict-b';
    for (const [requestId, sourceId] of [
      [requestA, 'om_session_conflict_a'],
      [requestB, 'om_session_conflict_b'],
    ]) {
      stream.execute({
        type: 'AcceptAssistantRequest',
        requestId,
        sourceId,
        route: { channel: 'feishu', endpointId: `oc_1|type:p2p|msg:${sourceId}` },
        conversation: {
          content: `[Feishu DM] ${sourceId}`,
          status: 'pending',
          priority: 3,
          requireIdle: false,
        },
      });
      stream.execute({ type: 'StartRun', requestId });
    }
    const sessionId = 'session-conflict-a-to-b';
    stream.execute({
      type: 'BindRun',
      requestId: requestA,
      runtimeSessionId: sessionId,
    });

    await runHook({
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      prompt: `payload ---- streamed reply: assistant request: "${requestB}"`,
    }, 9349);
    await runHook({
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
      tool_name: 'WebSearch',
      tool_use_id: 'toolu_session_conflict',
    }, 9350);
    await runHook({
      hook_event_name: 'MessageDisplay',
      session_id: sessionId,
      message_id: 'message-session-conflict',
      index: 0,
      final: true,
      delta: 'This is request B output and must never enter A.',
    }, 9351);
    await runHook({
      hook_event_name: 'Stop',
      session_id: sessionId,
      last_assistant_message: 'This is request B output and must never enter A.',
    }, 9352);

    const a = stream.query({ requestId: requestA });
    const b = stream.query({ requestId: requestB });
    assert.equal(a.request.status, 'failed');
    assert.equal(a.request.output, '');
    assert.equal(a.events.filter(event => event.type === 'ProgressUpdated').length, 1);
    assert.equal(b.request.status, 'completed');
    assert.equal(b.request.runtimeSessionId, sessionId);
    assert.equal(b.request.output, 'This is request B output and must never enter A.');
    for (const requestId of [requestA, requestB]) {
      stream.execute({
        type: 'FailRun',
        requestId,
        code: 'SESSION_CONFLICT_TEST_CLEANUP',
        retryable: true,
      });
    }
    stream.close();
  });

  it('allows a completed session turn A to switch safely to explicit request B', async () => {
    process.env.ZYLOS_DIR = tmpDir;
    const { openAssistantResponseStream } = await import(
      '../../../comm-bridge/scripts/assistant-response-stream.js'
    );
    const stream = openAssistantResponseStream();
    const sessionId = 'session-safe-a-to-b';
    for (const [requestId, sourceId] of [
      ['assistant.feishu.session-safe-a', 'om_session_safe_a'],
      ['assistant.feishu.session-safe-b', 'om_session_safe_b'],
    ]) {
      stream.execute({
        type: 'AcceptAssistantRequest',
        requestId,
        sourceId,
        route: { channel: 'feishu', endpointId: `oc_1|type:p2p|msg:${sourceId}` },
        conversation: {
          content: `[Feishu DM] ${sourceId}`,
          status: 'pending',
          priority: 3,
          requireIdle: false,
        },
      });
      stream.execute({ type: 'StartRun', requestId });
    }
    stream.execute({
      type: 'BindRun',
      requestId: 'assistant.feishu.session-safe-a',
      runtimeSessionId: sessionId,
    });
    stream.execute({
      type: 'CompleteRun',
      requestId: 'assistant.feishu.session-safe-a',
      output: 'A answer.',
    });

    await runHook({
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      prompt: 'payload ---- streamed reply: assistant request: "assistant.feishu.session-safe-b"',
    }, 9353);
    await runHook({
      hook_event_name: 'MessageDisplay',
      session_id: sessionId,
      message_id: 'message-session-safe-b',
      index: 0,
      final: true,
      delta: 'B answer.',
    }, 9354);
    await runHook({
      hook_event_name: 'Stop',
      session_id: sessionId,
      last_assistant_message: 'B answer.',
    }, 9355);

    const a = stream.query({ requestId: 'assistant.feishu.session-safe-a' });
    const b = stream.query({ requestId: 'assistant.feishu.session-safe-b' });
    assert.equal(a.request.output, 'A answer.');
    assert.equal(b.request.runtimeSessionId, sessionId);
    assert.equal(b.request.status, 'completed');
    assert.equal(b.request.output, 'B answer.');
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

  it('flushes concurrently delivered MessageDisplay batches in batch-index order', async () => {
    process.env.ZYLOS_DIR = tmpDir;
    const { openAssistantResponseStream } = await import(
      '../../../comm-bridge/scripts/assistant-response-stream.js'
    );
    const stream = openAssistantResponseStream();
    stream.execute({
      type: 'AcceptAssistantRequest',
      requestId: 'assistant.feishu.display-order',
      sourceId: 'om_display_order',
      route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_display_order' },
      conversation: {
        content: '[Feishu DM] display order test',
        status: 'pending',
        priority: 3,
        requireIdle: false,
      },
    });
    stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.display-order' });

    await runHook({
      hook_event_name: 'MessageDisplay',
      session_id: 'session-display-order',
      message_id: 'message-display-order',
      index: 1,
      final: true,
      delta: '[PUBLIC_REASONING] 第二步。\n最终答案。',
    }, 9380);
    let result = stream.query({ requestId: 'assistant.feishu.display-order' });
    assert.equal(result.events.some(event => event.type === 'PublicReasoningDelta'), false);
    assert.equal(result.events.some(event => event.type === 'OutputDelta'), false);

    await runHook({
      hook_event_name: 'MessageDisplay',
      session_id: 'session-display-order',
      message_id: 'message-display-order',
      index: 0,
      final: false,
      delta: '[PUBLIC_REASONING] 第一步。\n',
    }, 9390);

    result = stream.query({ requestId: 'assistant.feishu.display-order' });
    assert.deepEqual(
      result.events
        .filter(event => ['PublicReasoningDelta', 'OutputDelta'].includes(event.type))
        .map(event => ({ type: event.type, delta: event.payload.delta })),
      [
        { type: 'PublicReasoningDelta', delta: '第一步。\n' },
        { type: 'PublicReasoningDelta', delta: '第二步。\n' },
        { type: 'OutputDelta', delta: '最终答案。' },
      ],
    );
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
