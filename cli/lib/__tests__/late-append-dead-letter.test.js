import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { openAssistantResponseStream } from '../../../skills/comm-bridge/scripts/assistant-response-stream.js';

function accept(stream, overrides = {}) {
  return stream.execute({
    type: 'AcceptAssistantRequest',
    requestId: 'assistant.feishu.late_1',
    sourceId: 'late_1',
    route: { channel: 'feishu', endpointId: 'oc_late|type:p2p|msg:late_1' },
    conversation: {
      content: '[Feishu DM] User said: hello',
      status: 'pending',
      priority: 3,
      requireIdle: false,
    },
    ...overrides,
  });
}

function completedStream() {
  const stream = openAssistantResponseStream({ dbPath: ':memory:' });
  accept(stream);
  stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.late_1' });
  stream.execute({
    type: 'AppendOutputDelta',
    requestId: 'assistant.feishu.late_1',
    delta: 'final answer',
    idempotencyKey: 'live:1',
  });
  stream.execute({
    type: 'CompleteRun',
    requestId: 'assistant.feishu.late_1',
    output: 'final answer',
  });
  return stream;
}

describe('late assistant_stream appends persist as dead letters (issue #52)', () => {
  it('persists a late output delta instead of throwing', () => {
    const stream = completedStream();
    try {
      const result = stream.execute({
        type: 'AppendOutputDelta',
        requestId: 'assistant.feishu.late_1',
        delta: 'straggler output',
        idempotencyKey: 'late:1',
      });

      assert.equal(result.lateAppended, true);
      assert.equal(result.replayed, false);
      assert.deepEqual(result.events, []);

      const dead = stream.queryDeliveries({
        requestId: 'assistant.feishu.late_1',
        status: 'dead_letter',
      });
      assert.equal(dead.length, 1);
      assert.equal(dead[0].event.type, 'OutputDelta');
      assert.equal(dead[0].event.payload.delta, 'straggler output');
      assert.equal(dead[0].lastError, 'late_append_after_terminal:completed');
      assert.equal(dead[0].status, 'dead_letter');
    } finally {
      stream.close();
    }
  });

  it('persists a late public reasoning delta instead of throwing', () => {
    const stream = completedStream();
    try {
      const result = stream.execute({
        type: 'AppendPublicReasoningDelta',
        requestId: 'assistant.feishu.late_1',
        delta: 'straggler reasoning',
        idempotencyKey: 'late-reasoning:1',
      });

      assert.equal(result.lateAppended, true);
      const dead = stream.queryDeliveries({
        requestId: 'assistant.feishu.late_1',
        status: 'dead_letter',
      });
      assert.equal(dead.length, 1);
      assert.equal(dead[0].event.type, 'PublicReasoningDelta');
      assert.equal(dead[0].event.payload.delta, 'straggler reasoning');
      assert.equal(dead[0].lastError, 'late_append_after_terminal:completed');
    } finally {
      stream.close();
    }
  });

  it('keeps the terminal output frozen when a late frame arrives', () => {
    const stream = completedStream();
    try {
      const result = stream.execute({
        type: 'AppendOutputDelta',
        requestId: 'assistant.feishu.late_1',
        delta: 'straggler output',
        idempotencyKey: 'late:2',
      });

      // toRequest maps output_text to `output`; the late frame must not
      // extend the frozen terminal output.
      assert.equal(result.request.output, 'final answer');
    } finally {
      stream.close();
    }
  });

  it('replays a repeated late frame without duplicating the dead letter', () => {
    const stream = completedStream();
    try {
      const command = {
        type: 'AppendOutputDelta',
        requestId: 'assistant.feishu.late_1',
        delta: 'straggler output',
        idempotencyKey: 'late:dup',
      };
      const first = stream.execute(command);
      const second = stream.execute(command);

      assert.equal(first.lateAppended, true);
      assert.equal(second.lateAppended, false);
      assert.equal(second.replayed, true);

      const dead = stream.queryDeliveries({
        requestId: 'assistant.feishu.late_1',
        status: 'dead_letter',
      });
      assert.equal(dead.length, 1);
    } finally {
      stream.close();
    }
  });

  it('exposes dead letters to the existing redrive path', () => {
    const stream = completedStream();
    try {
      stream.execute({
        type: 'AppendOutputDelta',
        requestId: 'assistant.feishu.late_1',
        delta: 'straggler output',
        idempotencyKey: 'late:redrive',
      });

      const redriven = stream.redriveDeadLetters({ requestId: 'assistant.feishu.late_1' });
      assert.equal(redriven.redriven, 1);

      // Lifecycle events (Accepted/RunQueued/RunStarted/…) are also pending —
      // filter to the redriven straggler frame itself.
      const pending = stream.queryDeliveries({
        requestId: 'assistant.feishu.late_1',
        status: 'pending',
      }).filter(item => item.event.payload?.delta === 'straggler output');
      assert.equal(pending.length, 1);
      assert.equal(pending[0].event.type, 'OutputDelta');
      assert.equal(pending[0].redriveCount, 1);
    } finally {
      stream.close();
    }
  });

  it('still delivers live appends with no dead-letter side effects', () => {
    const stream = completedStream();
    try {
      const dead = stream.queryDeliveries({
        requestId: 'assistant.feishu.late_1',
        status: 'dead_letter',
      });
      assert.equal(dead.length, 0);

      // A NEW request still appends live output as before.
      accept(stream, {
        requestId: 'assistant.feishu.late_2',
        sourceId: 'late_2',
        route: { channel: 'feishu', endpointId: 'oc_late|type:p2p|msg:late_2' },
      });
      stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.late_2' });
      const live = stream.execute({
        type: 'AppendOutputDelta',
        requestId: 'assistant.feishu.late_2',
        delta: 'live output',
        idempotencyKey: 'live:late2',
      });
      assert.equal(live.lateAppended, undefined);
      assert.equal(live.replayed, false);
      assert.equal(live.events.length, 1);
      assert.equal(live.events[0].type, 'OutputDelta');
    } finally {
      stream.close();
    }
  });

  it('throws ASSISTANT_EVENT_CONFLICT when a late frame reuses a key with different payload', () => {
    const stream = completedStream();
    try {
      // Same key as the live frame ('live:1' was appended in completedStream),
      // different payload — parity with the live path's conflict detection.
      assert.throws(
        () => stream.execute({
          type: 'AppendOutputDelta',
          requestId: 'assistant.feishu.late_1',
          delta: 'different straggler content',
          idempotencyKey: 'live:1',
        }),
        /different payload/,
      );
      // No dead letter was created for the conflicting frame.
      const dead = stream.queryDeliveries({
        requestId: 'assistant.feishu.late_1',
        status: 'dead_letter',
      });
      assert.equal(dead.length, 0);
    } finally {
      stream.close();
    }
  });

  it('replays an identical late frame without a new dead letter and reports it', () => {
    const stream = completedStream();
    try {
      const first = stream.execute({
        type: 'AppendOutputDelta',
        requestId: 'assistant.feishu.late_1',
        delta: 'identical straggler',
        idempotencyKey: 'late:identical',
      });
      const second = stream.execute({
        type: 'AppendOutputDelta',
        requestId: 'assistant.feishu.late_1',
        delta: 'identical straggler',
        idempotencyKey: 'late:identical',
      });
      assert.equal(first.lateAppended, true);
      assert.equal(second.replayed, true);
      assert.equal(second.lateAppended, false);
      assert.equal(second.events.length, 1);
      assert.equal(second.events[0].payload.delta, 'identical straggler');
      const dead = stream.queryDeliveries({
        requestId: 'assistant.feishu.late_1',
        status: 'dead_letter',
      });
      assert.equal(dead.length, 1);
    } finally {
      stream.close();
    }
  });
});
