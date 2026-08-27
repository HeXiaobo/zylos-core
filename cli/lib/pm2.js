import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { ZYLOS_DIR } from './config.js';

export function getCoreEcosystemPath() {
  return path.join(ZYLOS_DIR, 'pm2', 'ecosystem.config.cjs');
}

export function createPm2Helpers({
  exec = execSync,
  exists = fs.existsSync,
  inspectProcessStatus = (name) => {
    const output = exec('pm2 jlist 2>/dev/null', {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const processes = JSON.parse(String(output));
    const process = processes.find((candidate) => candidate.name === name);
    return process?.pm2_env?.status ?? null;
  },
} = {}) {
  function restartFromEcosystem(names, {
    ecosystemPath = getCoreEcosystemPath(),
    stdio = 'pipe',
    save = false,
  } = {}) {
    if (!ecosystemPath || !exists(ecosystemPath)) {
      throw new Error(`ecosystem config not found: ${ecosystemPath}`);
    }

    for (const name of names) {
      exec(`pm2 start "${ecosystemPath}" --only "${name}" --update-env 2>/dev/null`, { stdio });
    }

    // Persist only after every restart succeeded so callers don't save a
    // partially-updated PM2 process list.
    if (save) {
      exec('pm2 save 2>/dev/null', { stdio });
    }
  }

  function restartManagedProcess(name, {
    ecosystemPath,
    stdio = 'pipe',
    save = false,
    fallbackToPlainRestartOnError = false,
  } = {}) {
    if (ecosystemPath && exists(ecosystemPath)) {
      try {
        restartFromEcosystem([name], { ecosystemPath, stdio, save: false });
      } catch (err) {
        if (!fallbackToPlainRestartOnError) {
          throw err;
        }
        try { exec(`pm2 delete "${name}" 2>/dev/null`, { stdio }); } catch {}
        restartFromEcosystem([name], { ecosystemPath, stdio, save: false });
      }

      let status = inspectProcessStatus(name);

      // PM2 exits zero when --only names no app in the ecosystem. Existing
      // component workers then remain stopped even though the restart was
      // reported as successful. Reactivate their cached PM2 definitions only
      // when the caller explicitly allows that recovery path.
      if (status !== 'online' && fallbackToPlainRestartOnError) {
        exec(`pm2 restart "${name}" 2>/dev/null`, { stdio });
        status = inspectProcessStatus(name);
        if (status !== 'online') {
          throw new Error(`PM2 process ${name} is ${status ?? 'missing'} after cached restart`);
        }
      } else if (status !== 'online') {
        throw new Error(`PM2 process ${name} is ${status ?? 'missing'} after ecosystem restart`);
      }
    } else {
      exec(`pm2 restart "${name}" 2>/dev/null`, { stdio });
      const status = inspectProcessStatus(name);
      if (status !== 'online') {
        throw new Error(`PM2 process ${name} is ${status ?? 'missing'} after restart`);
      }
    }

    // Never persist a process definition until its exact PM2 status has been
    // read back as online. This keeps failed/no-op restarts out of the dump.
    if (save) {
      exec('pm2 save 2>/dev/null', { stdio });
    }
  }

  return { restartFromEcosystem, restartManagedProcess };
}

export const {
  restartFromEcosystem,
  restartManagedProcess,
} = createPm2Helpers();
