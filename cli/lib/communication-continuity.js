/**
 * Hermetic C4 communication-path canary.
 *
 * Runs the deployed c4-send and c4-receive executables against local temporary
 * state, so an upgrade can prove outbound body contracts, inbound durable
 * persistence, and the deployment's exact legacy argv policy without sending
 * anything to a real external channel.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const POLICY_FLAGS = ['C4_STRICT_STDIN_ONLY', 'C4_LEGACY_ARG_MODE'];
const WORK_INTAKE_ENV_KEYS = Object.freeze([
  'ZYLOS_AGENT_ID',
  'ZYLOS_AGENT_PROFILE',
  'ZYLOS_AGENT_LABEL',
  'ZYLOS_AGENT_ALIASES',
  'C4_WORK_INTAKE_DEFAULT_ASSIGNEE_ID',
]);
export const COMMUNICATION_CRITICAL_ASSETS = Object.freeze([
  'comm-bridge/scripts/c4-send.js',
  'comm-bridge/scripts/c4-receive.js',
  'comm-bridge/scripts/c4-dispatcher.js',
  'comm-bridge/scripts/c4-response-stream-supervisor.js',
  'activity-monitor/scripts/assistant-turn-binding.js',
]);
const STRICT_ARG_REJECTIONS = new Set([
  '[c4-send] arg-mode disabled: pass the message via stdin/heredoc, not as a CLI argument.',
  '[c4-send] arg-mode disabled by strict stdin-only policy: pass the message via stdin/heredoc.',
]);

function readSelectedEnv(zylosDir, names, fsApi) {
  const values = {};
  let fileValues = {};

  try {
    const content = fsApi.readFileSync(path.join(zylosDir, '.env'), 'utf8');
    fileValues = Object.fromEntries(content.split('\n').flatMap((rawLine) => {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) return [];
      const match = line.match(/^([A-Z0-9_]+)\s*=\s*(.+)$/);
      if (!match) return [];
      return [[match[1], match[2].trim().replace(/^(['"])(.*)\1$/, '$2')]];
    }));
  } catch {
    // An absent policy file means the compatibility default applies.
  }

  for (const name of names) {
    if (process.env[name] !== undefined) values[name] = process.env[name];
    else if (fileValues[name] !== undefined) values[name] = fileValues[name];
  }
  return values;
}

function readPolicyFlags(zylosDir, fsApi) {
  return readSelectedEnv(zylosDir, POLICY_FLAGS, fsApi);
}

function expectedWorkIntakeAssignee(env) {
  const explicit = String(env.C4_WORK_INTAKE_DEFAULT_ASSIGNEE_ID || '').trim();
  if (explicit) return explicit;
  const agentId = String(env.ZYLOS_AGENT_ID || '').trim();
  if (agentId) return agentId;
  const profile = String(env.ZYLOS_AGENT_PROFILE || '').trim();
  return profile ? `agent:${profile}` : null;
}

function childEnvWithSelection(baseEnv, selectedEnv) {
  const result = { ...baseEnv };
  for (const name of WORK_INTAKE_ENV_KEYS) delete result[name];
  return { ...result, ...selectedEnv };
}

function failureDetail(result) {
  if (result.error) return result.error.message;
  const stderr = String(result.stderr || '').trim().split('\n').find(Boolean);
  return stderr || `exited ${result.status}`;
}

function readDeliveredArgs(outputPath, fsApi) {
  try {
    return JSON.parse(fsApi.readFileSync(outputPath, 'utf8'));
  } catch {
    return null;
  }
}

function parseLastJsonValue(output) {
  const text = String(output || '').trim();
  try {
    return JSON.parse(text);
  } catch {
    // Continue: C4 may prefix one or more diagnostic lines.
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {
      // Some C4 CLIs emit content-free initialization diagnostics first.
    }
  }

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '[' && text[index] !== '{') continue;
    try {
      return JSON.parse(text.slice(index));
    } catch {
      // Try the next possible JSON boundary.
    }
  }
  return null;
}

/**
 * Verify the package or deployed Skills tree contains every communication
 * entrypoint that must survive a rolling upgrade.
 */
export function verifyCommunicationAssets({ skillsDir, fsApi = fs } = {}) {
  const checked = [];
  const missing = [];

  for (const relativePath of COMMUNICATION_CRITICAL_ASSETS) {
    const filePath = path.join(skillsDir || '', relativePath);
    let regularFile = false;
    try {
      regularFile = fsApi.statSync(filePath).isFile();
    } catch {
      regularFile = false;
    }
    checked.push(relativePath);
    if (!regularFile) missing.push(relativePath);
  }

  return {
    compatible: missing.length === 0,
    checked,
    missing,
    ...(missing.length > 0 ? {
      error: `Critical communication asset missing or not a regular file: ${missing.join(', ')}`,
    } : {}),
  };
}

