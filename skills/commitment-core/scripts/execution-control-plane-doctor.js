import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { decideExecutionControlPlane } from './execution-control-plane-gate.js';

const VALUE_FLAGS = new Set([
  '--control-plane',
  '--control-plane-state',
  '--http-status',
  '--local-runtime',
  '--local-runtime-state',
]);

function argumentError(message) {
  const error = new TypeError(message);
  error.code = 'INVALID_ARGUMENT';
  return error;
}

export function parseExecutionControlPlaneArgs(args) {
  const values = new Map();
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--json') {
      if (json) throw argumentError('duplicate flag: --json');
      json = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) {
      throw argumentError(`unknown flag: ${flag}`);
    }
    if (values.has(flag)) {
      throw argumentError(`duplicate flag: ${flag}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw argumentError(`missing value for ${flag}`);
    }
    values.set(flag, value);
    index += 1;
  }

  for (const flag of [
    '--control-plane',
    '--control-plane-state',
    '--local-runtime',
    '--local-runtime-state',
  ]) {
    if (!values.has(flag)) throw argumentError(`missing required flag: ${flag}`);
  }

  const rawHttpStatus = values.get('--http-status');
  const httpStatus = rawHttpStatus === undefined ? null : Number(rawHttpStatus);
  if (rawHttpStatus !== undefined && !/^\d+$/.test(rawHttpStatus)) {
    throw argumentError('--http-status must be an integer');
  }

  return {
    json,
    observation: {
      controlPlane: {
        backend: values.get('--control-plane'),
        state: values.get('--control-plane-state'),
        httpStatus,
      },
      localRuntime: {
        backend: values.get('--local-runtime'),
        state: values.get('--local-runtime-state'),
      },
    },
  };
}

export function runExecutionControlPlaneDoctor(args = process.argv.slice(2)) {
  const { json, observation } = parseExecutionControlPlaneArgs(args);
  const decision = decideExecutionControlPlane(observation);
  if (json) {
    process.stdout.write(`${JSON.stringify(decision)}\n`);
  } else {
    process.stdout.write(
      `${decision.status} selected=${decision.selectedBackend ?? 'none'} `
      + `admission=${decision.taskAdmission} reason=${decision.reasonCode} `
      + `completion=${decision.completionPolicy}\n`,
    );
  }
  return decision.status === 'blocked' ? 2 : 0;
}

const isMainModule = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMainModule) {
  try {
    process.exitCode = runExecutionControlPlaneDoctor();
  } catch (error) {
    process.stderr.write(`${error.code ?? 'INVALID_OBSERVATION'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
