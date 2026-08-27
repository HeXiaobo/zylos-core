import { loadCoreCapabilities } from '../lib/capabilities.js';

export function capabilitiesCommand(args) {
  const unknown = args.find((arg) => arg !== '--json');
  if (unknown) {
    console.error(`Unknown capabilities option: ${unknown}`);
    process.exitCode = 1;
    return;
  }

  const capabilities = loadCoreCapabilities();
  if (args.includes('--json')) {
    console.log(JSON.stringify(capabilities));
    return;
  }

  console.log(`Zylos Core ${capabilities.release}`);
  for (const [name, version] of Object.entries(capabilities.protocols)) {
    console.log(`  ${name}: ${version}`);
  }
}