function isStrictArgPolicyRejection(result) {
  if (!Number.isInteger(result.status) || result.status === 0) return false;
  const firstLine = String(result.stderr || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return STRICT_ARG_REJECTIONS.has(firstLine);
}

/**
 * Verify the active c4-send reply policy. Compatibility mode must preserve
 * argv delivery. Explicit strict mode must preserve stdin and body-file
 * delivery while returning the known policy rejection for argv bodies.
 * Returns structured, content-free diagnostics suitable for upgrade output.
 */
export function verifyCommunicationContinuity({
  c4SendPath,
  c4ReceivePath = path.join(path.dirname(c4SendPath || ''), 'c4-receive.js'),
  c4DbPath = path.join(path.dirname(c4SendPath || ''), 'c4-db.js'),
  zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'),
  fsApi = fs,
  spawnSyncFn = spawnSync,
  spawnInboundSyncFn = spawnSync,
  workIntakeEnv = null,
} = {}) {
  const checks = [];
  const canaryRoot = fsApi.mkdtempSync(path.join(os.tmpdir(), 'zylos-c4-continuity-'));
  const outputPath = path.join(canaryRoot, 'delivered.json');
  const bodyFilePath = path.join(canaryRoot, 'body.txt');
  const channel = 'continuity-canary';
  const endpoint = 'local-loopback';
  const channelDir = path.join(canaryRoot, '.claude', 'skills', channel, 'scripts');
  const policyEnv = readPolicyFlags(zylosDir, fsApi);
  const selectedWorkIntakeEnv = workIntakeEnv
    ?? readSelectedEnv(zylosDir, WORK_INTAKE_ENV_KEYS, fsApi);
  const strictPolicy = policyEnv.C4_STRICT_STDIN_ONLY === '1'
    && policyEnv.C4_LEGACY_ARG_MODE !== '1';

  try {
    fsApi.mkdirSync(channelDir, { recursive: true });
    fsApi.mkdirSync(path.join(canaryRoot, '.claude', 'skills', 'feishu'), { recursive: true });
    fsApi.writeFileSync(path.join(channelDir, 'send.js'), [
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.C4_CANARY_OUTPUT, JSON.stringify(process.argv.slice(2)));",
    ].join('\n'));

    const bodyFileCanary = 'body-file canary with "quotes" and $vars';
    fsApi.writeFileSync(bodyFilePath, bodyFileCanary);

    const cases = [
      {
        name: 'stdin_reply',
        args: [channel, endpoint],
        input: 'stdin canary with "quotes" and $vars',
        expected: 'delivery',
      },
      ...(strictPolicy ? [{
        name: 'body_file_reply',
        args: [channel, endpoint, `--body-file=${bodyFilePath}`],
        body: bodyFileCanary,
        expected: 'delivery',
      }] : []),
      {
        name: 'legacy_argv_reply',
        args: [channel, endpoint, 'legacy canary with "quotes" and $vars'],
        expected: strictPolicy ? 'strict_rejection' : 'delivery',
        mode: strictPolicy ? 'strict_rejection' : 'compatibility',
      },
    ];

    for (const check of cases) {
      fsApi.rmSync(outputPath, { force: true });
      const expectedBody = check.input ?? check.body ?? check.args[2];
      const result = spawnSyncFn(process.execPath, [c4SendPath, ...check.args], {
        encoding: 'utf8',
        timeout: 10000,
        ...(check.input === undefined ? {} : { input: check.input }),
        env: {
          ...process.env,
          ...policyEnv,
          ZYLOS_DIR: canaryRoot,
          C4_CANARY_OUTPUT: outputPath,
        },
      });
      const delivered = readDeliveredArgs(outputPath, fsApi);
      const deliveryAttempted = fsApi.existsSync(outputPath);
      const passed = check.expected === 'strict_rejection'
        ? isStrictArgPolicyRejection(result) && !deliveryAttempted
        : result.status === 0
          && Array.isArray(delivered)
          && delivered[0] === endpoint
          && delivered[1] === expectedBody;
      const error = check.expected === 'strict_rejection' && deliveryAttempted
        ? 'strict policy rejection still produced a delivery'
        : failureDetail(result);

      checks.push({
        name: check.name,
        status: passed ? 'passed' : 'failed',
        ...(check.mode ? { mode: check.mode } : {}),
        ...(passed ? {} : { error }),
      });
    }

    if (!fsApi.existsSync(c4ReceivePath)) {
      checks.push({
        name: 'inbound_receive',
        status: 'failed',
        error: `receive entrypoint not found: ${c4ReceivePath}`,
      });
    } else if (!fsApi.existsSync(c4DbPath)) {
      checks.push({
        name: 'inbound_receive',
        status: 'failed',
        error: `database observer not found: ${c4DbPath}`,
      });
    } else {
      const inboundBody = 'local inbound continuity canary';
      const receiveResult = spawnInboundSyncFn(process.execPath, [
        c4ReceivePath,
        '--channel', 'system',
        '--no-reply',
        '--priority', '3',
        '--json',
        '--content', inboundBody,
      ], {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          ZYLOS_DIR: canaryRoot,
        },
      });
      const receipt = parseLastJsonValue(receiveResult.stdout);
      const receivePassed = receiveResult.status === 0
        && receipt?.ok === true
        && Number.isInteger(receipt.id)
        && ['queued', 'delivered'].includes(receipt.action);
      checks.push({
        name: 'inbound_receive',
        status: receivePassed ? 'passed' : 'failed',
        ...(receivePassed ? {} : { error: failureDetail(receiveResult) }),
      });

      if (receivePassed) {
        const observeResult = spawnInboundSyncFn(process.execPath, [c4DbPath, 'recent', '1'], {
          encoding: 'utf8',
          timeout: 10000,
          env: {
            ...process.env,
            ZYLOS_DIR: canaryRoot,
          },
        });
        const rows = parseLastJsonValue(observeResult.stdout);
        const row = Array.isArray(rows) ? rows.at(-1) : null;
        const persistencePassed = observeResult.status === 0
          && row?.id === receipt.id
          && row?.direction === 'in'
          && row?.channel === 'system'
          && row?.content === inboundBody
          && ['pending', 'delivered'].includes(row?.status);
        checks.push({
          name: 'inbound_persistence',
          status: persistencePassed ? 'passed' : 'failed',
          ...(persistencePassed ? {} : { error: failureDetail(observeResult) }),
        });
      }

      const expectedAssigneeId = expectedWorkIntakeAssignee(selectedWorkIntakeEnv);
      if (!expectedAssigneeId) {
        checks.push({
          name: 'work_intake_default_assignee',
          status: 'failed',
          error: 'managed deployment requires ZYLOS_AGENT_ID or ZYLOS_AGENT_PROFILE',
        });
      } else {
        const messageId = 'om_work_intake_continuity';
        const idempotencyKey = `feishu:${messageId}:work-intake:r1`;
        const envelope = {
          source: {
            channel: 'feishu',
            messageId,
            conversationId: 'oc_work_intake_continuity',
            conversationType: 'direct',
            threadId: null,
          },
          sender: { id: 'ou_continuity_human', kind: 'human' },
          text: '明天 18:00 前完成升级后通信检查',
          intentRevision: 1,
          receivedAt: new Date().toISOString(),
          timeZone: 'Asia/Shanghai',
          people: [],
        };
        const intakeResult = spawnInboundSyncFn(process.execPath, [
          c4ReceivePath,
          '--channel', 'feishu',
          '--endpoint', `${envelope.source.conversationId}|type:p2p|msg:${messageId}`,
          '--json',
          '--work-intake-envelope-json', JSON.stringify(envelope),
          '--content', `[Feishu DM] Continuity canary said: ${envelope.text}`,
        ], {
          encoding: 'utf8',
          timeout: 10000,
          env: childEnvWithSelection({
            ...process.env,
            ZYLOS_DIR: canaryRoot,
          }, selectedWorkIntakeEnv),
        });
        const intakeReceipt = parseLastJsonValue(intakeResult.stdout);
        let intakeRow = null;
        let observerResult = null;
        if (intakeResult.status === 0 && intakeReceipt?.workIntake?.decision === 'create_task') {
          const observerExpression = [
            `const { openCommitmentIntakeQueue } = await import(${JSON.stringify(pathToFileURL(c4DbPath).href)});`,
            `const queue = openCommitmentIntakeQueue({ dbPath: ${JSON.stringify(path.join(canaryRoot, 'comm-bridge', 'c4.db'))} });`,
            'try {',
            `process.stdout.write(JSON.stringify(queue.get({ idempotencyKey: ${JSON.stringify(idempotencyKey)} })));`,
            '} finally { queue.close(); }',
          ].join('');
          observerResult = spawnInboundSyncFn(process.execPath, [
            '--input-type=module', '--eval', observerExpression,
          ], {
            encoding: 'utf8',
            timeout: 10000,
            env: childEnvWithSelection(process.env, selectedWorkIntakeEnv),
          });
          intakeRow = parseLastJsonValue(observerResult.stdout);
        }
        const actualAssigneeId = intakeRow?.envelope?.task?.assigneeId ?? null;
        const intakePassed = intakeResult.status === 0
          && intakeReceipt?.workIntake?.decision === 'create_task'
          && observerResult?.status === 0
          && actualAssigneeId === expectedAssigneeId;
        const intakeError = intakeResult.status !== 0
          ? failureDetail(intakeResult)
          : intakeReceipt?.workIntake?.decision !== 'create_task'
            ? 'canary message did not create a task'
            : observerResult?.status !== 0
              ? failureDetail(observerResult || {})
              : `expected default assignee ${expectedAssigneeId}, found ${actualAssigneeId ?? 'missing'}`;
        checks.push({
          name: 'work_intake_default_assignee',
          status: intakePassed ? 'passed' : 'failed',
          ...(intakePassed ? {} : { error: intakeError }),
        });
      }
    }
  } catch (err) {
    checks.push({ name: 'canary_setup', status: 'failed', error: err.message });
  } finally {
    fsApi.rmSync(canaryRoot, { recursive: true, force: true });
  }

  const failed = checks.find(({ status }) => status === 'failed');
  return {
    compatible: !failed,
    checks,
    ...(failed ? { error: `${failed.name}: ${failed.error}` } : {}),
  };
}
