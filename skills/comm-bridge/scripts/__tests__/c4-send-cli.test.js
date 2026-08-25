import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CLI_PATH = fileURLToPath(new URL('../c4-send.js', import.meta.url));
const DB_CLI_PATH = fileURLToPath(new URL('../c4-db.js', import.meta.url));

function cli(args, env = {}, input = undefined) {
  const nodeArgs = input === undefined
    ? [
      '--input-type=module',
      '-e',
      [
        "Object.defineProperty(process.stdin, 'isTTY', { value: true });",
        `process.argv = [process.execPath, ${JSON.stringify(CLI_PATH)}, ...${JSON.stringify(args)}];`,
        `await import(${JSON.stringify(pathToFileURL(CLI_PATH).href)});`,
      ].join(''),
    ]
    : [CLI_PATH, ...args];
  const result = spawnSync('node', nodeArgs, {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 5000,
    ...(input !== undefined ? { input } : {})
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function dbRecent(env, limit = 10) {
  const result = spawnSync('node', [DB_CLI_PATH, 'recent', String(limit)], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 5000
  });
  // Skip the "[C4-DB] Database initialized" banner printed on first open.
  const json = result.stdout.split('\n').filter((line) => !line.startsWith('[C4-DB]')).join('\n');
  return JSON.parse(json);
}

function withTmpDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-send-cli-'));
  const env = { ZYLOS_DIR: tmpDir };
  try {
    return fn({ tmpDir, env });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Create a mock channel with a send.js script that writes args to a file
 * and exits 0.
 */
function setupMockChannel(tmpDir, channelName) {
  const skillDir = path.join(tmpDir, '.claude', 'skills', channelName, 'scripts');
  fs.mkdirSync(skillDir, { recursive: true });

  const sentFile = path.join(tmpDir, `${channelName}-sent.json`);
  // Mock send.js: writes received args to a file
  fs.writeFileSync(path.join(skillDir, 'send.js'), `
    import fs from 'fs';
    const args = process.argv.slice(2);
    fs.writeFileSync('${sentFile.replace(/'/g, "\\'")}', JSON.stringify(args));
    process.exit(0);
  `);

  return sentFile;
}

function setupDeliveryIdentityChannel(tmpDir, channelName, { exitCode = 0 } = {}) {
  const skillDir = path.join(tmpDir, '.claude', 'skills', channelName, 'scripts');
  fs.mkdirSync(skillDir, { recursive: true });

  const sentFile = path.join(tmpDir, `${channelName}-delivery.json`);
  fs.writeFileSync(path.join(skillDir, 'send.js'), `
    import fs from 'fs';
    fs.writeFileSync(${JSON.stringify(sentFile)}, JSON.stringify({
      deliveryId: process.env.C4_DELIVERY_ID || null,
      assistantRequestId: process.env.C4_ASSISTANT_REQUEST_ID || null,
    }));
    process.exit(${exitCode});
  `);

  return sentFile;
}

// -- basic send --

describe('c4-send basic', () => {
  it('sends a message from stdin via mock channel with endpoint', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');

      const { stdout, status } = cli(['mock-channel', 'endpoint1'], env, 'Hello!');
      assert.equal(status, 0);
      assert.ok(stdout.includes('Message sent via mock-channel'));

      const sent = JSON.parse(fs.readFileSync(sentFile, 'utf8'));
      assert.deepEqual(sent, ['endpoint1', 'Hello!']);
    });
  });

  it('sends a message from stdin via mock channel without endpoint (broadcast)', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');

      const { stdout, status } = cli(['mock-channel', '--stdin'], env, 'Hello broadcast!');
      assert.equal(status, 0);
      assert.ok(stdout.includes('Message sent via mock-channel'));

      const sent = JSON.parse(fs.readFileSync(sentFile, 'utf8'));
      assert.deepEqual(sent, ['Hello broadcast!']);
    });
  });

  it('passes the persisted outbound conversation identity to the channel adapter', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupDeliveryIdentityChannel(tmpDir, 'identity-channel');

      const { status } = cli(['identity-channel', 'endpoint1'], env, 'Stable delivery');
      assert.equal(status, 0);

      const [outbound] = dbRecent(env, 1);
      const delivered = JSON.parse(fs.readFileSync(sentFile, 'utf8'));
      assert.equal(delivered.deliveryId, `c4.outbound.${outbound.id}`);
      assert.equal(delivered.assistantRequestId, null);
      assert.doesNotMatch(delivered.deliveryId, /Stable delivery/);
    });
  });

  it('uses a different stable identity for each persisted outbound delivery', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupDeliveryIdentityChannel(tmpDir, 'identity-channel');

      assert.equal(cli(['identity-channel'], env, 'First').status, 0);
      const first = JSON.parse(fs.readFileSync(sentFile, 'utf8')).deliveryId;
      assert.equal(cli(['identity-channel'], env, 'Second').status, 0);
      const second = JSON.parse(fs.readFileSync(sentFile, 'utf8')).deliveryId;

      assert.notEqual(first, second);
      assert.match(first, /^c4\.outbound\.\d+$/);
      assert.match(second, /^c4\.outbound\.\d+$/);
    });
  });
});

