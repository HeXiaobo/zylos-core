import fs from 'node:fs';
import path from 'node:path';

import { loadCoreCapabilities } from './capabilities.js';

export function verifyTargetCapabilities(targetDir, { core = loadCoreCapabilities() } = {}) {
  const manifestPath = path.join(targetDir, 'capabilities.json');
  if (!fs.existsSync(manifestPath)) {
    return { status: 'skipped', reason: 'target has no capability requirements' };
  }

  let target;
  try {
    target = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return { status: 'incompatible', errors: [`Target capabilities are invalid: ${error.message}`] };
  }

  const required = target?.requires?.['zylos-core'];
  if (!required) {
    return { status: 'skipped', reason: 'target has no zylos-core requirements', target };
  }

  const errors = [];
  if (required.schemaVersion !== core.schemaVersion) {
    errors.push(`Capability schema requires ${required.schemaVersion}, found ${core.schemaVersion}`);
  }
  for (const [name, minimum] of Object.entries(required.protocols || {})) {
    const actual = core.protocols?.[name];
    if (!Number.isInteger(minimum) || !Number.isInteger(actual) || actual < minimum) {
      errors.push(`Protocol ${name} requires >= ${minimum}, found ${actual ?? 'missing'}`);
    }
  }

  return {
    status: errors.length === 0 ? 'compatible' : 'incompatible',
    errors,
    target,
    core,
  };
}
