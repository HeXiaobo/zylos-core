import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-lifecycle-'));
process.env.ZYLOS_DIR = path.join(root, 'zylos');

const { runUpgrade } = await import(new URL('../upgrade.js', import.meta.url));

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function writeSkill(dir, { version, payload, lifecycle = '' }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: demo\nversion: ${version}\n${lifecycle}---\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'payload.txt'), `${payload}\n`, 'utf8');
}

test('a failing target pre-upgrade hook leaves installed files and service untouched', () => {
  const skillDir = path.join(process.env.ZYLOS_DIR, '.claude', 'skills', 'demo');
  const targetDir = path.join(root, 'target-pre-failure');
  const hookMarker = path.join(root, 'pre-hook-ran');
  const pm2Marker = path.join(root, 'pm2-was-called');
  const fakeBin = path.join(root, 'fake-bin');
  const dataDir = path.join(process.env.ZYLOS_DIR, 'components', 'demo');

  writeSkill(skillDir, { version: '1.0.0', payload: 'old' });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), '{"state":"old"}', 'utf8');
  writeSkill(targetDir, {
    version: '2.0.0',
    payload: 'new',
    lifecycle: 'lifecycle:\n  hooks:\n    pre-upgrade: hooks/pre-upgrade.js\n',
  });
  fs.mkdirSync(path.join(targetDir, 'hooks'), { recursive: true });
  fs.writeFileSync(
    path.join(targetDir, 'hooks', 'pre-upgrade.js'),
    `import fs from 'node:fs';\nimport path from 'node:path';\nfs.writeFileSync(process.env.PRE_HOOK_MARKER, 'ran');\nconst dataDir = path.join(process.env.ZYLOS_DIR, 'components', 'demo');\nfs.writeFileSync(path.join(dataDir, 'config.json'), '{"state":"new"}');\nprocess.exit(42);\n`,
    'utf8',
  );
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, 'pm2'),
    `#!/bin/sh\nprintf called > "${pm2Marker}"\nprintf '[]'\n`,
    { mode: 0o755 },
  );

  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${previousPath}`;
  process.env.PRE_HOOK_MARKER = hookMarker;
  try {
    const result = runUpgrade('demo', {
      tempDir: targetDir,
      newVersion: '2.0.0',
      jsonOutput: true,
    });

    assert.equal(result.success, false);
    assert.equal(result.steps.at(-1).name, 'pre_upgrade_hook');
    assert.match(result.error, /exit code 42/);
    assert.equal(fs.readFileSync(path.join(skillDir, 'payload.txt'), 'utf8'), 'old\n');
    assert.equal(fs.existsSync(hookMarker), true);
    assert.equal(fs.existsSync(pm2Marker), false);
    assert.equal(fs.existsSync(path.join(skillDir, '.backup')), true);
    assert.equal(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'), '{"state":"old"}');
    assert.equal(result.rollback.performed, true);
    assert.deepEqual(result.rollback.steps, [{ action: 'restore_data', success: true }]);
  } finally {
    process.env.PATH = previousPath;
    delete process.env.PRE_HOOK_MARKER;
  }
});

test('a failing post-upgrade hook rolls installed files back to the previous release', () => {
  const skillDir = path.join(process.env.ZYLOS_DIR, '.claude', 'skills', 'demo-post');
  const targetDir = path.join(root, 'target-post-failure');
  const fakeBin = path.join(root, 'fake-bin-post');

  writeSkill(skillDir, { version: '1.0.0', payload: 'old' });
  writeSkill(targetDir, {
    version: '2.0.0',
    payload: 'new',
    lifecycle: 'lifecycle:\n  hooks:\n    post-upgrade: hooks/post-upgrade.js\n',
  });
  fs.mkdirSync(path.join(targetDir, 'hooks'), { recursive: true });
  fs.writeFileSync(
    path.join(targetDir, 'hooks', 'post-upgrade.js'),
    `console.error('post gate rejected');\nprocess.exit(23);\n`,
    'utf8',
  );
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'pm2'), '#!/bin/sh\nprintf \'[]\'\n', { mode: 0o755 });

  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${previousPath}`;
  try {
    const result = runUpgrade('demo-post', {
      tempDir: targetDir,
      newVersion: '2.0.0',
      jsonOutput: true,
    });

    assert.equal(result.success, false);
    assert.equal(result.steps.at(-1).name, 'post_upgrade_hook');
    assert.match(result.error, /post gate rejected/);
    assert.equal(result.rollback.performed, true);
    assert.equal(result.rollback.steps.some(step => step.action === 'restore_files' && step.success), true);
    assert.equal(fs.readFileSync(path.join(skillDir, 'payload.txt'), 'utf8'), 'old\n');
    assert.match(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), /version: 1\.0\.0/);
  } finally {
    process.env.PATH = previousPath;
  }
});