// -- validation --

describe('c4-send validation', () => {
  it('errors with no arguments', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cli([], env);
      assert.equal(status, 1);
      assert.ok(stdout.includes('Usage'));
    });
  });

  it('errors with only channel (no message)', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cli(['telegram'], env);
      assert.equal(status, 1);
      assert.ok(stdout.includes('Usage'));
    });
  });

  it('errors when channel script not found', () => {
    withTmpDir(({ tmpDir, env }) => {
      // Create the channel directory but no send.js
      const skillDir = path.join(tmpDir, '.claude', 'skills', 'fake-channel');
      fs.mkdirSync(skillDir, { recursive: true });

      const { stderr, status } = cli(['fake-channel'], env, 'Hello');
      assert.equal(status, 1);
      assert.ok(stderr.includes('Channel script not found'));
    });
  });

  it('keeps exact endpoint message arg-mode working during the compatibility phase', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');

      const { stderr, status } = cli(['mock-channel', 'endpoint1', 'unsafe $message'], env);

      assert.equal(status, 0);
      assert.match(stderr, /legacy_arg_mode_used/);
      assert.doesNotMatch(stderr, /unsafe \$message/);
      const sent = JSON.parse(fs.readFileSync(sentFile, 'utf8'));
      assert.deepEqual(sent, ['endpoint1', 'unsafe $message']);
    });
  });

  it('accepts the explicit legacy flag as a break-glass override', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');

      const { stderr, status } = cli(
        ['mock-channel', 'endpoint1', 'legacy message with $vars'],
        { ...env, C4_LEGACY_ARG_MODE: '1' },
      );

      assert.equal(status, 0);
      assert.match(stderr, /legacy_arg_mode_used/);
      assert.doesNotMatch(stderr, /legacy message with \$vars/);
      const sent = JSON.parse(fs.readFileSync(sentFile, 'utf8'));
      assert.deepEqual(sent, ['endpoint1', 'legacy message with $vars']);
    });
  });

  it('rejects endpoint message arg-mode only when strict stdin-only policy is explicit', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');

      const { stderr, status } = cli(
        ['mock-channel', 'endpoint1', 'unsafe $message'],
        { ...env, C4_STRICT_STDIN_ONLY: '1' },
      );

      assert.equal(status, 2);
      assert.match(stderr, /strict stdin-only policy/i);
      assert.doesNotMatch(stderr, /unsafe \$message/);
      assert.equal(fs.existsSync(sentFile), false);
    });
  });

  it('allows the break-glass flag to override strict stdin-only policy', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');

      const { status } = cli(
        ['mock-channel', 'endpoint1', 'recovery message'],
        { ...env, C4_STRICT_STDIN_ONLY: '1', C4_LEGACY_ARG_MODE: '1' },
      );

      assert.equal(status, 0);
      const sent = JSON.parse(fs.readFileSync(sentFile, 'utf8'));
      assert.deepEqual(sent, ['endpoint1', 'recovery message']);
    });
  });

  it('reads the migration flag from the Zylos env file without a runtime restart', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');
      fs.writeFileSync(path.join(tmpDir, '.env'), 'C4_LEGACY_ARG_MODE=1\n');

      const { status } = cli(
        ['mock-channel', 'endpoint1', 'legacy after upgrade'],
        env,
      );

      assert.equal(status, 0);
      const sent = JSON.parse(fs.readFileSync(sentFile, 'utf8'));
      assert.deepEqual(sent, ['endpoint1', 'legacy after upgrade']);
    });
  });

  it('reads strict stdin-only policy from the Zylos env file without a runtime restart', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');
      fs.writeFileSync(path.join(tmpDir, '.env'), 'C4_STRICT_STDIN_ONLY=1\n');

      const { status } = cli(
        ['mock-channel', 'endpoint1', 'must use stdin'],
        env,
      );

      assert.equal(status, 2);
      assert.equal(fs.existsSync(sentFile), false);
    });
  });

  it('rejects broadcast message arg-mode with exit 2 before dispatch', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');

      const { stderr, status } = cli(['mock-channel', 'unsafe $message'], env);

      assert.equal(status, 2);
      assert.match(stderr, /arg-mode disabled/i);
      assert.equal(fs.existsSync(sentFile), false);
    });
  });

  it('rejects empty stdin with exit 2 instead of treating the endpoint as a message', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');

      const { stderr, status } = cli(['mock-channel', 'endpoint1'], env, '');

      assert.equal(status, 2);
      assert.match(stderr, /stdin was empty/i);
      assert.equal(fs.existsSync(sentFile), false);
    });
  });

  it('rejects unknown options instead of parsing them as message content', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');

      const { stderr, status } = cli(['mock-channel', 'endpoint1', '--skip-guard'], env, 'safe body');

      assert.equal(status, 1);
      assert.match(stderr, /Unknown option: --skip-guard/);
      assert.equal(fs.existsSync(sentFile), false);
    });
  });
});

