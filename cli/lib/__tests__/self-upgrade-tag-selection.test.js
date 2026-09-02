import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, it } from 'node:test';

const SELF_UPGRADE_URL = pathToFileURL(path.resolve('cli/lib/self-upgrade.js')).href;
const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fakeGitHubEnvironment(tags, fixture = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-self-check-tags-'));
  tempDirs.push(tempDir);

  const binDir = path.join(tempDir, 'bin');
  const callsPath = path.join(tempDir, 'curl-calls.txt');
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, 'curl'),
    fixture.curlFailure
      ? '#!/bin/sh\necho "curl: (22) The requested URL returned error: 500" >&2\nexit 22\n'
      : fixture.downloadFailure
        ? `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CURL_CALLS"
case "$*" in
  *"/tags?per_page=100"*) printf '%s\\n' "$FAKE_TAGS_JSON"; exit 0 ;;
  *"/archive/refs/tags/"*) echo "curl: (22) The requested URL returned error: 404" >&2; exit 22 ;;
  *"raw.githubusercontent.com"*) printf '%s\\n' '# changelog'; exit 0 ;;
esac
exit 2
`
        : '#!/bin/sh\nprintf \'%s\\n\' "$FAKE_TAGS_JSON"\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(binDir, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    HOME: tempDir,
    ZYLOS_DIR: path.join(tempDir, 'zylos'),
    ZYLOS_SELF_UPGRADE_REPO: 'HeXiaobo/zylos-core',
    FAKE_TAGS_JSON: JSON.stringify(tags),
    FAKE_CURL_CALLS: callsPath,
    NO_COLOR: '1',
  };
}

function checkWithTags(tags, options = {}, fixture = {}) {
  const env = fakeGitHubEnvironment(tags, fixture);

  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `import { checkForCoreUpdates } from ${JSON.stringify(SELF_UPGRADE_URL)};
     process.stdout.write(JSON.stringify(checkForCoreUpdates(${JSON.stringify(options)})));`,
  ], {
    cwd: path.resolve('.'),
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function downloadSelectedTag(source, fixture = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-self-download-tag-'));
  tempDirs.push(tempDir);

  const archiveRoot = path.join(tempDir, 'archive-root');
  const packageRoot = path.join(archiveRoot, 'zylos-core-fixture');
  const archivePath = path.join(tempDir, 'fixture.tar.gz');
  const callsPath = path.join(tempDir, 'curl-calls.txt');
  const binDir = path.join(tempDir, 'bin');
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), '{"name":"zylos","version":"0.8.0"}\n');
  execFileSync('tar', ['czf', archivePath, '-C', archiveRoot, 'zylos-core-fixture']);
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'curl'), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CURL_CALLS"
if [ "${fixture.failTag ? '1' : '0'}" = "1" ]; then
  echo "curl: (22) The requested URL returned error: 404" >&2
  exit 22
fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    shift
    cp "$FAKE_ARCHIVE" "$1"
    exit 0
  fi
  shift
