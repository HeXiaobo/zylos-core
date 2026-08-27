import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(testDir, '..', 'execution-control-plane-doctor.js');

function run(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
}

test('prints a machine-readable local fallback decision for control-plane 403', () => {
  const result = run([
    '--control-plane', 'openmax',
    '--control-plane-state', 'http_error',
    '--http-status', '403',
    '--local-runtime', 'local',
    '--local-runtime-state', 'ready',
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.status, 'degraded');
  assert.equal(decision.selectedBackend, 'local');
  assert.equal(decision.dispatchAdmission, 'allowed');
  assert.equal(Object.hasOwn(decision, 'taskAdmission'), false);
  assert.equal(decision.reasonCode, 'CONTROL_PLANE_FORBIDDEN_FALLBACK_LOCAL');
  assert.equal(decision.completionPolicy, 'submit_for_review');
});

test('returns a distinct exit code when neither execution backend is available', () => {
  const result = run([
    '--control-plane', 'openmax',
    '--control-plane-state', 'unreachable',
    '--local-runtime', 'local',
    '--local-runtime-state', 'unavailable',
    '--json',
  ]);

  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stderr, '');
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.status, 'blocked');
  assert.equal(decision.selectedBackend, null);
  assert.equal(decision.dispatchAdmission, 'blocked');
});

test('fails closed on incomplete, duplicate, or contradictory CLI observations', () => {
  const invalidCases = [
    [],
    ['--unknown'],
    [
      '--control-plane', 'openmax',
      '--control-plane-state', 'ready',
      '--http-status', '403',
      '--local-runtime', 'local',
      '--local-runtime-state', 'ready',
      '--json',
    ],
    [
      '--control-plane', 'openmax',
      '--control-plane', 'paperclip',
      '--control-plane-state', 'ready',
      '--local-runtime', 'local',
      '--local-runtime-state', 'ready',
    ],
  ];

  for (const args of invalidCases) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^(INVALID_ARGUMENT|INVALID_OBSERVATION):/);
  }
});
