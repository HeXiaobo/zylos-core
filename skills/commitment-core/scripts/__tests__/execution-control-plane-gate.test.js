import test from 'node:test';
import assert from 'node:assert/strict';

import { decideExecutionControlPlane } from '../execution-control-plane-gate.js';
import { mapExternalExecutionEvent } from '../external-execution-adapter.js';

test('selects an available control plane without depending on local runtime health', () => {
  assert.deepEqual(
    decideExecutionControlPlane({
      controlPlane: {
        backend: 'openmax',
        state: 'ready',
        httpStatus: null,
      },
      localRuntime: {
        backend: 'local',
        state: 'unavailable',
      },
    }),
    {
      schemaVersion: 1,
      status: 'available',
      selectedBackend: 'openmax',
      dispatchAdmission: 'allowed',
      completionPolicy: 'submit_for_review',
      reasonCode: 'CONTROL_PLANE_READY',
      observations: {
        controlPlane: {
          backend: 'openmax',
          state: 'ready',
          httpStatus: null,
        },
        localRuntime: {
          backend: 'local',
          state: 'unavailable',
        },
      },
    },
  );
});

test('degrades to local execution when the control plane returns 403', () => {
  const decision = decideExecutionControlPlane({
    controlPlane: {
      backend: 'openmax',
      state: 'http_error',
      httpStatus: 403,
    },
    localRuntime: {
      backend: 'local',
      state: 'ready',
    },
  });

  assert.deepEqual(decision, {
    schemaVersion: 1,
    status: 'degraded',
    selectedBackend: 'local',
    dispatchAdmission: 'allowed',
    completionPolicy: 'submit_for_review',
    reasonCode: 'CONTROL_PLANE_FORBIDDEN_FALLBACK_LOCAL',
    observations: {
      controlPlane: {
        backend: 'openmax',
        state: 'http_error',
        httpStatus: 403,
      },
      localRuntime: {
        backend: 'local',
        state: 'ready',
      },
    },
  });
});

test('blocks execution only when both the control plane and local runtime are unavailable', () => {
  const decision = decideExecutionControlPlane({
    controlPlane: {
      backend: 'openmax',
      state: 'unreachable',
      httpStatus: null,
    },
    localRuntime: {
      backend: 'local',
      state: 'unavailable',
    },
  });

  assert.equal(decision.status, 'blocked');
  assert.equal(decision.selectedBackend, null);
  assert.equal(decision.dispatchAdmission, 'blocked');
  assert.equal(Object.hasOwn(decision, 'taskAdmission'), false);
  assert.equal(decision.completionPolicy, 'submit_for_review');
  assert.equal(decision.reasonCode, 'NO_EXECUTION_BACKEND');
});

test('reports why a non-ready control plane fell back to local execution', () => {
  const cases = [
    ['disabled', null, 'CONTROL_PLANE_DISABLED_FALLBACK_LOCAL'],
    ['unreachable', null, 'CONTROL_PLANE_UNREACHABLE_FALLBACK_LOCAL'],
    ['http_error', 503, 'CONTROL_PLANE_HTTP_ERROR_FALLBACK_LOCAL'],
  ];

  for (const [state, httpStatus, reasonCode] of cases) {
    const decision = decideExecutionControlPlane({
      controlPlane: { backend: 'control', state, httpStatus },
      localRuntime: { backend: 'local', state: 'ready' },
    });

    assert.equal(decision.status, 'degraded');
    assert.equal(decision.selectedBackend, 'local');
    assert.equal(decision.reasonCode, reasonCode);
  }
});

test('fails closed for malformed or ambiguous health observations', () => {
  const valid = {
    controlPlane: { backend: 'openmax', state: 'ready', httpStatus: null },
    localRuntime: { backend: 'local', state: 'ready' },
  };
  const invalid = [
    undefined,
    null,
    {},
    { ...valid, metadata: {} },
    { ...valid, controlPlane: null },
    { ...valid, controlPlane: { ...valid.controlPlane, backend: 'OpenMax' } },
    { ...valid, controlPlane: { ...valid.controlPlane, backend: '' } },
    { ...valid, controlPlane: { ...valid.controlPlane, state: 'unknown' } },
    { ...valid, controlPlane: { ...valid.controlPlane, httpStatus: 200 } },
    {
      ...valid,
      controlPlane: { backend: 'openmax', state: 'http_error', httpStatus: null },
    },
    {
      ...valid,
      controlPlane: { backend: 'openmax', state: 'http_error', httpStatus: 302 },
    },
    { ...valid, controlPlane: { ...valid.controlPlane, token: 'must-not-pass' } },
    { ...valid, localRuntime: null },
    { ...valid, localRuntime: { ...valid.localRuntime, backend: 'Local Runtime' } },
    { ...valid, localRuntime: { ...valid.localRuntime, state: 'degraded' } },
    { ...valid, localRuntime: { ...valid.localRuntime, pid: 123 } },
  ];

  for (const observation of invalid) {
    assert.throws(() => decideExecutionControlPlane(observation), TypeError);
  }
});

test('fails closed when control plane and fallback identify the same backend', () => {
  assert.throws(
    () => decideExecutionControlPlane({
      controlPlane: { backend: 'same', state: 'http_error', httpStatus: 403 },
      localRuntime: { backend: 'same', state: 'ready' },
    }),
    new TypeError('controlPlane.backend and localRuntime.backend must be different'),
  );
});

test('routes completion from either selected backend to review, never acceptance', () => {
  const observations = [
    {
      controlPlane: { backend: 'openmax', state: 'ready', httpStatus: null },
      localRuntime: { backend: 'local', state: 'ready' },
    },
    {
      controlPlane: { backend: 'openmax', state: 'http_error', httpStatus: 403 },
      localRuntime: { backend: 'local', state: 'ready' },
    },
  ];

  for (const observation of observations) {
    const decision = decideExecutionControlPlane(observation);
    const mapped = mapExternalExecutionEvent({
      backend: decision.selectedBackend,
      eventId: `delivered-by-${decision.selectedBackend}`,
      eventType: 'delivered',
      taskId: 'task-review-only',
      actorId: 'agent:executor',
      expectedVersion: 2,
    });

    assert.equal(decision.completionPolicy, 'submit_for_review');
    assert.equal(mapped.command.type, 'SubmitForReview');
    assert.notEqual(mapped.command.type, 'AcceptTask');
  }
});
