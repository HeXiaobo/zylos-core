import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { createCodexResponseStreamAdapter } from '../codex-response-stream.js';

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeRollout(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-response-stream-'));
  tempDirs.push(dir);
  const rolloutPath = path.join(dir, 'rollout-test.jsonl');
  fs.writeFileSync(rolloutPath, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  return { dir, rolloutPath };
}

describe('CodexResponseStreamAdapter', () => {
  it('projects only public Codex summary/commentary and the visible final answer', () => {
    const { dir, rolloutPath } = makeRollout([
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: 'request payload ---- streamed reply: assistant request: "assistant.feishu.codex-1"',
          }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'reasoning',
          id: 'reasoning-1',
          summary: [{ type: 'summary_text', text: '先核对任务边界。' }],
          encrypted_content: 'must-never-be-forwarded',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'commentary-1',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: '正在检查数据。' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'answer-1',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: '最终答案。' }],
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          last_agent_message: '最终答案。',
          raw_content: 'must-never-be-forwarded-either',
        },
      },
    ]);
    const commands = [];
    const adapter = createCodexResponseStreamAdapter({
      stateFile: path.join(dir, 'state.json'),
      resolveRolloutPath: () => rolloutPath,
      responseStream: { execute: command => commands.push(command) },
      startAtEnd: false,
    });

    const result = adapter.tick();

    assert.equal(result.processedRecords, 5);
    assert.deepEqual(commands.map(command => command.type), [
      'AppendPublicReasoningDelta',
      'AppendPublicReasoningDelta',
      'AppendOutputDelta',
      'CompleteRun',
    ]);
    assert.deepEqual(commands.map(command => command.delta).filter(Boolean), [
      '先核对任务边界。\n',
      '正在检查数据。\n',
      '最终答案。',
    ]);
    assert.equal(commands.every(command => command.requestId === 'assistant.feishu.codex-1'), true);
    assert.equal(JSON.stringify(commands).includes('must-never-be-forwarded'), false);
    assert.equal(commands.at(-1).output, '最终答案。');
  });

  it('persists byte offsets and does not replay already consumed rollout records', () => {
    const { dir, rolloutPath } = makeRollout([]);
    const commands = [];
    const options = {
      stateFile: path.join(dir, 'state.json'),
      resolveRolloutPath: () => rolloutPath,
      responseStream: { execute: command => commands.push(command) },
    };
    const first = createCodexResponseStreamAdapter(options);
    fs.appendFileSync(rolloutPath, `${JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'assistant request: "assistant.feishu.codex-offset"' }],
      },
    })}\n`);
    fs.appendFileSync(rolloutPath, `${JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'reasoning',
        id: 'reasoning-offset',
        summary: [{ type: 'summary_text', text: '只应该发送一次。' }],
      },
    })}\n`);
    first.tick();

    const restarted = createCodexResponseStreamAdapter(options);
    restarted.tick();

    assert.equal(commands.filter(command => command.type === 'AppendPublicReasoningDelta').length, 1);
  });

  it('redacts path and credential-shaped fragments in public summaries', () => {
    const { dir, rolloutPath } = makeRollout([
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'assistant request: "assistant.feishu.codex-redact"' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'reasoning',
          id: 'reasoning-redact',
          summary: [{
            type: 'summary_text',
            text: 'Checking /Users/example/private.txt with token=secret-value',
          }],
        },
      },
    ]);
    const commands = [];
    const adapter = createCodexResponseStreamAdapter({
      stateFile: path.join(dir, 'state.json'),
      resolveRolloutPath: () => rolloutPath,
      responseStream: { execute: command => commands.push(command) },
      startAtEnd: false,
    });

    adapter.tick();

    const serialized = JSON.stringify(commands);
    assert.equal(serialized.includes('/Users/example'), false);
    assert.equal(serialized.includes('secret-value'), false);
    assert.match(commands[0].delta, /\[local path\]/);
    assert.match(commands[0].delta, /\[redacted\]/);
  });
});