// -- void channel (#689) --

describe('c4-send void channel', () => {
  it('records the message in c4.db and exits 0 without a skill directory', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cli(['void', 'session-handoff'], env, 'handoff summary');
      assert.equal(status, 0);
      assert.ok(stdout.includes('recorded on void channel'));
      assert.ok(!stdout.includes('Message sent via'));

      const rows = dbRecent(env);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].direction, 'out');
      assert.equal(rows[0].channel, 'void');
      assert.equal(rows[0].endpoint_id, 'session-handoff');
      assert.equal(rows[0].content, 'handoff summary');
      assert.equal(rows[0].status, 'delivered');
    });
  });

  it('does not spawn a channel send script even if one exists', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'void');

      const { status } = cli(['void', 'session-handoff'], env, 'handoff summary');
      assert.equal(status, 0);
      assert.ok(!fs.existsSync(sentFile), 'void must never dispatch to a send script');
    });
  });

  it('supports stdin/heredoc message input', () => {
    withTmpDir(({ env }) => {
      const message = 'multi-line handoff\nwith "quotes" and $vars';
      const { stdout, status } = cli(['void', 'session-handoff'], env, message);
      assert.equal(status, 0);
      assert.ok(stdout.includes('recorded on void channel'));

      const rows = dbRecent(env);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].channel, 'void');
      assert.equal(rows[0].content, message);
    });
  });

  it('rejects a void send without an endpoint', () => {
    withTmpDir(({ env }) => {
      // --stdin with a single arg is the only reachable no-endpoint form
      const { stderr, status } = cli(['void', '--stdin'], env, 'orphan message');
      assert.equal(status, 1);
      assert.ok(stderr.includes('Endpoint is required for the void channel'));

      const rows = dbRecent(env);
      assert.equal(rows.length, 0);
    });
  });
});

// -- failed channel --

describe('c4-send failed channel', () => {
  it('reports failure when channel script exits non-zero', () => {
    withTmpDir(({ tmpDir, env }) => {
      const skillDir = path.join(tmpDir, '.claude', 'skills', 'bad-channel', 'scripts');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'send.js'), 'process.exit(1);');

      const { stdout, status } = cli(['bad-channel'], env, 'Hello');
      assert.equal(status, 1);
      assert.ok(stdout.includes('Failed to send'));
    });
  });

  it('keeps the persisted delivery identity when the adapter reports failure', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupDeliveryIdentityChannel(tmpDir, 'bad-identity-channel', {
        exitCode: 1,
      });

      const { status } = cli(['bad-identity-channel'], env, 'Retry me');
      assert.equal(status, 1);

      const [outbound] = dbRecent(env, 1);
      const delivered = JSON.parse(fs.readFileSync(sentFile, 'utf8'));
      assert.equal(delivered.deliveryId, `c4.outbound.${outbound.id}`);
    });
  });
});
