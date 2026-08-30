import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';

const DEFAULT_CORE_REPOSITORY = 'HeXiaobo/zylos-core';

/**
 * Resolve the repository used by detached core upgrade checks.
 * The live process wins, then the target Zylos instance's persisted .env,
 * then this fork's release repository. Reading is intentionally selective:
 * parsing .env must not inject unrelated credentials into this process or its
 * children.
 */
export function resolveCoreRepository({
  env = process.env,
  zylosDir = env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'),
  fsApi = fs,
} = {}) {
  const processValue = String(env.ZYLOS_SELF_UPGRADE_REPO || '').trim();
  if (processValue) return processValue;

  try {
    const fileEnv = parse(fsApi.readFileSync(path.join(zylosDir, '.env')));
    const fileValue = String(fileEnv.ZYLOS_SELF_UPGRADE_REPO || '').trim();
    if (fileValue) return fileValue;
  } catch {
    // Missing or unreadable persisted config retains fork release routing.
  }

  return DEFAULT_CORE_REPOSITORY;
}
