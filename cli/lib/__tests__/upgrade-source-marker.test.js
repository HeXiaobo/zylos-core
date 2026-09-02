import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-source-marker-'));
process.env.ZYLOS_DIR = path.join(root, 'zylos');
const fakeToolDir = path.join(root, 'fake-tools');
fs.mkdirSync(fakeToolDir, { recursive: true });
fs.writeFileSync(
  path.join(fakeToolDir, 'pm2'),
  '#!/bin/sh\nif [ "$1" = "jlist" ]; then printf "[]"; fi\n',
  { mode: 0o755 },
);

const { runUpgrade } = await import(new URL('../upgrade.js', import.meta.url));
const { detectChanges, generateManifest, saveMergeBaseline } = await import(new URL('../manifest.js', import.meta.url));
const { loadComponents } = await import(new URL('../components.js', import.meta.url));
const {
  abortUpgradeMetadataTransaction,
  beginUpgradeMetadataTransaction,
  buildUpgradeMetadata,
  recoverUpgradeMetadataTransactions,
} = await import(new URL('../upgrade-metadata.js', import.meta.url));
const CLI = path.join(import.meta.dirname, '..', '..', 'zylos.js');
const CRASH_DRIVER = path.join(
  import.meta.dirname,
  '..', '..', '..',
  'test', 'helpers', 'run-upgrade-metadata-crash-driver.mjs',
);
const REGISTRY_DRIVER = path.join(
  import.meta.dirname,
  '..', '..', '..',
  'test', 'helpers', 'update-components-registry-driver.mjs',
);
// Source-marker transactions do not need external tools.  Keep this fixture
// hermetic so it never inspects, stops, or otherwise depends on host PM2.
const NO_EXTERNAL_UPGRADE_TOOLS = { pm2: null, npm: null };

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function writeSkill(dir, version, payload) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: demo\nversion: ${version}\n---\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'payload.txt'), `${payload}\n`, 'utf8');
}

test('an exact-ref upgrade commits a truthful source marker and preserves install time', () => {
  const component = 'source-marker-success';
  const skillDir = path.join(process.env.ZYLOS_DIR, '.claude', 'skills', component);
  const targetDir = path.join(root, 'target-source-marker-success');
  const installedAt = '2026-01-02T03:04:05.000Z';
  const sha = '182d7b3ed55fd758981c8edc7ae923e3bc03614b';

  writeSkill(skillDir, '1.7.4', 'old');
  fs.writeFileSync(path.join(skillDir, '.zylos-source.json'), JSON.stringify({
    repo: 'HeXiaobo/zylos-hxa-connect',
    sha: '58c99e990e5d4a1d7dc0d0ffb371f285f46ea2f3',
    version: '1.7.4',
    installedAt,
  }));
  writeSkill(targetDir, '1.7.5', 'new');

  const result = runUpgrade(component, {
    tempDir: targetDir,
    newVersion: '1.7.5',
    jsonOutput: true,
    source: {
      type: 'github-release',
      repo: 'HeXiaobo/zylos-hxa-connect',
      ref: sha,
      refType: 'commit',
    },
    tools: NO_EXTERNAL_UPGRADE_TOOLS,
  });

  assert.equal(result.success, true);
  const marker = JSON.parse(fs.readFileSync(path.join(skillDir, '.zylos-source.json'), 'utf8'));
  assert.deepEqual(marker, {
    repo: 'HeXiaobo/zylos-hxa-connect',
    sha,
    ref: sha,
    refType: 'commit',
    version: '1.7.5',
    installedAt,
    upgradedAt: marker.upgradedAt,
  });
  assert.equal(Number.isNaN(Date.parse(marker.upgradedAt)), false);
  assert.deepEqual(result.source, marker);
  assert.equal(fs.statSync(path.join(skillDir, '.zylos-source.json')).mode & 0o777, 0o600);
});

