#!/usr/bin/env node
/**
 * C4 Communication Bridge - Send Interface
 * Sends messages from Claude to external channels
 *
 * Usage (stdin only — arg-mode is disabled):
 *     node c4-send.js <channel> <endpoint_id> <<'EOF'
 *     message with "quotes", $vars, and special chars
 *     EOF
 *
 * The message body must be piped via stdin/heredoc. Passing it as a CLI
 * argument hard-fails with exit code 2 because shell quoting can silently
 * truncate or transform message content. During a bounded migration only,
 * C4_LEGACY_ARG_MODE=1 accepts the unambiguous channel + endpoint + message
 * form and emits a content-free deprecation event.
 *
 * Special channel 'void' (#689): internal-only messages (e.g. session
 * handoffs). The message is recorded in c4.db like any other conversation
 * row — so session-init context injection and Memory Sync pick it up — but
 * it is never dispatched to a channel send script. The endpoint carries the
 * purpose/topic and is mandatory, e.g.:
 *   node c4-send.js void session-handoff <<'EOF'
 *   ...handoff summary...
 *   EOF
 */

import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { insertConversation, close } from './c4-db.js';
import { SKILLS_DIR } from './c4-config.js';
import { validateChannel, validateEndpoint } from './c4-validate.js';
import { openAssistantResponseStream } from './assistant-response-stream.js';

function printUsage() {
  console.log('Usage (stdin only; CLI message arguments are disabled):');
  console.log('  node c4-send.js <channel> <endpoint_id> <<\'EOF\'');
  console.log('  message content');
  console.log('  EOF');
  console.log('Example:');
  console.log('  node c4-send.js telegram 8101553026 <<\'EOF\'');
  console.log('  Hello!');
  console.log('  EOF');
  process.exit(1);
}

function parseArgs(args) {
  const positional = [];
  let requestId = null;
  let hasStdinFlag = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--stdin') {
      hasStdinFlag = true;
      continue;
    }
    if (arg === '--request-id') {
      if (requestId !== null || index + 1 >= args.length) {
        return { error: '--request-id requires one value' };
      }
      requestId = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) return { error: `Unknown option: ${arg}` };
    positional.push(arg);
  }
  return { positional, requestId, hasStdinFlag };
}

/**
 * Read all data from stdin.
 */
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function publicAssistantOutput(message) {
  return /^\[MEDIA:(?:image|file)\].+/s.test(message) ? '' : message;
}

