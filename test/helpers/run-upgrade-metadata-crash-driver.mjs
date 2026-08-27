import fs from 'node:fs';
import path from 'node:path';
import { runUpgrade } from '../../cli/lib/upgrade.js';

const [component, tempDir, newVersion] = process.argv.slice(2);
const source = JSON.parse(process.env.ZYLOS_TEST_UPGRADE_SOURCE);
const registryEntry = JSON.parse(process.env.ZYLOS_TEST_UPGRADE_REGISTRY_ENTRY);
const crashPoint = process.env.ZYLOS_TEST_UPGRADE_CRASH_POINT || 'after-baseline-rename';
const realRename = fs.renameSync;

fs.renameSync = (src, dest) => {
  if (
    crashPoint === 'before-baseline-rename'
    && String(dest).endsWith(path.join('.zylos', 'manifest.json'))
  ) {
    process.exit(87);
  }
  const result = realRename(src, dest);
  if (
    crashPoint === 'after-baseline-rename'
    && String(dest).endsWith(path.join('.zylos', 'manifest.json'))
  ) {
    process.exit(86);
  }
  return result;
};

runUpgrade(component, {
  tempDir,
  newVersion,
  jsonOutput: true,
  source,
  registryEntry,
});
