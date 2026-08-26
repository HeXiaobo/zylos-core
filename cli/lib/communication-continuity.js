/**
 * Hermetic C4 reply-path canary.
 *
 * Runs the deployed c4-send executable against a local temporary channel, so
 * an upgrade can prove the safe body contracts and the deployment's exact
 * legacy argv policy without sending anything to a real external channel.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const POLICY_FLAGS = ['C4_STRICT_STDIN_ONLY', 'C4_LEGACY_ARG_MODE'];
const STRICT_ARG_REJECTIONS = new Set([
  '[c4-send] arg-mode disabled: pass the message via stdin/heredoc, not as a CLI argument.',
  '[c4-send] arg-mode disabled by strict stdin-only policy: pass the message via stdin/heredoc.',
]);

function readPolicyFlags(zylosDir, fsApi) {
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

  for (const name of POLICY_FLAGS) {
    if (process.env[name] !== undefined) values[name] = process.env[name];
    else if (fileValues[name] !== undefined) values[name] = fileValues[name];
  }
  return values;
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
  zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'),
  fsApi = fs,
  spawnSyncFn = spawnSync,
} = {}) {
  const checks = [];
  const canaryRoot = fsApi.mkdtempSync(path.join(os.tmpdir(), 'zylos-c4-continuity-'));
  const outputPath = path.join(canaryRoot, 'delivered.json');
  const bodyFilePath = path.join(canaryRoot, 'body.txt');
  const channel = 'continuity-canary';
  const endpoint = 'local-loopback';
  const channelDir = path.join(canaryRoot, '.claude', 'skills', channel, 'scripts');
  const policyEnv = readPolicyFlags(zylosDir, fsApi);
  const strictPolicy = policyEnv.C4_STRICT_STDIN_ONLY === '1'
    && policyEnv.C4_LEGACY_ARG_MODE !== '1';

  try {
    fsApi.mkdirSync(channelDir, { recursive: true });
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