test('source provenance is runtime metadata, not a local business-file modification', () => {
  const component = 'source-marker-change-detection';
  const skillDir = path.join(process.env.ZYLOS_DIR, '.claude', 'skills', component);
  const sourceDir = path.join(root, 'source-marker-change-detection-baseline');

  writeSkill(skillDir, '1.0.0', 'same');
  writeSkill(sourceDir, '1.0.0', 'same');
  saveMergeBaseline(skillDir, sourceDir, generateManifest(sourceDir));
  fs.writeFileSync(path.join(skillDir, '.zylos-source.json'), JSON.stringify({
    repo: 'HeXiaobo/example',
    ref: 'main',
    refType: 'branch',
    version: '1.0.0',
  }));

  const changes = detectChanges(skillDir);

  assert.deepEqual(changes.added, []);
  assert.deepEqual(changes.modified, []);
  assert.deepEqual(changes.deleted, []);
});

test('a legacy baseline that tracked the source marker is normalized on read', () => {
  const component = 'legacy-source-marker-baseline';
  const skillDir = path.join(process.env.ZYLOS_DIR, '.claude', 'skills', component);
  const sourceDir = path.join(root, 'legacy-source-marker-baseline-source');

  writeSkill(skillDir, '1.0.0', 'same');
  writeSkill(sourceDir, '1.0.0', 'same');
  saveMergeBaseline(skillDir, sourceDir, generateManifest(sourceDir));
  const manifestPath = path.join(skillDir, '.zylos', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.files['.zylos-source.json'] = 'legacy-runtime-metadata-hash';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));

  const changes = detectChanges(skillDir);

  assert.deepEqual(changes.deleted, []);
  assert.equal(changes.unchanged.includes('.zylos-source.json'), false);
});

test('a final baseline failure restores the previous source marker', () => {
  const component = 'source-marker-rollback';
  const skillDir = path.join(process.env.ZYLOS_DIR, '.claude', 'skills', component);
  const targetDir = path.join(root, 'target-source-marker-rollback');
  const oldMarker = {
    repo: 'HeXiaobo/zylos-hxa-connect',
    sha: '58c99e990e5d4a1d7dc0d0ffb371f285f46ea2f3',
    version: '1.7.4',
    installedAt: '2026-01-02T03:04:05.000Z',
  };

  writeSkill(skillDir, '1.7.4', 'old');
  fs.writeFileSync(path.join(skillDir, '.zylos-source.json'), JSON.stringify(oldMarker));
  writeSkill(targetDir, '1.7.5', 'new');

  const realRename = fs.renameSync;
  fs.renameSync = (src, dest) => {
    if (String(src).endsWith(path.join('.zylos', 'manifest.json.tmp'))) {
      throw new Error('EIO: injected baseline commit failure');
    }
    return realRename(src, dest);
  };

  let result;
  try {
    result = runUpgrade(component, {
      tempDir: targetDir,
      newVersion: '1.7.5',
      jsonOutput: true,
      source: {
        type: 'github-release',
        repo: 'HeXiaobo/zylos-hxa-connect',
        ref: '182d7b3ed55fd758981c8edc7ae923e3bc03614b',
        refType: 'commit',
      },
      tools: NO_EXTERNAL_UPGRADE_TOOLS,
    });
  } finally {
    fs.renameSync = realRename;
  }

  assert.equal(result.success, false);
  assert.equal(result.failedStep, 10);
  assert.equal(result.rollback.performed, true);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(skillDir, '.zylos-source.json'), 'utf8')),
    oldMarker,
  );
  assert.equal(fs.readFileSync(path.join(skillDir, 'payload.txt'), 'utf8'), 'old\n');
});

