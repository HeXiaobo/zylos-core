import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import crypto from 'node:crypto';
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

function setupOutboundPolicy(tmpDir, policy) {
  const policyPath = path.join(tmpDir, '.zylos', 'c4-outbound-policy.json');
  const auditPath = path.join(tmpDir, 'comm-bridge', 'outbound-policy-audit.jsonl');
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, JSON.stringify(policy));
  return { policyPath, auditPath };
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

  it('sends an exact body file under strict stdin-only policy', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');
      const bodyFile = path.join(tmpDir, 'reply-body.txt');
      const body = 'body-file reply with "quotes", $vars, and\nmultiple lines';
      fs.writeFileSync(bodyFile, body);

      const { stderr, status } = cli(
        ['mock-channel', 'endpoint1', `--body-file=${bodyFile}`],
        { ...env, C4_STRICT_STDIN_ONLY: '1' },
      );

      assert.equal(status, 0, stderr);
      const sent = JSON.parse(fs.readFileSync(sentFile, 'utf8'));
      assert.deepEqual(sent, ['endpoint1', body]);
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

  it('rejects configured banned content before DB or adapter delivery and writes a safe audit record', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');
      const { auditPath } = setupOutboundPolicy(tmpDir, {
        version: 1,
        rules: [{ id: 'restricted-marker', contains: 'DO_NOT_SEND' }],
      });

      const { stderr, status } = cli(
        ['mock-channel', 'endpoint1'],
        env,
        'before DO_NOT_SEND after',
      );

      assert.equal(status, 3, stderr);
      assert.match(stderr, /outbound policy/i);
      assert.equal(fs.existsSync(sentFile), false);
      assert.equal(fs.existsSync(path.join(tmpDir, 'comm-bridge', 'c4.db')), false);

      const [audit] = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(audit.event, 'outbound_policy_blocked');
      assert.equal(audit.ruleRefs.length, 1);
      assert.match(audit.ruleRefs[0], /^[a-f0-9]{64}$/);
      assert.equal(audit.bodySha256.length, 64);
      assert.equal(audit.bodyBytes, Buffer.byteLength('before DO_NOT_SEND after', 'utf8'));
      assert.doesNotMatch(JSON.stringify(audit), /DO_NOT_SEND|restricted-marker/);
    });
  });

  it('keeps allowed content unchanged when a configured rule does not match', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');
      setupOutboundPolicy(tmpDir, {
        version: 1,
        rules: [{ id: 'restricted-marker', contains: 'DO_NOT_SEND' }],
      });
      const body = 'safe "quotes", $vars, and\nmultiple lines';

      const { status, stderr } = cli(
        ['mock-channel', 'endpoint1'],
        env,
        body,
      );

      assert.equal(status, 0, stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(sentFile, 'utf8')), ['endpoint1', body]);
      assert.equal(fs.existsSync(path.join(tmpDir, 'comm-bridge', 'outbound-policy-audit.jsonl')), false);
    });
  });

  it('enforces configured policy before rejecting an unknown external channel', () => {
    withTmpDir(({ tmpDir, env }) => {
      const { auditPath } = setupOutboundPolicy(tmpDir, {
        version: 1,
        rules: [{ id: 'restricted-marker', contains: 'DO_NOT_SEND' }],
      });

      const { stderr, status } = cli(
        ['unknown-external-channel', 'endpoint1'],
        env,
        'DO_NOT_SEND',
      );

      assert.equal(status, 3, stderr);
      assert.match(stderr, /outbound policy/i);
      assert.doesNotMatch(stderr, /directory not found/i);
      assert.equal(fs.existsSync(path.join(tmpDir, 'comm-bridge', 'c4.db')), false);
      assert.equal(fs.readFileSync(auditPath, 'utf8').trim().split('\n').length, 1);
    });
  });

  it('reports an unknown external channel after an allowed policy decision', () => {
    withTmpDir(({ tmpDir, env }) => {
      setupOutboundPolicy(tmpDir, {
        version: 1,
        rules: [{ id: 'restricted-marker', contains: 'DO_NOT_SEND' }],
      });

      const { stderr, status } = cli(
        ['unknown-external-channel', 'endpoint1'],
        env,
        'safe content',
      );

      assert.equal(status, 1);
      assert.match(stderr, /directory not found/i);
      assert.doesNotMatch(stderr, /outbound policy rejected/i);
      assert.equal(fs.existsSync(path.join(tmpDir, 'comm-bridge', 'c4.db')), false);
      assert.equal(fs.existsSync(path.join(tmpDir, 'comm-bridge', 'outbound-policy-audit.jsonl')), false);
    });
  });

  it('matches configured Unicode code points without embedding a policy in Core', () => {
    withTmpDir(({ tmpDir, env }) => {
      const { auditPath } = setupOutboundPolicy(tmpDir, {
        version: 1,
        rules: [{ id: 'configured-code-point', codePoints: [0x1F6AB] }],
      });
      const body = `prefix ${String.fromCodePoint(0x1F6AB)} suffix`;

      const { stderr, status } = cli(
        ['unknown-external-channel', 'endpoint1'],
        env,
        body,
      );

      assert.equal(status, 3, stderr);
      assert.match(stderr, /outbound policy/i);
      const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
      assert.equal(audit.ruleRefs.length, 1);
      assert.doesNotMatch(JSON.stringify(audit), /1F6AB|configured-code-point|DO_NOT_SEND/);
    });
  });

  it('fails closed when the managed policy has no rules', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');
      const { auditPath } = setupOutboundPolicy(tmpDir, { version: 1, rules: [] });

      const { stderr, status } = cli(
        ['mock-channel', 'endpoint1'],
        env,
        'safe-looking content',
      );

      assert.equal(status, 3, stderr);
      assert.equal(fs.existsSync(sentFile), false);
      assert.equal(fs.existsSync(path.join(tmpDir, 'comm-bridge', 'c4.db')), false);
      const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
      assert.equal(audit.event, 'outbound_policy_configuration_error');
      assert.equal(audit.errorCode, 'POLICY_SCHEMA_INVALID');
    });
  });

  it('requires the managed policy to declare version 1', () => {
    withTmpDir(({ tmpDir, env }) => {
      const { auditPath } = setupOutboundPolicy(tmpDir, {
        rules: [{ id: 'restricted-marker', contains: 'DO_NOT_SEND' }],
      });

      const { stderr, status } = cli(
        ['mock-channel', 'endpoint1'],
        env,
        'safe-looking content',
      );

      assert.equal(status, 3, stderr);
      const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
      assert.equal(audit.errorCode, 'POLICY_SCHEMA_INVALID');
    });
  });

  it('fails closed when the managed policy contains an unknown field', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');
      const { auditPath } = setupOutboundPolicy(tmpDir, {
        version: 1,
        rules: [{ id: 'restricted-marker', contains: 'DO_NOT_SEND', regex: '.*' }],
      });

      const { stderr, status } = cli(
        ['mock-channel', 'endpoint1'],
        env,
        'safe-looking content',
      );

      assert.equal(status, 3, stderr);
      assert.equal(fs.existsSync(sentFile), false);
      const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
      assert.equal(audit.errorCode, 'POLICY_SCHEMA_INVALID');
      assert.doesNotMatch(JSON.stringify(audit), /regex|safe-looking content/);
    });
  });

  it('fails closed when the managed policy repeats a rule id', () => {
    withTmpDir(({ tmpDir, env }) => {
      const { auditPath } = setupOutboundPolicy(tmpDir, {
        version: 1,
        rules: [
          { id: 'same-rule', contains: 'one' },
          { id: 'same-rule', contains: 'two' },
        ],
      });

      const { stderr, status } = cli(
        ['mock-channel', 'endpoint1'],
        env,
        'safe-looking content',
      );

      assert.equal(status, 3, stderr);
      const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
      assert.equal(audit.errorCode, 'POLICY_SCHEMA_INVALID');
    });
  });

  it('fails closed when the managed policy contains an invalid Unicode code point', () => {
    withTmpDir(({ tmpDir, env }) => {
      const { auditPath } = setupOutboundPolicy(tmpDir, {
        version: 1,
        rules: [{ id: 'invalid-code-point', codePoints: [0xD800] }],
      });

      const { stderr, status } = cli(
        ['mock-channel', 'endpoint1'],
        env,
        'safe-looking content',
      );

      assert.equal(status, 3, stderr);
      const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
      assert.equal(audit.errorCode, 'POLICY_SCHEMA_INVALID');
    });
  });

  it('audits UTF-8 bytes and hashes without exposing an emoji/CJK body or rule value', () => {
    withTmpDir(({ tmpDir, env }) => {
      const body = '中文🚫 TOP_SECRET';
      const { auditPath } = setupOutboundPolicy(tmpDir, {
        version: 1,
        rules: [{ id: 'confidential-ref', contains: 'TOP_SECRET' }],
      });

      const { stderr, status } = cli(
        ['mock-channel', 'endpoint1'],
        env,
        body,
      );

      assert.equal(status, 3, stderr);
      const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
      assert.equal(audit.bodyBytes, Buffer.byteLength(body, 'utf8'));
      assert.equal(audit.bodySha256, crypto.createHash('sha256').update(body).digest('hex'));
      assert.doesNotMatch(JSON.stringify(audit), /中文|TOP_SECRET|confidential-ref/);
    });
  });

  it('fails closed when a configured literal exceeds its size bound', () => {
    withTmpDir(({ tmpDir, env }) => {
      const { auditPath } = setupOutboundPolicy(tmpDir, {
        version: 1,
        rules: [{ id: 'oversized-literal', contains: 'x'.repeat(4097) }],
      });

      const { stderr, status } = cli(
        ['mock-channel', 'endpoint1'],
        env,
        'safe-looking content',
      );

      assert.equal(status, 3, stderr);
      const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
      assert.equal(audit.errorCode, 'POLICY_SCHEMA_INVALID');
      assert.doesNotMatch(JSON.stringify(audit), /oversized-literal/);
    });
  });

  it('fails closed when the configured policy contains too many rules', () => {
    withTmpDir(({ tmpDir, env }) => {
      const { auditPath } = setupOutboundPolicy(tmpDir, {
        version: 1,
        rules: Array.from({ length: 257 }, (_, index) => ({
          id: `rule-${index + 1}`,
          contains: `marker-${index + 1}`,
        })),
      });

      const { stderr, status } = cli(
        ['mock-channel', 'endpoint1'],
        env,
        'safe-looking content',
      );

      assert.equal(status, 3, stderr);
      const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
      assert.equal(audit.errorCode, 'POLICY_SCHEMA_INVALID');
    });
  });

  it('fails closed and records metadata when an outbound body exceeds the policy bound', () => {
    withTmpDir(({ tmpDir, env }) => {
      const { auditPath } = setupOutboundPolicy(tmpDir, {
        version: 1,
        rules: [{ id: 'restricted-marker', contains: 'never-match' }],
      });
      const body = 'x'.repeat(4 * 1024 * 1024 + 1);

      const { stderr, status } = cli(['mock-channel', 'endpoint1'], env, body);

      assert.equal(status, 3, stderr);
      assert.equal(fs.existsSync(path.join(tmpDir, 'comm-bridge', 'c4.db')), false);
      const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
      assert.equal(audit.event, 'outbound_policy_configuration_error');
      assert.equal(audit.errorCode, 'MESSAGE_TOO_LARGE');
      assert.equal(audit.bodyBytes, Buffer.byteLength(body, 'utf8'));
    });
  });

  it('fails closed when the managed policy path is a symbolic link', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');
      const policyPath = path.join(tmpDir, '.zylos', 'c4-outbound-policy.json');
      const realPolicyPath = path.join(tmpDir, 'real-policy.json');
      const auditPath = path.join(tmpDir, 'comm-bridge', 'outbound-policy-audit.jsonl');
      fs.mkdirSync(path.dirname(policyPath), { recursive: true });
      fs.writeFileSync(realPolicyPath, JSON.stringify({
        version: 1,
        rules: [{ id: 'restricted-marker', contains: 'DO_NOT_SEND' }],
      }));
      fs.symlinkSync(realPolicyPath, policyPath);

      const { stderr, status } = cli(['mock-channel', 'endpoint1'], env, 'safe content');

      assert.equal(status, 3, stderr);
      assert.equal(fs.existsSync(sentFile), false);
      assert.equal(fs.existsSync(path.join(tmpDir, 'comm-bridge', 'c4.db')), false);
      const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
      assert.equal(audit.errorCode, 'POLICY_FILE_UNAVAILABLE');
    });
  });

  it('fails closed when the managed policy is writable by other users', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');
      const { policyPath, auditPath } = setupOutboundPolicy(tmpDir, {
        version: 1,
        rules: [{ id: 'restricted-marker', contains: 'DO_NOT_SEND' }],
      });
      fs.chmodSync(policyPath, 0o666);

      const { stderr, status } = cli(['mock-channel', 'endpoint1'], env, 'safe content');

      assert.equal(status, 3, stderr);
      assert.equal(fs.existsSync(sentFile), false);
      const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
      assert.equal(audit.errorCode, 'POLICY_FILE_UNAVAILABLE');
    });
  });

  it('fails closed when the audit destination is a symbolic link', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');
      setupOutboundPolicy(tmpDir, {
        version: 1,
        rules: [{ id: 'restricted-marker', contains: 'DO_NOT_SEND' }],
      });
      const auditPath = path.join(tmpDir, 'comm-bridge', 'outbound-policy-audit.jsonl');
      const realAuditPath = path.join(tmpDir, 'real-audit.jsonl');
      fs.mkdirSync(path.dirname(auditPath), { recursive: true });
      fs.writeFileSync(realAuditPath, '');
      fs.symlinkSync(realAuditPath, auditPath);

      const { stderr, status } = cli(['mock-channel', 'endpoint1'], env, 'DO_NOT_SEND');

      assert.equal(status, 3, stderr);
      assert.match(stderr, /audit is unavailable|outbound policy/i);
      assert.equal(fs.existsSync(sentFile), false);
      assert.equal(fs.existsSync(path.join(tmpDir, 'comm-bridge', 'c4.db')), false);
      assert.equal(fs.readFileSync(realAuditPath, 'utf8'), '');
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

  it('rejects endpoint message arg-mode unconditionally with exit 2', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');

      const { stderr, status } = cli(['mock-channel', 'endpoint1', 'unsafe $message'], env);

      assert.equal(status, 2);
      assert.match(stderr, /arg-mode disabled/i);
      assert.doesNotMatch(stderr, /unsafe \$message/);
      assert.equal(fs.existsSync(sentFile), false);
    });
  });

  it('does not let the explicit legacy flag re-enable argv message mode', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');

      const { stderr, status } = cli(
        ['mock-channel', 'endpoint1', 'legacy message with $vars'],
        { ...env, C4_LEGACY_ARG_MODE: '1' },
      );

      assert.equal(status, 2);
      assert.match(stderr, /arg-mode disabled/i);
      assert.doesNotMatch(stderr, /legacy message with \$vars/);
      assert.equal(fs.existsSync(sentFile), false);
    });
  });

  it('rejects endpoint message arg-mode under strict stdin-only policy', () => {
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

  it('does not let the break-glass flag override strict stdin-only policy', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');

      const { stderr, status } = cli(
        ['mock-channel', 'endpoint1', 'recovery message'],
        { ...env, C4_STRICT_STDIN_ONLY: '1', C4_LEGACY_ARG_MODE: '1' },
      );

      assert.equal(status, 2);
      assert.match(stderr, /arg-mode disabled/i);
      assert.equal(fs.existsSync(sentFile), false);
    });
  });

  it('reads the legacy break-glass config without permitting argv message mode', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');
      fs.writeFileSync(path.join(tmpDir, '.env'), 'C4_LEGACY_ARG_MODE=1\n');

      const { stderr, status } = cli(
        ['mock-channel', 'endpoint1', 'legacy after upgrade'],
        env,
      );

      assert.equal(status, 2);
      assert.match(stderr, /arg-mode disabled/i);
      assert.equal(fs.existsSync(sentFile), false);
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

  it('deliberately rejects --allow-banned instead of providing an un-audited bypass', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');
      const { auditPath } = setupOutboundPolicy(tmpDir, {
        version: 1,
        rules: [{ id: 'restricted-marker', contains: 'DO_NOT_SEND' }],
      });

      const { stderr, status } = cli(
        ['mock-channel', 'endpoint1', '--allow-banned'],
        env,
        'DO_NOT_SEND',
      );

      assert.equal(status, 1);
      assert.match(stderr, /--allow-banned is deliberately unsupported/i);
      assert.equal(fs.existsSync(sentFile), false);
      assert.equal(fs.existsSync(path.join(tmpDir, 'comm-bridge', 'c4.db')), false);
      assert.equal(fs.existsSync(auditPath), false);
    });
  });

  it('rejects --allow-banned variants instead of interpreting them as a bypass', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');
      const { auditPath } = setupOutboundPolicy(tmpDir, {
        version: 1,
        rules: [{ id: 'restricted-marker', contains: 'DO_NOT_SEND' }],
      });

      for (const option of ['--allow-banned=true', '--allow-banned=1']) {
        const { stderr, status } = cli(
          ['mock-channel', 'endpoint1', option],
          env,
          'DO_NOT_SEND',
        );
        assert.equal(status, 1, `${option}: ${stderr}`);
        assert.match(stderr, /--allow-banned is deliberately unsupported/i);
      }

      assert.equal(fs.existsSync(sentFile), false);
      assert.equal(fs.existsSync(auditPath), false);
    });
  });

  it('ignores policy and audit path environment overrides so they cannot bypass the managed seam', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');
      const { auditPath } = setupOutboundPolicy(tmpDir, {
        version: 1,
        rules: [{ id: 'restricted-marker', contains: 'DO_NOT_SEND' }],
      });

      const { stderr, status } = cli(
        ['mock-channel', 'endpoint1'],
        {
          ...env,
          C4_OUTBOUND_POLICY_FILE: '/dev/null',
          C4_OUTBOUND_POLICY_AUDIT: '/dev/null',
          C4_ALLOW_BANNED: '1',
          C4_OUTBOUND_POLICY_ALLOW_BANNED: '1',
        },
        'DO_NOT_SEND',
      );

      assert.equal(status, 3, stderr);
      assert.equal(fs.existsSync(sentFile), false);
      assert.equal(fs.existsSync(path.join(tmpDir, 'comm-bridge', 'c4.db')), false);
      assert.equal(fs.readFileSync(auditPath, 'utf8').trim().split('\n').length, 1);
    });
  });

  it('fails closed and audits when the managed policy cannot be loaded', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');
      const policyPath = path.join(tmpDir, '.zylos', 'c4-outbound-policy.json');
      const auditPath = path.join(tmpDir, 'comm-bridge', 'outbound-policy-audit.jsonl');
      fs.mkdirSync(path.dirname(policyPath), { recursive: true });
      fs.writeFileSync(policyPath, '{invalid json');

      const { stderr, status } = cli(
        ['mock-channel', 'endpoint1'],
        env,
        'safe-looking content',
      );

      assert.equal(status, 3, stderr);
      assert.match(stderr, /outbound policy/i);
      assert.equal(fs.existsSync(sentFile), false);
      assert.equal(fs.existsSync(path.join(tmpDir, 'comm-bridge', 'c4.db')), false);
      const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
      assert.equal(audit.event, 'outbound_policy_configuration_error');
      assert.equal(audit.errorCode, 'POLICY_FILE_INVALID');
      assert.doesNotMatch(JSON.stringify(audit), /safe-looking content/);
    });
  });

  it('rejects an unreadable body file before dispatch without falling back to stdin', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');

      const { stderr, status } = cli([
        'mock-channel',
        'endpoint1',
        `--body-file=${path.join(tmpDir, 'missing.txt')}`,
      ], env);

      assert.equal(status, 1);
      assert.match(stderr, /Unable to read body file/);
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

  it('keeps internal void records outside the external content policy', () => {
    withTmpDir(({ tmpDir, env }) => {
      setupOutboundPolicy(tmpDir, {
        version: 1,
        rules: [{ id: 'restricted-marker', contains: 'DO_NOT_SEND' }],
      });

      const { stdout, status } = cli(['void', 'session-handoff'], env, 'DO_NOT_SEND');
      assert.equal(status, 0);
      assert.ok(stdout.includes('recorded on void channel'));

      const rows = dbRecent(env);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].channel, 'void');
      assert.equal(rows[0].content, 'DO_NOT_SEND');
      assert.equal(fs.existsSync(path.join(tmpDir, 'comm-bridge', 'outbound-policy-audit.jsonl')), false);
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
