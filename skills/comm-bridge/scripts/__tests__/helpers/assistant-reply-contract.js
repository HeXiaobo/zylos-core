import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_ROOT = fileURLToPath(new URL(
  '../fixtures/assistant-reply-contract/v1/',
  import.meta.url,
));

export const COMMON_CONTRACT_SHA256 =
  '581475d80e85cd156c4f6629d0e8e8ee82c2689e89de214c1bb24b404cd10195';
export const COMMON_CONTRACT_FILE = 'common-contract-vectors.json';

const REQUIRED_TOP_LEVEL_KEYS = Object.freeze([
  'acceptMessage',
  'cancelRequest',
  'contextSnapshot',
  'contractId',
  'deliveryReceipts',
  'deliverySettlements',
  'replyIntents',
  'replyOutcomes',
  'runtimeEventStreams',
  'runtimeLane',
  'schemaVersion',
  'semantics',
  'taskCommand',
]);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function fixturePath(fileName) {
  const safeName = path.basename(fileName);
  if (safeName !== fileName || !safeName.endsWith('.json')) {
    throw new TypeError('contract fixture name must be one JSON basename');
  }
  return path.join(FIXTURE_ROOT, safeName);
}

export function readContractFixtureBytes(fileName = COMMON_CONTRACT_FILE) {
  return fs.readFileSync(fixturePath(fileName));
}

export function loadContractFixture(fileName) {
  return deepFreeze(JSON.parse(readContractFixtureBytes(fileName).toString('utf8')));
}

export function contractFixtureSha256(fileName = COMMON_CONTRACT_FILE) {
  return crypto.createHash('sha256').update(readContractFixtureBytes(fileName)).digest('hex');
}

export function assertCommonContractDigest(fileName = COMMON_CONTRACT_FILE) {
  assert.equal(contractFixtureSha256(fileName), COMMON_CONTRACT_SHA256);
  return COMMON_CONTRACT_SHA256;
}

export function requireText(value, label) {
  assert.equal(typeof value, 'string', `${label} must be text`);
  assert.notEqual(value.trim(), '', `${label} must not be empty`);
  return value;
}

export function assertContractVectorSet(contract) {
  assert.ok(contract && typeof contract === 'object' && !Array.isArray(contract));
  assert.deepEqual(Object.keys(contract).sort(), [...REQUIRED_TOP_LEVEL_KEYS].sort());
  assert.equal(contract.schemaVersion, 1);
  assert.equal(contract.contractId, 'zylos.assistant-reply-contract/v1');
  assert.equal(contract.semantics.silentCreatesReplyIntent, false);
  assert.equal(contract.semantics.cancelledCreatesReplyIntent, false);
  assert.equal(contract.semantics.derivedSourceKeysCrossBoundary, false);
  assert.equal(contract.acceptMessage.command.type, 'AcceptMessage');
  assert.equal(contract.acceptMessage.accepted.type, 'MessageAccepted');
  assert.equal(contract.cancelRequest.type, 'CancelRequest');
  assert.equal(contract.contextSnapshot.type, 'ContextSnapshot');
  assert.ok(Array.isArray(contract.runtimeEventStreams));
  assert.ok(contract.runtimeEventStreams.length > 0);
  assert.ok(contract.replyIntents && typeof contract.replyIntents === 'object');
  assert.ok(contract.replyOutcomes && typeof contract.replyOutcomes === 'object');
  assert.ok(contract.deliveryReceipts && typeof contract.deliveryReceipts === 'object');
  assert.ok(contract.deliverySettlements && typeof contract.deliverySettlements === 'object');
  assert.equal(contract.taskCommand.command.type, 'TaskCommand');
  assert.equal(contract.taskCommand.authorizationDecision.type, 'AuthorizationDecision');
}
