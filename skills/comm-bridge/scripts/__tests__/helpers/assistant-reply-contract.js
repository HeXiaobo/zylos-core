import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_ROOT = fileURLToPath(new URL(
  '../fixtures/assistant-reply-contract/v1/',
  import.meta.url,
));

const REQUIRED_TOP_LEVEL_KEYS = Object.freeze([
  'acceptMessage',
  'cancelRequest',
  'context',
  'delivery',
  'outcomes',
  'replyIntents',
  'runtimeEventStreams',
  'runtimeLane',
  'schema',
  'task',
  'version',
]);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function loadContractFixture(fileName) {
  const safeName = path.basename(fileName);
  if (safeName !== fileName || !safeName.endsWith('.json')) {
    throw new TypeError('contract fixture name must be one JSON basename');
  }
  return deepFreeze(JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, safeName), 'utf8')));
}

export function assertContractVectorSet(contract) {
  assert.ok(contract && typeof contract === 'object' && !Array.isArray(contract));
  assert.deepEqual(Object.keys(contract).sort(), [...REQUIRED_TOP_LEVEL_KEYS].sort());
  assert.equal(contract.schema, 'zylos.assistant-reply-contract/v1');
  assert.equal(contract.version, 1);
  assert.equal(contract.acceptMessage.initial.command.type, 'AcceptMessage');
  assert.equal(contract.cancelRequest.command.type, 'CancelRequest');
  assert.equal(contract.context.hints.type, 'ContextHints');
  assert.equal(contract.context.snapshot.type, 'ContextSnapshot');
  assert.ok(Array.isArray(contract.runtimeEventStreams));
  assert.ok(Array.isArray(contract.replyIntents));
  assert.ok(Array.isArray(contract.delivery.receipts));
  assert.ok(Array.isArray(contract.delivery.settlements));
  assert.equal(contract.task.command.type, 'TaskCommand');
  assert.equal(contract.task.decision.type, 'AuthorizationDecision');
}
