import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isMainModule } from '../main-module.js';

const SUPERVISOR_PATH = fileURLToPath(new URL('../c4-intake-supervisor.js', import.meta.url));

test('recognizes a relative argv entry for the imported module', () => {
  const relativeEntry = path.relative(process.cwd(), SUPERVISOR_PATH);

  assert.equal(isMainModule(pathToFileURL(SUPERVISOR_PATH).href, relativeEntry), true);
});

test('fails closed when the process entry is absent or cannot be resolved', () => {
  const moduleUrl = pathToFileURL(SUPERVISOR_PATH).href;

  assert.equal(isMainModule(moduleUrl, undefined), false);
  assert.equal(isMainModule(moduleUrl, path.join(os.tmpdir(), 'missing-zylos-entry.js')), false);
});