done
exit 2
`, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `import { downloadCoreToTemp } from ${JSON.stringify(SELF_UPGRADE_URL)};
     const result = downloadCoreToTemp(${JSON.stringify(source.version)}, null, ${JSON.stringify(source)});
     process.stdout.write(JSON.stringify(result));`,
  ], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      HOME: tempDir,
      ZYLOS_DIR: path.join(tempDir, 'zylos'),
      ZYLOS_SELF_UPGRADE_REPO: 'HeXiaobo/zylos-core',
      FAKE_ARCHIVE: archivePath,
      FAKE_CURL_CALLS: callsPath,
      ZYLOS_GH_RETRY_DELAY_MS: '',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  return {
    result: JSON.parse(result.stdout),
    calls: fs.existsSync(callsPath) ? fs.readFileSync(callsPath, 'utf8') : '',
  };
}

describe('self-upgrade tag selection', () => {
  it('explains when stable-only policy excludes every prerelease tag in the fork', () => {
    const result = checkWithTags([
      { name: 'v0.7.2-rc.18' },
      { name: 'v0.7.2-rc.22' },
    ]);

    assert.equal(result.success, false);
    assert.equal(result.error, 'prerelease_tags_excluded');
    assert.deepEqual(result.source, {
      repo: 'HeXiaobo/zylos-core',
      policy: 'stable-only',
      tag: null,
      ref: null,
    });
    assert.deepEqual(result.availablePrerelease, {
      version: '0.7.2-rc.22',
      tag: 'v0.7.2-rc.22',
      ref: 'refs/tags/v0.7.2-rc.22',
    });
    assert.match(result.message, /--beta/);
    assert.doesNotMatch(result.message, /No release tags found/);
  });

  it('includes rc tags under beta policy and selects them by semver', () => {
    const result = checkWithTags([
      { name: 'v0.7.2-rc.9' },
      { name: 'v0.7.2-rc.22' },
      { name: 'v0.7.2-rc.18' },
    ], { beta: true });

    assert.equal(result.success, true);
    assert.equal(result.hasUpdate, false);
    assert.equal(result.current, '0.7.2-rc.26');
    assert.equal(result.latest, '0.7.2-rc.22');
    assert.deepEqual(result.source, {
      repo: 'HeXiaobo/zylos-core',
      policy: 'include-prerelease',
      tag: 'v0.7.2-rc.22',
      ref: 'refs/tags/v0.7.2-rc.22',
    });
  });

  it('reports when the repository truly has no tags', () => {
    const result = checkWithTags([]);

    assert.equal(result.success, false);
    assert.equal(result.error, 'no_repository_tags');
    assert.equal(result.message, 'No tags found in HeXiaobo/zylos-core');
    assert.deepEqual(result.source, {
      repo: 'HeXiaobo/zylos-core',
      policy: 'stable-only',
      tag: null,
      ref: null,
    });
  });

  it('distinguishes malformed repository tags from an empty repository', () => {
    const result = checkWithTags([
      { name: 'release-candidate' },
      { name: 'v0.7' },
    ]);

    assert.equal(result.success, false);
    assert.equal(result.error, 'no_semver_release_tags');
    assert.match(result.message, /2 repository tag\(s\) inspected/);
    assert.doesNotMatch(result.message, /No tags found/);
  });

  it('records the exact stable tag instead of inferring a v-prefixed ref', () => {
    const result = checkWithTags([
      { name: 'v0.7.2-rc.30' },
      { name: '0.8.0' },
    ]);

    assert.equal(result.success, true);
    assert.equal(result.hasUpdate, true);
    assert.equal(result.latest, '0.8.0');
    assert.deepEqual(result.source, {
      repo: 'HeXiaobo/zylos-core',
      policy: 'stable-only',
      tag: '0.8.0',
      ref: 'refs/tags/0.8.0',
    });
  });

  it('keeps repository context when the tag query fails', () => {
    const result = checkWithTags([], {}, { curlFailure: true });

    assert.equal(result.success, false);
    assert.equal(result.error, 'remote_version_failed');
    assert.match(result.message, /Cannot fetch latest version from HeXiaobo\/zylos-core/);
    assert.match(result.message, /500/);
    assert.deepEqual(result.source, {
      repo: 'HeXiaobo/zylos-core',
      policy: 'stable-only',
      tag: null,
      ref: null,
    });
  });

  it('treats a non-array GitHub response as a remote schema failure', () => {
    const result = checkWithTags({
      message: 'API response is not a tag list',
      documentation_url: 'https://docs.github.com/rest',
    });

    assert.equal(result.success, false);
    assert.equal(result.error, 'remote_version_failed');
    assert.match(result.message, /Invalid GitHub tags response/);
    assert.deepEqual(result.source, {
      repo: 'HeXiaobo/zylos-core',
      policy: 'stable-only',
      tag: null,
      ref: null,
    });
  });

  it('displays the exact repository, ref, tag, and policy in human check output', () => {
    const env = fakeGitHubEnvironment([{ name: 'v0.7.2-rc.22' }]);
    const result = spawnSync(process.execPath, [
      'cli/zylos.js', 'upgrade', '--self', '--check', '--beta',
    ], {
      cwd: path.resolve('.'),
      env,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /Source: HeXiaobo\/zylos-core @ refs\/tags\/v0\.7\.2-rc\.22 \(tag v0\.7\.2-rc\.22; include-prerelease\)/,
    );
  });

  it('prints actionable prerelease policy details from the ordinary CLI check', () => {
    const env = fakeGitHubEnvironment([{ name: 'v0.7.2-rc.22' }]);
    const result = spawnSync(process.execPath, [
      'cli/zylos.js', 'upgrade', '--self', '--check',
    ], {
      cwd: path.resolve('.'),
      env,
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /HeXiaobo\/zylos-core/);
    assert.match(result.stderr, /v0\.7\.2-rc\.22 \(refs\/tags\/v0\.7\.2-rc\.22\)/);
    assert.match(result.stderr, /--beta/);
    assert.doesNotMatch(result.stderr, /No release tags found/);
  });

  it('downloads the exact selected tag without inventing a v prefix', () => {
    const source = {
      repo: 'HeXiaobo/zylos-core',
      policy: 'stable-only',
      version: '0.8.0',
      tag: '0.8.0',
      ref: 'refs/tags/0.8.0',
    };

    const acquisition = downloadSelectedTag(source);

    assert.equal(acquisition.result.success, true);
    assert.deepEqual(acquisition.result.source, source);
    assert.match(acquisition.calls, /archive\/refs\/tags\/0\.8\.0\.tar\.gz/);
    assert.doesNotMatch(acquisition.calls, /archive\/refs\/tags\/v0\.8\.0\.tar\.gz/);
  });

  it('fails closed when the selected immutable tag cannot be downloaded', () => {
    const source = {
      repo: 'HeXiaobo/zylos-core',
      policy: 'stable-only',
      version: '0.8.0',
      tag: '0.8.0',
      ref: 'refs/tags/0.8.0',
    };

    const acquisition = downloadSelectedTag(source, { failTag: true });

    assert.equal(acquisition.result.success, false);
    assert.deepEqual(acquisition.result.source, source);
    assert.match(acquisition.result.error, /HeXiaobo\/zylos-core@0\.8\.0/);
    assert.match(acquisition.calls, /archive\/refs\/tags\/0\.8\.0\.tar\.gz/);
    assert.doesNotMatch(acquisition.calls, /archive\/refs\/heads\/main\.tar\.gz/);
  });

  it('rejects a selected tag whose version disagrees with the checked version', () => {
    const source = {
      repo: 'HeXiaobo/zylos-core',
      policy: 'stable-only',
      version: '0.8.0',
      tag: '0.8.1',
      ref: 'refs/tags/0.8.1',
    };

    const acquisition = downloadSelectedTag(source);

    assert.equal(acquisition.result.success, false);
    assert.deepEqual(acquisition.result.source, source);
    assert.match(acquisition.result.error, /Invalid self-upgrade tag source/);
    assert.equal(acquisition.calls, '');
  });

  it('makes the CLI check fail when its selected tag archive is unavailable', () => {
    const env = fakeGitHubEnvironment([{ name: '0.8.0' }], { downloadFailure: true });
    const result = spawnSync(process.execPath, [
      'cli/zylos.js', 'upgrade', '--self', '--check',
    ], {
      cwd: path.resolve('.'),
      env,
      encoding: 'utf8',
    });
    const calls = fs.readFileSync(env.FAKE_CURL_CALLS, 'utf8');

    assert.equal(result.status, 1);
    assert.match(result.stderr, /HeXiaobo\/zylos-core@0\.8\.0/);
    assert.match(calls, /archive\/refs\/tags\/0\.8\.0\.tar\.gz/);
    assert.doesNotMatch(calls, /archive\/refs\/heads\/main\.tar\.gz/);
  });

  it('keeps exact selected-tag provenance in JSON when acquisition fails', () => {
    const env = fakeGitHubEnvironment([{ name: '0.8.0' }], { downloadFailure: true });
    const result = spawnSync(process.execPath, [
      'cli/zylos.js', 'upgrade', '--self', '--check', '--json',
    ], {
      cwd: path.resolve('.'),
      env,
      encoding: 'utf8',
    });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 1);
    assert.equal(output.error, 'self_upgrade_download_failed');
    assert.deepEqual(output.source, {
      repo: 'HeXiaobo/zylos-core',
      policy: 'stable-only',
      tag: '0.8.0',
      ref: 'refs/tags/0.8.0',
    });
  });
});
