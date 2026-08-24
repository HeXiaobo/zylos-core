const COMPLETION_POLICY = 'submit_for_review';
const BACKEND_ID = /^[a-z0-9][a-z0-9._-]*$/;
const CONTROL_PLANE_STATES = new Set(['ready', 'disabled', 'unreachable', 'http_error']);
const LOCAL_RUNTIME_STATES = new Set(['ready', 'unavailable']);

function requireObject(value, name, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.length || !fields.every((field) => Object.hasOwn(value, field))) {
    throw new TypeError(`${name} has unsupported fields`);
  }
  return value;
}

function requireBackend(value, name) {
  if (typeof value !== 'string' || !BACKEND_ID.test(value)) {
    throw new TypeError(`${name}.backend must be a canonical lowercase identifier`);
  }
}

function requireControlPlane(value) {
  const observation = requireObject(
    value,
    'controlPlane',
    ['backend', 'state', 'httpStatus'],
  );
  requireBackend(observation.backend, 'controlPlane');
  if (!CONTROL_PLANE_STATES.has(observation.state)) {
    throw new TypeError('controlPlane.state is not supported');
  }
  if (observation.state === 'http_error') {
    if (
      !Number.isSafeInteger(observation.httpStatus)
      || observation.httpStatus < 400
      || observation.httpStatus > 599
    ) {
      throw new TypeError('controlPlane.httpStatus must be a 4xx or 5xx status');
    }
  } else if (observation.httpStatus !== null) {
    throw new TypeError('controlPlane.httpStatus must be null outside http_error');
  }
  return observation;
}

function requireLocalRuntime(value) {
  const observation = requireObject(value, 'localRuntime', ['backend', 'state']);
  requireBackend(observation.backend, 'localRuntime');
  if (!LOCAL_RUNTIME_STATES.has(observation.state)) {
    throw new TypeError('localRuntime.state is not supported');
  }
  return observation;
}

function requireDecisionInput(value) {
  const input = requireObject(value, 'execution observation', ['controlPlane', 'localRuntime']);
  const controlPlane = requireControlPlane(input.controlPlane);
  const localRuntime = requireLocalRuntime(input.localRuntime);
  if (controlPlane.backend === localRuntime.backend) {
    throw new TypeError('controlPlane.backend and localRuntime.backend must be different');
  }
  return { controlPlane, localRuntime };
}

function fallbackReasonCode(controlPlane) {
  if (controlPlane.state === 'disabled') {
    return 'CONTROL_PLANE_DISABLED_FALLBACK_LOCAL';
  }
  if (controlPlane.state === 'unreachable') {
    return 'CONTROL_PLANE_UNREACHABLE_FALLBACK_LOCAL';
  }
  if (controlPlane.state === 'http_error' && controlPlane.httpStatus === 403) {
    return 'CONTROL_PLANE_FORBIDDEN_FALLBACK_LOCAL';
  }
  return 'CONTROL_PLANE_HTTP_ERROR_FALLBACK_LOCAL';
}

/**
 * Select one execution backend from normalized health observations.
 * Network probes and platform payloads belong in runtime-specific Adapters.
 */
export function decideExecutionControlPlane(input) {
  const { controlPlane, localRuntime } = requireDecisionInput(input);
  const controlPlaneReady = controlPlane.state === 'ready';
  const useLocalFallback = !controlPlaneReady && localRuntime.state === 'ready';
  const blocked = !controlPlaneReady && !useLocalFallback;

  return {
    schemaVersion: 1,
    status: blocked ? 'blocked' : useLocalFallback ? 'degraded' : 'available',
    selectedBackend: blocked
      ? null
      : useLocalFallback ? localRuntime.backend : controlPlane.backend,
    dispatchAdmission: blocked ? 'blocked' : 'allowed',
    completionPolicy: COMPLETION_POLICY,
    reasonCode: blocked
      ? 'NO_EXECUTION_BACKEND'
      : useLocalFallback ? fallbackReasonCode(controlPlane) : 'CONTROL_PLANE_READY',
    observations: {
      controlPlane: { ...controlPlane },
      localRuntime: { ...localRuntime },
    },
  };
}