test('the CLI persists commit, branch, and tag provenance in both registries', () => {
  const fixtureRoot = path.join(root, 'cli-exact-ref');
  const zylosDir = path.join(fixtureRoot, 'zylos-home');
  const component = 'hxa-connect';
  const repo = 'HeXiaobo/zylos-hxa-connect';
  const oldSha = '58c99e990e5d4a1d7dc0d0ffb371f285f46ea2f3';
  const newSha = '182d7b3ed55fd758981c8edc7ae923e3bc03614b';
  const installedAt = '2026-01-02T03:04:05.000Z';
  const skillDir = path.join(zylosDir, '.claude', 'skills', component);
  const archiveRoot = path.join(fixtureRoot, 'zylos-hxa-connect-fixture');
  const tarball = path.join(fixtureRoot, 'target.tar.gz');
  const fakeBin = path.join(fixtureRoot, 'bin');

  writeSkill(skillDir, '1.7.4', 'old');
  fs.writeFileSync(path.join(skillDir, '.zylos-source.json'), JSON.stringify({
    repo,
    sha: oldSha,
    version: '1.7.4',
    installedAt,
  }));
  writeSkill(archiveRoot, '1.7.5', 'new');
  fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(zylosDir, '.zylos', 'components.json'), JSON.stringify({
    [component]: {
      version: '1.7.4',
      repo,
      installedAt,
      branch: oldSha,
      source: { type: 'github-release', repo, ref: oldSha, refType: 'commit' },
    },
  }));
  execFileSync('tar', ['czf', tarball, '-C', fixtureRoot, path.basename(archiveRoot)]);

  fs.mkdirSync(fakeBin, { recursive: true });
  const fakeCurlModule = path.join(fakeBin, 'curl.mjs');
  fs.writeFileSync(fakeCurlModule, [
    "import fs from 'node:fs';",
    'const args = process.argv.slice(2);',
    "const outputIndex = args.indexOf('-o');",
    'if (outputIndex !== -1) {',
    '  fs.copyFileSync(process.env.FAKE_GITHUB_TARBALL, args[outputIndex + 1]);',
    '  process.exit(0);',
    '}',
    "process.stdout.write(JSON.stringify([{ name: `v${process.env.FAKE_GITHUB_TAG_VERSION}` }]));",
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(
    path.join(fakeBin, 'curl'),
    `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/curl.mjs" "$@"\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(fakeBin, 'pm2'),
    '#!/bin/sh\nif [ "$1" = "jlist" ]; then printf \'[]\'; fi\n',
    { mode: 0o755 },
  );

  function runCli(extraArgs = []) {
    return spawnSync(process.execPath, [
      CLI,
      'upgrade', component,
      ...extraArgs,
      '--yes', '--skip-eval', '--json',
    ], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        ZYLOS_DIR: zylosDir,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        FAKE_GITHUB_TARBALL: tarball,
        FAKE_GITHUB_TAG_VERSION: '1.7.7',
        GITHUB_TOKEN: '',
        GH_TOKEN: '',
      },
      encoding: 'utf8',
      timeout: 30000,
    });
  }

  const child = runCli(['--branch', newSha]);

  assert.equal(child.status, 0, `stdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
  const output = JSON.parse(child.stdout);
  const components = JSON.parse(fs.readFileSync(path.join(zylosDir, '.zylos', 'components.json'), 'utf8'));
  const marker = JSON.parse(fs.readFileSync(path.join(skillDir, '.zylos-source.json'), 'utf8'));
  assert.equal(output.success, true);
  assert.equal(components[component].version, '1.7.5');
  assert.equal(components[component].branch, newSha);
  assert.deepEqual(components[component].source, {
    type: 'github-release',
    repo,
    ref: newSha,
    refType: 'commit',
  });
  assert.equal(components[component].upgradedAt, marker.upgradedAt);
  assert.equal(marker.sha, newSha);
  assert.equal(marker.ref, newSha);
  assert.equal(marker.refType, 'commit');
  assert.equal(marker.version, '1.7.5');
  assert.equal(marker.installedAt, installedAt);

  writeSkill(archiveRoot, '1.7.6', 'branch');
  execFileSync('tar', ['czf', tarball, '-C', fixtureRoot, path.basename(archiveRoot)]);
  const branchChild = runCli(['--branch', 'release-candidate']);
  assert.equal(
    branchChild.status,
    0,
    `stdout:\n${branchChild.stdout}\nstderr:\n${branchChild.stderr}`,
  );
  const branchComponents = JSON.parse(fs.readFileSync(path.join(zylosDir, '.zylos', 'components.json'), 'utf8'));
  const branchMarker = JSON.parse(fs.readFileSync(path.join(skillDir, '.zylos-source.json'), 'utf8'));
  assert.equal(branchComponents[component].version, '1.7.6');
  assert.equal(branchComponents[component].branch, 'release-candidate');
  assert.equal(branchComponents[component].source.refType, 'branch');
  assert.equal(branchMarker.ref, 'release-candidate');
  assert.equal(branchMarker.refType, 'branch');
  assert.equal(Object.hasOwn(branchMarker, 'sha'), false);
  assert.equal(branchMarker.installedAt, installedAt);

  writeSkill(archiveRoot, '1.7.7', 'tag');
  execFileSync('tar', ['czf', tarball, '-C', fixtureRoot, path.basename(archiveRoot)]);
  const tagChild = runCli();
  assert.equal(tagChild.status, 0, `stdout:\n${tagChild.stdout}\nstderr:\n${tagChild.stderr}`);
  const tagComponents = JSON.parse(fs.readFileSync(path.join(zylosDir, '.zylos', 'components.json'), 'utf8'));
  const tagMarker = JSON.parse(fs.readFileSync(path.join(skillDir, '.zylos-source.json'), 'utf8'));
  assert.equal(tagComponents[component].version, '1.7.7');
  assert.equal(Object.hasOwn(tagComponents[component], 'branch'), false);
  assert.equal(tagComponents[component].source.ref, '1.7.7');
  assert.equal(tagComponents[component].source.refType, 'tag');
  assert.equal(tagMarker.ref, '1.7.7');
  assert.equal(tagMarker.refType, 'tag');
  assert.equal(Object.hasOwn(tagMarker, 'sha'), false);
  assert.equal(tagMarker.installedAt, installedAt);
});

test('a crash at the baseline commit point rolls source metadata forward on the next read', () => {
  const component = 'source-marker-crash-recovery';
  const skillDir = path.join(process.env.ZYLOS_DIR, '.claude', 'skills', component);
  const targetDir = path.join(root, 'target-source-marker-crash-recovery');
  const componentsPath = path.join(process.env.ZYLOS_DIR, '.zylos', 'components.json');
  const repo = 'HeXiaobo/zylos-hxa-connect';
  const oldSha = '58c99e990e5d4a1d7dc0d0ffb371f285f46ea2f3';
  const newSha = '182d7b3ed55fd758981c8edc7ae923e3bc03614b';
  const installedAt = '2026-01-02T03:04:05.000Z';
  const registryEntry = {
    version: '1.7.4',
    repo,
    installedAt,
    branch: oldSha,
    source: { type: 'github-release', repo, ref: oldSha, refType: 'commit' },
  };
  const source = {
    type: 'github-release',
    repo,
    ref: newSha,
    refType: 'commit',
    installedAt,
  };

  writeSkill(skillDir, '1.7.4', 'old');
  writeSkill(targetDir, '1.7.5', 'new');
  fs.writeFileSync(path.join(skillDir, '.zylos-source.json'), JSON.stringify({
    repo,
    sha: oldSha,
    version: '1.7.4',
    installedAt,
  }));
  fs.mkdirSync(path.dirname(componentsPath), { recursive: true });
  const existingComponents = fs.existsSync(componentsPath)
    ? JSON.parse(fs.readFileSync(componentsPath, 'utf8'))
    : {};
  existingComponents[component] = registryEntry;
  fs.writeFileSync(componentsPath, JSON.stringify(existingComponents));

  const child = spawnSync(process.execPath, [CRASH_DRIVER, component, targetDir, '1.7.5'], {
    env: {
      ...process.env,
      ZYLOS_DIR: process.env.ZYLOS_DIR,
      PATH: `${fakeToolDir}${path.delimiter}${process.env.PATH}`,
      ZYLOS_TEST_UPGRADE_SOURCE: JSON.stringify(source),
      ZYLOS_TEST_UPGRADE_REGISTRY_ENTRY: JSON.stringify(registryEntry),
    },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(child.status, 86, `stdout:\n${child.stdout}\nstderr:\n${child.stderr}`);

  const recovered = loadComponents();
  const marker = JSON.parse(fs.readFileSync(path.join(skillDir, '.zylos-source.json'), 'utf8'));

  assert.equal(recovered[component].version, '1.7.5');
  assert.equal(recovered[component].source.ref, newSha);
  assert.equal(recovered[component].branch, newSha);
  assert.equal(marker.sha, newSha);
  assert.equal(marker.version, '1.7.5');
});

test('a crash before the baseline commit retains a fail-closed recovery journal', () => {
  const component = 'source-marker-precommit-crash';
  const skillDir = path.join(process.env.ZYLOS_DIR, '.claude', 'skills', component);
  const targetDir = path.join(root, 'target-source-marker-precommit-crash');
  const componentsPath = path.join(process.env.ZYLOS_DIR, '.zylos', 'components.json');
  const repo = 'HeXiaobo/zylos-hxa-connect';
  const oldSha = '58c99e990e5d4a1d7dc0d0ffb371f285f46ea2f3';
  const newSha = '182d7b3ed55fd758981c8edc7ae923e3bc03614b';
  const registryEntry = {
    version: '1.7.4',
    repo,
    branch: oldSha,
    source: { type: 'github-release', repo, ref: oldSha, refType: 'commit' },
  };
  const source = {
    type: 'github-release',
    repo,
    ref: newSha,
    refType: 'commit',
  };

  writeSkill(skillDir, '1.7.4', 'old');
  writeSkill(targetDir, '1.7.5', 'new');
  fs.writeFileSync(path.join(skillDir, '.zylos-source.json'), JSON.stringify({
    repo,
    sha: oldSha,
    version: '1.7.4',
  }));
  const components = JSON.parse(fs.readFileSync(componentsPath, 'utf8'));
  components[component] = registryEntry;
  fs.writeFileSync(componentsPath, JSON.stringify(components));

  const child = spawnSync(process.execPath, [CRASH_DRIVER, component, targetDir, '1.7.5'], {
    env: {
      ...process.env,
      ZYLOS_DIR: process.env.ZYLOS_DIR,
      PATH: `${fakeToolDir}${path.delimiter}${process.env.PATH}`,
      ZYLOS_TEST_UPGRADE_SOURCE: JSON.stringify(source),
      ZYLOS_TEST_UPGRADE_REGISTRY_ENTRY: JSON.stringify(registryEntry),
      ZYLOS_TEST_UPGRADE_CRASH_POINT: 'before-baseline-rename',
    },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(child.status, 87, `stdout:\n${child.stdout}\nstderr:\n${child.stderr}`);

  const journalPath = path.join(
    process.env.ZYLOS_DIR,
    '.zylos',
    'upgrade-metadata-transactions',
    `${component}.json`,
  );
  assert.equal(fs.readFileSync(path.join(skillDir, 'payload.txt'), 'utf8'), 'new\n');
  assert.throws(
    () => loadComponents(),
    /business rollback cannot be proven; preserved/,
  );
  assert.equal(fs.existsSync(journalPath), true);
  assert.equal(JSON.parse(fs.readFileSync(componentsPath, 'utf8'))[component].version, '1.7.4');
  assert.equal(JSON.parse(fs.readFileSync(path.join(skillDir, '.zylos-source.json'), 'utf8')).sha, oldSha);

  fs.rmSync(journalPath, { force: true });
});

test('a transient registry commit failure is journaled and recovered without rolling code back', () => {
  const component = 'source-marker-registry-recovery';
  const skillDir = path.join(process.env.ZYLOS_DIR, '.claude', 'skills', component);
  const targetDir = path.join(root, 'target-source-marker-registry-recovery');
  const componentsPath = path.join(process.env.ZYLOS_DIR, '.zylos', 'components.json');
  const repo = 'HeXiaobo/zylos-hxa-connect';
  const oldSha = '58c99e990e5d4a1d7dc0d0ffb371f285f46ea2f3';
  const newSha = '182d7b3ed55fd758981c8edc7ae923e3bc03614b';
  const installedAt = '2026-01-02T03:04:05.000Z';
  const registryEntry = {
    version: '1.7.4',
    repo,
    installedAt,
    branch: oldSha,
    source: { type: 'github-release', repo, ref: oldSha, refType: 'commit' },
  };

  writeSkill(skillDir, '1.7.4', 'old');
  writeSkill(targetDir, '1.7.5', 'new');
  fs.writeFileSync(path.join(skillDir, '.zylos-source.json'), JSON.stringify({
    repo,
    sha: oldSha,
    version: '1.7.4',
    installedAt,
  }));
  const components = loadComponents();
  components[component] = registryEntry;
  fs.writeFileSync(componentsPath, JSON.stringify(components));

  const realRename = fs.renameSync;
  let injected = false;
  fs.renameSync = (src, dest) => {
    if (!injected && dest === componentsPath && String(src).includes('.tmp-')) {
      injected = true;
      throw new Error('EIO: injected components registry commit failure');
    }
    return realRename(src, dest);
  };
  let result;
  try {
    result = runUpgrade(component, {
      tempDir: targetDir,
      newVersion: '1.7.5',
      jsonOutput: true,
      source: {
        type: 'github-release',
        repo,
        ref: newSha,
        refType: 'commit',
        installedAt,
      },
      registryEntry,
      tools: NO_EXTERNAL_UPGRADE_TOOLS,
    });
  } finally {
    fs.renameSync = realRename;
  }

  assert.equal(result.success, true);
  assert.equal(result.metadataRecoveryPending, true);
  assert.equal(fs.readFileSync(path.join(skillDir, 'payload.txt'), 'utf8'), 'new\n');

  const recovered = loadComponents();
  const marker = JSON.parse(fs.readFileSync(path.join(skillDir, '.zylos-source.json'), 'utf8'));
  assert.equal(recovered[component].version, '1.7.5');
  assert.equal(recovered[component].source.ref, newSha);
  assert.equal(marker.sha, newSha);
});

test('recovery never aborts another live process metadata transaction', () => {
  const component = 'source-marker-live-transaction';
  const skillDir = path.join(process.env.ZYLOS_DIR, '.claude', 'skills', component);
  const sourceDir = path.join(root, 'source-marker-live-transaction-source');
  writeSkill(skillDir, '1.0.0', 'old');
  writeSkill(sourceDir, '2.0.0', 'new');

  const metadata = buildUpgradeMetadata({
    component,
    skillDir,
    version: '2.0.0',
    source: {
      type: 'github-release',
      repo: 'HeXiaobo/example',
      ref: 'main',
      refType: 'branch',
    },
    registryEntry: null,
  });
  const begun = beginUpgradeMetadataTransaction({
    component,
    skillDir,
    marker: metadata.marker,
    targetRegistryEntry: metadata.targetRegistryEntry,
    manifest: generateManifest(sourceDir),
  });

  const recovered = recoverUpgradeMetadataTransactions({ component });
  const journalPath = path.join(
    process.env.ZYLOS_DIR,
    '.zylos',
    'upgrade-metadata-transactions',
    `${component}.json`,
  );
  assert.deepEqual(recovered, [{ component, action: 'in_progress' }]);
  assert.equal(fs.existsSync(journalPath), true);

  abortUpgradeMetadataTransaction(begun.journal);
  assert.equal(fs.existsSync(journalPath), false);
});

test('recovery retains an uncommitted journal after its owner process is gone', () => {
  const component = 'source-marker-dead-transaction';
  const skillDir = path.join(process.env.ZYLOS_DIR, '.claude', 'skills', component);
  const sourceDir = path.join(root, 'source-marker-dead-transaction-source');
  writeSkill(skillDir, '1.0.0', 'old');
  writeSkill(sourceDir, '2.0.0', 'new');

  const metadata = buildUpgradeMetadata({
    component,
    skillDir,
    version: '2.0.0',
    source: {
      type: 'github-release',
      repo: 'HeXiaobo/example',
      ref: 'main',
      refType: 'branch',
    },
    registryEntry: null,
  });
  const begun = beginUpgradeMetadataTransaction({
    component,
    skillDir,
    marker: metadata.marker,
    targetRegistryEntry: metadata.targetRegistryEntry,
    manifest: generateManifest(sourceDir),
  });
  const journalPath = path.join(
    process.env.ZYLOS_DIR,
    '.zylos',
    'upgrade-metadata-transactions',
    `${component}.json`,
  );
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  journal.owner = { pid: 2_147_483_647, startToken: 'proc:dead-owner' };
  fs.writeFileSync(journalPath, JSON.stringify(journal));

  assert.throws(
    () => recoverUpgradeMetadataTransactions({ component }),
    /business rollback cannot be proven; preserved/,
  );
  assert.equal(fs.existsSync(journalPath), true);
  abortUpgradeMetadataTransaction(begun.journal);
  assert.equal(fs.existsSync(journalPath), false);
});

test('an unreadable or corrupt commit point is UNKNOWN and retains its journal', () => {
  const component = 'source-marker-unknown-commit';
  const skillDir = path.join(process.env.ZYLOS_DIR, '.claude', 'skills', component);
  const sourceDir = path.join(root, 'source-marker-unknown-commit-source');
  writeSkill(skillDir, '1.0.0', 'old');
  writeSkill(sourceDir, '2.0.0', 'new');
  saveMergeBaseline(skillDir, skillDir, generateManifest(skillDir));
  const manifestPath = path.join(skillDir, '.zylos', 'manifest.json');
  const previousManifest = fs.readFileSync(manifestPath, 'utf8');

  const metadata = buildUpgradeMetadata({
    component,
    skillDir,
    version: '2.0.0',
    source: {
      type: 'github-release',
      repo: 'HeXiaobo/example',
      ref: 'main',
      refType: 'branch',
    },
    registryEntry: null,
  });
  const begun = beginUpgradeMetadataTransaction({
    component,
    skillDir,
    marker: metadata.marker,
    targetRegistryEntry: metadata.targetRegistryEntry,
    manifest: generateManifest(sourceDir),
  });
  const journalPath = path.join(
    process.env.ZYLOS_DIR,
    '.zylos',
    'upgrade-metadata-transactions',
    `${component}.json`,
  );
  fs.writeFileSync(manifestPath, '{corrupt');

  assert.throws(
    () => recoverUpgradeMetadataTransactions({ component }),
    /baseline state is UNKNOWN/,
  );
  assert.equal(fs.existsSync(journalPath), true);

  fs.writeFileSync(manifestPath, previousManifest);
  abortUpgradeMetadataTransaction(begun.journal);
});

test('concurrent registry transactions preserve updates to different components', async () => {
  const componentsPath = path.join(process.env.ZYLOS_DIR, '.zylos', 'components.json');
  const components = JSON.parse(fs.readFileSync(componentsPath, 'utf8'));
  components['registry-lock-a'] = { version: '1.0.0' };
  components['registry-lock-b'] = { version: '1.0.0' };
  fs.writeFileSync(componentsPath, JSON.stringify(components));

  function run(component, version, delay, mode = 'transaction') {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        REGISTRY_DRIVER,
        component,
        version,
        String(delay),
        mode,
      ], {
        env: { ...process.env, ZYLOS_DIR: process.env.ZYLOS_DIR },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, stderr }));
    });
  }

  const slow = run('registry-lock-a', '2.0.0', 250);
  await new Promise(resolve => setTimeout(resolve, 50));
  const fast = run('registry-lock-b', '2.0.0', 0);
  const results = await Promise.all([slow, fast]);
  assert.deepEqual(results.map(result => result.code), [0, 0], JSON.stringify(results));

  const updated = JSON.parse(fs.readFileSync(componentsPath, 'utf8'));
  assert.equal(updated['registry-lock-a'].version, '2.0.0');
  assert.equal(updated['registry-lock-b'].version, '2.0.0');
});

test('saveComponents merges its observed delta with a concurrent registry transaction', async () => {
  const componentsPath = path.join(process.env.ZYLOS_DIR, '.zylos', 'components.json');
  const components = JSON.parse(fs.readFileSync(componentsPath, 'utf8'));
  components['registry-save-a'] = { version: '1.0.0' };
  components['registry-save-b'] = { version: '1.0.0' };
  fs.writeFileSync(componentsPath, JSON.stringify(components));

  function run(component, version, delay, mode) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        REGISTRY_DRIVER,
        component,
        version,
        String(delay),
        mode,
      ], {
        env: { ...process.env, ZYLOS_DIR: process.env.ZYLOS_DIR },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, stderr }));
    });
  }

  const delayedSave = run('registry-save-a', '2.0.0', 250, 'save-components');
  await new Promise(resolve => setTimeout(resolve, 50));
  const directUpdate = run('registry-save-b', '2.0.0', 0, 'transaction');
  const results = await Promise.all([delayedSave, directUpdate]);
  assert.deepEqual(results.map(result => result.code), [0, 0], JSON.stringify(results));

  const updated = JSON.parse(fs.readFileSync(componentsPath, 'utf8'));
  assert.equal(updated['registry-save-a'].version, '2.0.0');
  assert.equal(updated['registry-save-b'].version, '2.0.0');
});

