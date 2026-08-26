#!/usr/bin/env node

import fs from 'node:fs';

const [channel, endpoint, ...bodyArgs] = process.argv.slice(2);
const outputPath = process.env.C4_CANARY_OUTPUT;

if (!channel || !endpoint || !outputPath) process.exit(64);

const bodyFileArg = bodyArgs.find((arg) => arg.startsWith('--body-file='));
if (bodyFileArg) {
  const bodyFilePath = bodyFileArg.slice('--body-file='.length);
  if (!bodyFilePath) process.exit(64);
  fs.writeFileSync(outputPath, JSON.stringify([
    endpoint,
    fs.readFileSync(bodyFilePath, 'utf8'),
  ]));
  process.exit(0);
}

if (bodyArgs.length > 0) {
  process.stderr.write(
    '[c4-send] arg-mode disabled: pass the message via stdin/heredoc, not as a CLI argument.\n',
  );
  process.exit(2);
}

fs.writeFileSync(outputPath, JSON.stringify([
  endpoint,
  fs.readFileSync(0, 'utf8'),
]));
