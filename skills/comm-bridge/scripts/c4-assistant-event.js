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

function requireCommandFields(command, allowed, required) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new TypeError('assistant response command must be an object');
  }
  const keys = Object.keys(command);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(command, key))) {
    throw new TypeError('assistant response operator command has unsupported or missing fields');
  }
}

async function main() {
  try {
    const raw = await readStdin();
    if (!raw.trim()) throw new TypeError('assistant response command JSON is required on stdin');
    const command = JSON.parse(raw);
    const responseStream = openAssistantResponseStream();
    try {
      let result;
      if (command?.type === 'QueryDeliveries') {
        requireCommandFields(command, ['type', 'requestId', 'status', 'limit'], ['type']);
        result = {
          deliveries: responseStream.queryDeliveries({
            ...(Object.hasOwn(command, 'requestId') ? { requestId: command.requestId } : {}),
            ...(Object.hasOwn(command, 'status') ? { status: command.status } : {}),
            ...(Object.hasOwn(command, 'limit') ? { limit: command.limit } : {}),
          }),
        };
      } else if (command?.type === 'RedriveDeadLetters') {
        requireCommandFields(command, ['type', 'requestId', 'limit'], ['type', 'requestId']);
        result = responseStream.redriveDeadLetters({
          requestId: command.requestId,
          ...(Object.hasOwn(command, 'limit') ? { limit: command.limit } : {}),
        });
      } else {
        result = responseStream.execute(command);
      }
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
