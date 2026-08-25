import assert from 'node:assert/strict';
import test from 'node:test';

import { openIdempotentInboundQueue } from '../c4-idempotent-inbound.js';

test('idempotent inbound queue records one Agent wake and replays the same receipt', () => {
  const queue = openIdempotentInboundQueue({ dbPath: ':memory:' });
  try {
    const request = {
      idempotencyKey: 'task-comment:wake:event-1',
      channel: 'feishu',
      endpointId: 'task-comment|task:dGFzay0x|comment:Y29tbWVudC0x',
      content: 'A human added a task comment.',
      priority: 2,
    };

    const first = queue.enqueue(request);
    const replay = queue.enqueue(request);

    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.equal(replay.conversation.id, first.conversation.id);
    assert.deepEqual(queue.query({ idempotencyKey: request.idempotencyKey }), replay);
  } finally {
    queue.close();
  }
});

test('idempotent inbound queue rejects reuse with different wake content', () => {
  const queue = openIdempotentInboundQueue({ dbPath: ':memory:' });
  try {
    queue.enqueue({
      idempotencyKey: 'task-comment:wake:event-1',
      channel: 'feishu',
      endpointId: 'task-comment|task:dGFzay0x|comment:Y29tbWVudC0x',
      content: 'Original comment.',
      priority: 2,
    });
    assert.throws(
      () => queue.enqueue({
        idempotencyKey: 'task-comment:wake:event-1',
        channel: 'feishu',
        endpointId: 'task-comment|task:dGFzay0x|comment:Y29tbWVudC0x',
        content: 'Changed comment.',
        priority: 2,
      }),
      (error) => error?.code === 'IDEMPOTENCY_CONFLICT',
    );
  } finally {
    queue.close();
  }
});

test('idempotent inbound queue supports no-reply Agent notifications', () => {
  const queue = openIdempotentInboundQueue({ dbPath: ':memory:' });
  try {
    const result = queue.enqueue({
      idempotencyKey: 'task-notification:event-1:agent-yueran',
      channel: 'system',
      endpointId: null,
      content: 'A task is blocked and needs attention.',
      priority: 2,
    });
    assert.equal(result.conversation.endpointId, null);
  } finally {
    queue.close();
  }
});
