import fs from 'node:fs';

const CAPABILITIES_URL = new URL('../../capabilities.json', import.meta.url);

export function loadCoreCapabilities() {
  return JSON.parse(fs.readFileSync(CAPABILITIES_URL, 'utf8'));
}
