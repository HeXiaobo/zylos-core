#!/usr/bin/env node

import { openAssistantResponseStream } from './assistant-response-stream.js';

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  });
}

async function main() {
  try {
    const raw = await readStdin();
    if (!raw.trim()) throw new TypeError('assistant response command JSON is required on stdin');
    const command = JSON.parse(raw);
    const responseStream = openAssistantResponseStream();
    try {
      const result = responseStream.execute(command);
      process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    } finally {
      responseStream.close();
    }
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: {
        code: err?.code || 'ASSISTANT_EVENT_REJECTED',
        message: err?.message || 'assistant response event rejected',
      },
    })}\n`);
    process.exitCode = 1;
  }
}

main();
