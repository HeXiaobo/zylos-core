import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function isMainModule(moduleUrl, argvEntry) {
  try {
    return fs.realpathSync(fileURLToPath(moduleUrl))
      === fs.realpathSync(path.resolve(argvEntry));
  } catch {
    return false;
  }
}