async function main() {
  const args = process.argv.slice(2);
  const parsed = parseArgs(args);
  if (parsed.error) {
    console.error(`Error: ${parsed.error}`);
    process.exit(1);
  }
  if (parsed.positional.length < 1) {
    printUsage();
  }

  const cleanArgs = parsed.positional;
  const hasStdinFlag = parsed.hasStdinFlag;
  const stdinAvailable = !process.stdin.isTTY;
  const legacyArgMode = process.env.C4_LEGACY_ARG_MODE === '1';

  const channel = cleanArgs[0];
  let endpoint = null;
  let message = null;

  if (cleanArgs.length === 3 && legacyArgMode && cleanArgs[0] !== 'void') {
    endpoint = cleanArgs[1];
    message = cleanArgs[2];
    console.error(`[c4-send] ${JSON.stringify({
      event: 'legacy_arg_mode_used',
      channel,
      endpointPresent: true,
    })}`);
  } else if (cleanArgs.length > 2) {
    console.error('[c4-send] arg-mode disabled: pass the message via stdin/heredoc, not as a CLI argument.');
    process.exit(2);
  } else if (cleanArgs.length === 2 && (stdinAvailable || hasStdinFlag)) {
    // 2 args (channel + endpoint) with piped stdin or --stdin flag: read from stdin
    endpoint = cleanArgs[1];
    message = (await readStdin()).trimEnd();
  } else if (cleanArgs.length === 1 && (stdinAvailable || hasStdinFlag)) {
    // 1 arg (channel only) with piped stdin: read from stdin
    message = (await readStdin()).trimEnd();
  } else if (cleanArgs.length === 1) {
    printUsage();
  } else {
    // 2 args with a TTY means the second positional can only be an arg-mode
    // message or an endpoint with a missing stdin body. Both are unsafe.
    console.error('[c4-send] arg-mode disabled: pass the message via stdin/heredoc, not as a CLI argument.');
    process.exit(2);
  }

  if (!message) {
    if (cleanArgs.length === 2 && (stdinAvailable || hasStdinFlag)) {
      console.error('[c4-send] Message is required, but stdin was empty.');
      console.error('  CLI message arguments are disabled; pipe the body via stdin/heredoc.');
      process.exit(2);
    }
    if (cleanArgs.length === 1) printUsage();
    console.error('Error: Message is required');
    process.exit(1);
  }

  const assistantRequestId = parsed.requestId;

  // Virtual 'void' channel (#689): record-only, never dispatched.
  // No skill directory exists for it, so skip channel-path validation and
  // the channel send script entirely.
  if (channel === 'void') {
    if (!endpoint) {
      console.error('Error: Endpoint is required for the void channel (e.g. c4-send.js void session-handoff)');
      process.exit(1);
    }

    try {
      validateEndpoint(endpoint);
    } catch (err) {
      console.error(`[C4] Invalid endpoint: ${err.stack}`);
      process.exit(1);
    }

    try {
      insertConversation('out', 'void', endpoint, message);
    } catch (err) {
      // Unlike real channels (where the DB row is an audit trail), the DB
      // write IS the delivery for void — fail loudly.
      console.error(`[C4] Failed to record void message: ${err.stack}`);
      process.exit(1);
    } finally {
      close();
    }

    console.log('[C4] Message recorded on void channel (not dispatched)');
    process.exit(0);
  }

  try {
    validateChannel(channel, true);
  } catch (err) {
    console.error(`[C4] Invalid channel: ${err.stack}`);
    process.exit(1);
  }

  if (endpoint) {
    try {
      validateEndpoint(endpoint);
    } catch (err) {
      console.error(`[C4] Invalid endpoint: ${err.stack}`);
      process.exit(1);
    }
  }

  if (assistantRequestId) {
    try {
      const responseStream = openAssistantResponseStream();
      const stream = responseStream.query({ requestId: assistantRequestId });
      responseStream.close();
      if (!stream) throw new Error('assistant request does not exist');
      if (stream.request.route.channel !== channel || stream.request.route.endpointId !== endpoint) {
        throw new Error('assistant request does not match its channel route');
      }
    } catch (err) {
      console.error(`[C4] Invalid assistant request: ${err.message}`);
      process.exit(1);
    }
  }

  try {
    insertConversation('out', channel, endpoint, message);
  } catch (err) {
    console.error(`[C4] Warning: DB audit write failed: ${err.stack}`);
  } finally {
    close();
  }

  const channelScript = path.join(SKILLS_DIR, channel, 'scripts', 'send.js');

  if (!fs.existsSync(channelScript)) {
    console.error(`Error: Channel script not found: ${channelScript}`);
    console.error('Channels must provide scripts/send.js (Node.js standard)');
    process.exit(1);
  }

  const scriptArgs = endpoint ? [endpoint, message] : [message];

  const child = spawn('node', [channelScript, ...scriptArgs], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...(assistantRequestId ? { C4_ASSISTANT_REQUEST_ID: assistantRequestId } : {}),
    },
  });

  child.on('close', (code) => {
    let terminalWriteFailed = false;
    if (assistantRequestId) {
      try {
        const responseStream = openAssistantResponseStream();
        responseStream.execute(code === 0
          ? {
              type: 'CompleteRun',
              requestId: assistantRequestId,
              output: publicAssistantOutput(message),
            }
          : {
              type: 'FailRun',
              requestId: assistantRequestId,
              code: 'CHANNEL_DELIVERY_FAILED',
              retryable: true,
            });
        responseStream.close();
      } catch (err) {
        terminalWriteFailed = true;
        console.error(`[C4] Warning: failed to record assistant terminal event: ${err.message}`);
      }
    }
    const exitCode = terminalWriteFailed ? 1 : code;
    if (exitCode === 0) {
      console.log(`[C4] Message sent via ${channel}`);
    } else if (code !== 0) {
      console.log(`[C4] Failed to send message via ${channel} (exit code: ${code})`);
    } else {
      console.log(`[C4] Failed to complete message via ${channel} (exit code: ${exitCode})`);
    }
    process.exit(exitCode);
  });

  child.on('error', (err) => {
    if (assistantRequestId) {
      try {
        const responseStream = openAssistantResponseStream();
        responseStream.execute({
          type: 'FailRun',
          requestId: assistantRequestId,
          code: 'CHANNEL_ADAPTER_UNAVAILABLE',
          retryable: true,
        });
        responseStream.close();
      } catch (streamError) {
        console.error(`[C4] Warning: failed to record assistant failure event: ${streamError.message}`);
      }
    }
    console.error(`[C4] Error executing channel script: ${err.stack}`);
    process.exit(1);
  });
}

main();