test('invalid source provenance is rejected before backup or mutation', () => {
  const component = 'source-marker-invalid-source';
  const skillDir = path.join(process.env.ZYLOS_DIR, '.claude', 'skills', component);
  const targetDir = path.join(root, 'target-source-marker-invalid-source');

  writeSkill(skillDir, '1.0.0', 'old');
  writeSkill(targetDir, '2.0.0', 'new');

  const result = runUpgrade(component, {
    tempDir: targetDir,
    newVersion: '2.0.0',
    jsonOutput: true,
    source: {
      type: 'github-release',
      repo: 'HeXiaobo/example',
      ref: 'not-a-full-sha',
      refType: 'commit',
    },
    tools: NO_EXTERNAL_UPGRADE_TOOLS,
  });

  assert.equal(result.success, false);
  assert.match(result.error, /commit source ref must be a full 40-hex SHA/);
  assert.deepEqual(result.steps, []);
  assert.equal(fs.existsSync(path.join(skillDir, '.backup')), false);
  assert.equal(fs.readFileSync(path.join(skillDir, 'payload.txt'), 'utf8'), 'old\n');
});

test('branch and tag provenance never claim a SHA or invent an install time', () => {
  const branchComponent = 'source-marker-branch';
  const branchSkillDir = path.join(process.env.ZYLOS_DIR, '.claude', 'skills', branchComponent);
  writeSkill(branchSkillDir, '2.0.0', 'branch');

  const branch = buildUpgradeMetadata({
    component: branchComponent,
    skillDir: branchSkillDir,
    version: '2.0.0',
    source: {
      type: 'github-release',
      repo: 'HeXiaobo/example',
      ref: 'release-candidate',
      refType: 'branch',
    },
    registryEntry: {
      version: '1.0.0',
      repo: 'HeXiaobo/example',
      installedAt: null,
    },
  });

  assert.equal(Object.hasOwn(branch.marker, 'sha'), false);
  assert.equal(Object.hasOwn(branch.marker, 'installedAt'), false);
  assert.equal(branch.targetRegistryEntry.branch, 'release-candidate');

  const tagComponent = 'source-marker-tag';
  const tagSkillDir = path.join(process.env.ZYLOS_DIR, '.claude', 'skills', tagComponent);
  writeSkill(tagSkillDir, '2.1.0', 'tag');
  const tag = buildUpgradeMetadata({
    component: tagComponent,
    skillDir: tagSkillDir,
    version: '2.1.0',
    source: {
      type: 'github-release',
      repo: 'HeXiaobo/example',
      ref: '2.1.0',
      refType: 'tag',
    },
    registryEntry: {
      version: '2.0.0',
      repo: 'HeXiaobo/example',
      branch: 'release-candidate',
    },
  });

  assert.equal(Object.hasOwn(tag.marker, 'sha'), false);
  assert.equal(Object.hasOwn(tag.targetRegistryEntry, 'branch'), false);
  assert.equal(tag.targetRegistryEntry.source.refType, 'tag');
});
