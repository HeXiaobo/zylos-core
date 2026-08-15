#!/usr/bin/env node
/**
 * C4 Communication Bridge - Send Interface
 * Sends messages from Claude to external channels
 *
 * Usage (stdin only — arg-mode is DISABLED, see below):
 *     node c4-send.js <channel> <endpoint_id> <<'EOF'
 *     message with "quotes", $vars, and special chars
 *     EOF
 *
 * The message body MUST be piped via stdin/heredoc. Passing the message as a
 * CLI argument (arg-mode) is DISABLED and hard-fails with exit code 2: shell
 * quoting silently truncates special chars (105/237-char truncations observed
 * — decisions.md『HXA/comm-bridge 静默丢字事故』). stdin avoids all shell
 * escaping issues with quotes and special characters.
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

function printUsage() {
  console.log('Usage (stdin only — arg-mode disabled, hard-fails exit 2):');
  console.log('  node c4-send.js <channel> <endpoint_id> <<\'EOF\'');
  console.log('  message content');
  console.log('  EOF');
  console.log('Example:');
  console.log('  node c4-send.js telegram 8101553026 <<\'EOF\'');
  console.log('  Hello!');
  console.log('  EOF');
  process.exit(1);
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

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    printUsage();
  }

  // Separate flags (anything starting with --) from positional args. An
  // unrecognized flag (e.g. --skip-guard) must never be mis-parsed as the
  // endpoint/message positional and silently swallow piped stdin content
  // (fleet regression found 2026-07-24: 3-arg form treated "--skip-guard" as
  // the message and never read stdin). Known flags are honored; unknown flags
  // are ignored with a warning instead of leaking into positional parsing.
  const KNOWN_FLAGS = new Set(['--stdin']);
  const flagArgs = args.filter(a => /^--/.test(a));
  const cleanArgs = args.filter(a => !/^--/.test(a));
  for (const f of flagArgs) {
    if (!KNOWN_FLAGS.has(f)) {
      process.stderr.write(`[c4-send] Warning: ignoring unrecognized flag ${f} (not a known option; message body must be piped via stdin/heredoc)\n`);
    }
  }
  const hasStdinFlag = flagArgs.includes('--stdin');
  const stdinAvailable = !process.stdin.isTTY;

  const channel = cleanArgs[0];
  let endpoint = null;
  let message = null;

  if (cleanArgs.length === 2 && (stdinAvailable || hasStdinFlag)) {
    // 2 args (channel + endpoint) with piped stdin or --stdin flag: read from stdin
    endpoint = cleanArgs[1];
    message = (await readStdin()).trimEnd();
  } else if (cleanArgs.length === 1 && (stdinAvailable || hasStdinFlag)) {
    // 1 arg (channel only) with piped stdin: read from stdin
    message = (await readStdin()).trimEnd();
  } else if (cleanArgs.length === 2) {
    // 2 args, no stdin: channel + message as CLI arg (ARG-MODE). HARD-FAIL (硬化 2026-08-07).
    // NOTE: unreachable in non-TTY (cron/PM2), where stdin is always non-TTY and the
    // 2-arg+stdin branch above takes it first; kept for TTY/interactive completeness.
    console.error('[c4-send] arg-mode disabled: pass the message via stdin/heredoc, not as a CLI argument. See comm-bridge SKILL.md.');
    process.exit(2);
  } else {
    // 3+ args: channel + endpoint + message as CLI arg (ARG-MODE). HARD-FAIL (硬化 2026-08-07·
    // decisions.md『HXA/comm-bridge 静默丢字事故』): shell/quotes/special-chars silently
    // truncate arg-mode messages (105/237-char truncations observed). Reachable in non-TTY.
    console.error('[c4-send] arg-mode disabled: pass the message via stdin/heredoc, not as a CLI argument.');
    console.error("  Correct:  cat <<'EOF' | c4-send <channel> <endpoint>   ...(body)...   EOF");
    process.exit(2);
  }

  if (!message) {
    // Distinguish arg-mode misuse (2-arg + stdin source, empty body) from a genuinely empty send.
    if (cleanArgs.length === 2 && (stdinAvailable || hasStdinFlag)) {
      console.error('[c4-send] Message is required, but stdin was empty.');
      console.error('  If you intended to pass the message as a CLI argument, that is DISABLED (arg-mode).');
      console.error("  Pipe the body via stdin/heredoc:  cat <<'EOF' | c4-send <channel> <endpoint>   ...   EOF");
      // ③ exit-code 对齐 (2026-08-08·maker=Mylos·checker=Veda): 2-arg + empty stdin
      // belongs to the same "suspected arg-mode misuse" family as the hard-fails above,
      // so it returns canonical exit(2). A genuinely-empty send (else) keeps exit(1).
      process.exit(2);
    }
    console.error('Error: Message is required');
    process.exit(1);
  }

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
    stdio: 'inherit'
  });

  child.on('close', (code) => {
    if (code === 0) {
      console.log(`[C4] Message sent via ${channel}`);
    } else {
      console.log(`[C4] Failed to send message via ${channel} (exit code: ${code})`);
    }
    process.exit(code);
  });

  child.on('error', (err) => {
    console.error(`[C4] Error executing channel script: ${err.stack}`);
    process.exit(1);
  });
}

main();