test('post-upgrade rollback restores component data changed by the rejected hook', () => {
  const component = 'demo-data';
  const skillDir = path.join(process.env.ZYLOS_DIR, '.claude', 'skills', component);
  const dataDir = path.join(process.env.ZYLOS_DIR, 'components', component);
  const envFile = path.join(process.env.ZYLOS_DIR, '.env');
  const targetDir = path.join(root, 'target-data-failure');
  const fakeBin = path.join(root, 'fake-bin-data');

  writeSkill(skillDir, { version: '1.0.0', payload: 'old' });
  writeSkill(targetDir, {
    version: '2.0.0',
    payload: 'new',
    lifecycle: 'lifecycle:\n  hooks:\n    post-upgrade: hooks/post-upgrade.js\n',
  });
  fs.mkdirSync(path.join(targetDir, 'hooks'), { recursive: true });
  fs.writeFileSync(
    path.join(targetDir, 'hooks', 'post-upgrade.js'),
    `import fs from 'node:fs';\nimport path from 'node:path';\nconst dataDir = path.join(process.env.ZYLOS_DIR, 'components', '${component}');\nfs.writeFileSync(path.join(dataDir, 'config.json'), '{"state":"new"}');\nfs.writeFileSync(path.join(dataDir, 'created-by-failed-hook'), 'remove');\nfs.writeFileSync(path.join(process.env.ZYLOS_DIR, '.env'), 'KEEP_ME=new\\n');\nprocess.exit(19);\n`,
    'utf8',
  );
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), '{"state":"old"}', 'utf8');
  fs.writeFileSync(envFile, 'KEEP_ME=old\n', 'utf8');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'pm2'), '#!/bin/sh\nprintf \'[]\'\n', { mode: 0o755 });

  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${previousPath}`;
  try {
    const result = runUpgrade(component, {
      tempDir: targetDir,
      newVersion: '2.0.0',
      jsonOutput: true,
    });

    assert.equal(result.success, false);
    assert.equal(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'), '{"state":"old"}');
    assert.equal(fs.existsSync(path.join(dataDir, 'created-by-failed-hook')), false);
    assert.equal(result.rollback.steps.some(step => step.action === 'restore_data' && step.success), true);
    assert.equal(fs.readFileSync(envFile, 'utf8'), 'KEEP_ME=old\n');
    assert.equal(result.rollback.steps.some(step => step.action === 'restore_environment' && step.success), true);
  } finally {
    process.env.PATH = previousPath;
  }
});

test('post-upgrade rollback returns a previously online service to running state', () => {
  const component = 'demo-service';
  const skillDir = path.join(process.env.ZYLOS_DIR, '.claude', 'skills', component);
  const targetDir = path.join(root, 'target-service-failure');
  const fakeBin = path.join(root, 'fake-bin-service');
  const pm2Log = path.join(root, 'pm2-service.log');
  const serviceLifecycle = 'lifecycle:\n  service:\n    name: zylos-demo-service\n';

  writeSkill(skillDir, { version: '1.0.0', payload: 'old', lifecycle: serviceLifecycle });
  writeSkill(targetDir, {
    version: '2.0.0',
    payload: 'new',
    lifecycle: `${serviceLifecycle}  hooks:\n    post-upgrade: hooks/post-upgrade.js\n`,
  });
  fs.mkdirSync(path.join(targetDir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'hooks', 'post-upgrade.js'), 'process.exit(17);\n', 'utf8');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, 'pm2'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${pm2Log}"\nif [ "$1" = "jlist" ]; then\n  printf '[{"name":"zylos-demo-service","pm2_env":{"status":"online"}}]'\nfi\n`,
    { mode: 0o755 },
  );

  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${previousPath}`;
  try {
    const result = runUpgrade(component, {
      tempDir: targetDir,
      newVersion: '2.0.0',
      jsonOutput: true,
    });

    assert.equal(result.success, false);
    assert.equal(result.rollback.steps.some(step => step.action === 'restart_service' && step.success), true);
    const calls = fs.readFileSync(pm2Log, 'utf8').trim().split('\n');
    assert.equal(calls.includes('stop zylos-demo-service'), true);
    assert.equal(calls.includes('restart zylos-demo-service'), true);
    assert.equal(calls.includes('save'), true);
    assert.equal(calls.indexOf('stop zylos-demo-service') < calls.indexOf('restart zylos-demo-service'), true);
  } finally {
    process.env.PATH = previousPath;
  }
});

test('a legacy component with no lifecycle hooks upgrades successfully', () => {
  const skillDir = path.join(process.env.ZYLOS_DIR, '.claude', 'skills', 'demo-legacy');
  const targetDir = path.join(root, 'target-legacy-success');
  const fakeBin = path.join(root, 'fake-bin-legacy');

  writeSkill(skillDir, { version: '1.0.0', payload: 'old' });
  writeSkill(targetDir, { version: '2.0.0', payload: 'new' });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'pm2'), '#!/bin/sh\nprintf \'[]\'\n', { mode: 0o755 });

  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${previousPath}`;
  try {
    const result = runUpgrade('demo-legacy', {
      tempDir: targetDir,
      newVersion: '2.0.0',
      jsonOutput: true,
    });

    assert.equal(result.success, true);
    assert.equal(result.to, '2.0.0');
    assert.equal(fs.readFileSync(path.join(skillDir, 'payload.txt'), 'utf8'), 'new\n');
    assert.equal(result.steps.find(step => step.name === 'pre_upgrade_hook').status, 'skipped');
    assert.equal(result.steps.find(step => step.name === 'post_upgrade_hook').status, 'skipped');
    assert.deepEqual(result.steps.slice(0, 4).map(step => step.name), [
      'verify_capabilities',
      'backup',
      'pre_upgrade_hook',
      'stop_service',
    ]);
  } finally {
    process.env.PATH = previousPath;
  }
});
