import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = path.join(ROOT, 'cli', 'zylos.js');
const SOURCE_TASK_CORE = path.join(ROOT, 'skills', 'commitment-core');

function installedTaskCore(zylosDir) {
  return path.join(zylosDir, '.claude', 'skills', 'commitment-core');
}

function installTaskCore(zylosDir) {
  const destination = installedTaskCore(zylosDir);
  mkdirSync(path.join(destination, 'scripts'), { recursive: true });
  copyFileSync(path.join(SOURCE_TASK_CORE, 'package.json'), path.join(destination, 'package.json'));
  copyFileSync(
    path.join(SOURCE_TASK_CORE, 'scripts', 'core.js'),
    path.join(destination, 'scripts', 'core.js'),
  );
  symlinkSync(
    path.join(SOURCE_TASK_CORE, 'node_modules'),
    path.join(destination, 'node_modules'),
    'dir',
  );
}

function runTask(zylosDir, args, env = {}) {
  return spawnSync(process.execPath, [CLI, 'task', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ZYLOS_DIR: zylosDir, NO_COLOR: '1', ...env },
  });
}

function json(result) {
  assert.doesNotThrow(() => JSON.parse(result.stdout), result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('zylos task completes create through acceptance and filters the resulting task', () => {
  const zylosDir = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-cli-'));

  try {
    installTaskCore(zylosDir);
    const createdResult = runTask(zylosDir, [
      'create',
      '--title', '完成 CRM 回访',
      '--description', '整理客户反馈并提交验收',
      '--owner', 'owner-1',
      '--acceptor', 'acceptor-1',
      '--assignee', 'agent-1',
      '--json',
    ]);
    assert.equal(createdResult.status, 0, createdResult.stderr);
    const created = json(createdResult);
    assert.equal(created.created, true);
    assert.equal(created.task.state, 'ready');
    const taskId = created.task.id;

    const startedResult = runTask(zylosDir, [
      'start', taskId, '--actor', 'agent-1', '--expected-version', '1', '--json',
    ]);
    assert.equal(startedResult.status, 0, startedResult.stderr);
    assert.equal(json(startedResult).task.state, 'in_progress');

    const submittedResult = runTask(zylosDir, [
      'submit', taskId, '--actor', 'agent-1', '--expected-version', '2', '--json',
    ]);
    assert.equal(submittedResult.status, 0, submittedResult.stderr);
    assert.equal(json(submittedResult).task.state, 'review');

    const acceptedResult = runTask(zylosDir, [
      'accept', taskId, '--actor', 'acceptor-1', '--expected-version', '3', '--json',
    ]);
    assert.equal(acceptedResult.status, 0, acceptedResult.stderr);
    assert.equal(json(acceptedResult).task.state, 'done');

    const shownResult = runTask(zylosDir, ['show', taskId, '--events', '--json']);
    assert.equal(shownResult.status, 0, shownResult.stderr);
    assert.deepEqual(
      json(shownResult).events.map((event) => event.type),
      ['TaskCreated', 'TaskStarted', 'TaskSubmittedForReview', 'TaskAccepted'],
    );

    const listedResult = runTask(zylosDir, [
      'list', '--state', 'done', '--owner', 'owner-1', '--assignee', 'agent-1', '--json',
    ]);
    assert.equal(listedResult.status, 0, listedResult.stderr);
    assert.deepEqual(json(listedResult).map((task) => task.id), [taskId]);

    const reopenedResult = runTask(zylosDir, [
      'reopen', taskId, '--actor', 'owner-1', '--expected-version', '4', '--json',
    ]);
    assert.equal(reopenedResult.status, 0, reopenedResult.stderr);
    assert.equal(json(reopenedResult).task.state, 'ready');

    assert.equal(json(runTask(zylosDir, [
      'start', taskId, '--actor', 'agent-1', '--expected-version', '5', '--json',
    ])).task.state, 'in_progress');
    assert.equal(json(runTask(zylosDir, [
      'submit', taskId, '--actor', 'agent-1', '--expected-version', '6', '--json',
    ])).task.state, 'review');
    assert.equal(json(runTask(zylosDir, [
      'rework', taskId, '--actor', 'acceptor-1', '--expected-version', '7', '--json',
    ])).task.state, 'ready');
    assert.equal(json(runTask(zylosDir, [
      'cancel', taskId, '--actor', 'owner-1', '--expected-version', '8', '--json',
    ])).task.state, 'cancelled');
  } finally {
    rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('zylos task returns structured errors and non-zero process exits', () => {
  const zylosDir = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-cli-errors-'));

  try {
    installTaskCore(zylosDir);
    const missingOwner = runTask(zylosDir, [
      'create', '--title', '缺 owner', '--json',
    ]);
    assert.equal(missingOwner.status, 2);
    assert.equal(json(missingOwner).error.code, 'INVALID_ARGUMENT');

    const created = json(runTask(zylosDir, [
      'create', '--title', '版本冲突任务', '--owner', 'owner-1',
      '--assignee', 'agent-1', '--json',
    ])).task;
    const missingActor = runTask(zylosDir, [
      'start', created.id, '--expected-version', '1', '--json',
    ]);
    assert.equal(missingActor.status, 2);
    assert.equal(json(missingActor).error.code, 'INVALID_ARGUMENT');

    const stale = runTask(zylosDir, [
      'start', created.id, '--actor', 'agent-1', '--expected-version', '9', '--json',
    ]);
    assert.equal(stale.status, 1);
    assert.equal(json(stale).error.code, 'VERSION_CONFLICT');

    const sameTitleA = json(runTask(zylosDir, [
      'create', '--title', '同名任务', '--owner', 'owner-1', '--json',
    ])).task;
    const sameTitleB = json(runTask(zylosDir, [
      'create', '--title', '同名任务', '--owner', 'owner-1', '--json',
    ])).task;
    assert.notEqual(sameTitleA.id, sameTitleB.id);

    const unknown = runTask(zylosDir, ['unknown', '--json']);
    assert.equal(unknown.status, 2);
    assert.equal(json(unknown).error.code, 'INVALID_ARGUMENT');
  } finally {
    rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('root help advertises task without statically importing Commitment Core', () => {
  const result = spawnSync(process.execPath, [CLI, 'help'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ZYLOS_TASK_CORE_SOURCE: 'installed' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /task\s+Manage local commitments and tasks/);
  assert.doesNotMatch(
    readFileSync(CLI, 'utf8'),
    /^import .*commands\/task\.js/m,
    'root CLI must lazy-load the task command',
  );
});

test('zylos task prefers the deployed Skill and reports a missing install actionably', () => {
  const zylosDir = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-cli-layout-'));

  try {
    const help = runTask(
      zylosDir,
      ['--help'],
      { ZYLOS_TASK_CORE_SOURCE: 'installed' },
    );
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage: zylos task/);

    const missing = runTask(
      zylosDir,
      ['list', '--json'],
      { ZYLOS_TASK_CORE_SOURCE: 'installed' },
    );
    assert.equal(missing.status, 1);
    assert.equal(json(missing).error.code, 'TASK_CORE_NOT_INSTALLED');
    assert.match(json(missing).error.message, /zylos init.*zylos upgrade --self/);

    const destination = installedTaskCore(zylosDir);
    mkdirSync(path.join(destination, 'scripts'), { recursive: true });
    writeFileSync(path.join(destination, 'package.json'), '{"type":"module"}\n');
    writeFileSync(path.join(destination, 'scripts', 'core.js'), `
      export function openCommitmentCore() {
        return {
          query() { return [{ id: 'from-installed-skill' }]; },
          close() {},
        };
      }
    `);

    const installed = runTask(zylosDir, ['list', '--json']);
    assert.equal(installed.status, 0, installed.stderr);
    assert.deepEqual(json(installed), [{ id: 'from-installed-skill' }]);
  } finally {
    rmSync(zylosDir, { recursive: true, force: true });
  }
});
