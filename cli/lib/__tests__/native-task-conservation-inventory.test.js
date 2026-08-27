import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { collectNativeTaskConservationInventory } from '../native-task-conservation-inventory.js';

function task(index) {
  return {
    id: `task-${String(index).padStart(3, '0')}`,
    state: 'ready',
    updatedAt: new Date(1_800_000_000_000 - index).toISOString(),
  };
}

describe('Core native-task conservation inventory', () => {
  it('paginates beyond the ordinary CLI limit and reads links through the public Interface', async () => {
    const allTasks = Array.from({ length: 201 }, (_, index) => task(index));
    const queries = [];
    let closed = false;
    const core = {
      query(query) {
        queries.push(query);
        const offset = query.cursor ? Number(query.cursor.taskId.slice(-3)) + 1 : 0;
        return allTasks.slice(offset, offset + query.limit);
      },
      externalLinks: {
        query(query) {
          return [{
            taskId: query.taskId,
            backend: query.backend,
            externalId: `guid-${query.taskId}`,
          }];
        },
      },
      close() { closed = true; },
    };

    const result = await collectNativeTaskConservationInventory({
      openCore: () => core,
      agentId: 'agent:yueran',
    });

    assert.equal(result.schema, 'zylos.native-task-core-inventory/v1');
    assert.equal(result.tasks.length, 201);
    assert.equal(result.externalLinks.length, 201);
    assert.equal(queries.length, 6);
    assert.equal(queries[0].states, undefined);
    assert.equal(queries[1].cursor.taskId, 'task-099');
    assert.equal(queries[2].cursor.taskId, 'task-199');
    assert.equal(queries[4].cursor.taskId, 'task-099');
    assert.deepEqual(result.identity, { agentId: 'agent:yueran' });
    assert.equal(result.snapshot.stable, true);
    assert.equal(result.snapshot.strategy, 'double-read-fingerprint');
    assert.match(result.snapshot.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(closed, true);
  });

  it('always closes Core when a page is malformed', async () => {
    let closed = false;
    const core = {
      query: () => null,
      externalLinks: { query: () => [] },
      close() { closed = true; },
    };

    await assert.rejects(
      collectNativeTaskConservationInventory({
        openCore: () => core,
        agentId: 'agent:yueran',
      }),
      /task page must be an array/,
    );
    assert.equal(closed, true);
  });

  it('fails closed when Core changes between the two inventory passes', async () => {
    let pass = 0;
    let closed = false;
    const core = {
      query() {
        pass += 1;
        return [task(pass)];
      },
      externalLinks: { query: () => [] },
      close() { closed = true; },
    };

    await assert.rejects(
      collectNativeTaskConservationInventory({
        openCore: () => core,
        agentId: 'agent:yueran',
      }),
      error => error?.code === 'SNAPSHOT_UNSTABLE',
    );
    assert.equal(closed, true);
  });
});
