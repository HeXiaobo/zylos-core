import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, it } from 'node:test';

const origEnv = {};
for (const key of ['ZYLOS_GH_RETRY_DELAY_MS', 'GITHUB_TOKEN', 'GH_TOKEN', 'PATH']) {
  origEnv[key] = process.env[key];
}
const tmpDirs = [];

const { downloadArchive, downloadBranch } = await import('../download.js');

beforeEach(() => {
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
});

afterEach(() => {
  for (const [key, value] of Object.entries(origEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

// Fake curl that always fails with the given status; fake gh that reports no
// auth, so getGitHubToken() resolves to null on its first (cached) probe.
function installFailingCurl({ status }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-download-fake-'));
  tmpDirs.push(dir);
  const callsFile = path.join(dir, 'calls');
  const script = `#!/bin/sh
n=$(cat "${callsFile}" 2>/dev/null || echo 0)
n=$((n+1))
echo $n > "${callsFile}"
echo "curl: (22) The requested URL returned error: ${status}" >&2
exit 22
`;
  fs.writeFileSync(path.join(dir, 'curl'), script, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
  return {
    calls: () => {
      if (!fs.existsSync(callsFile)) return 0;
      return Number(fs.readFileSync(callsFile, 'utf8').trim());
    },
  };
}

function makeDestDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-download-dest-'));
  tmpDirs.push(dir);
  return dir;
}

describe('downloadArchive no-token fallback (fake curl on PATH)', () => {
  it('makes exactly one public request per failed no-token attempt and surfaces the error (#705)', () => {
    process.env.ZYLOS_GH_RETRY_DELAY_MS = '';
    const fake = installFailingCurl({ status: '404' });

    const result = downloadArchive('org/repo', '1.0.0', makeDestDir());

    assert.equal(result.success, false);
    assert.match(result.error, /404/);
    assert.equal(fake.calls(), 1);
  });

  it('retries no-token rate limiting via the outer loop only (#705)', () => {
    process.env.ZYLOS_GH_RETRY_DELAY_MS = '0';
    const fake = installFailingCurl({ status: '403' });

    const result = downloadArchive('org/repo', '1.0.0', makeDestDir());

    assert.equal(result.success, false);
    assert.match(result.error, /403/);
    // 1 public call per retry round: initial attempt + one configured retry
    assert.equal(fake.calls(), 2);
  });
});

describe('immutable commit downloads', () => {
  it('downloads a full commit SHA through the immutable archive URL', () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-download-commit-fixture-'));
    const archiveRoot = path.join(fixtureDir, 'repo-commit');
    const archivePath = path.join(fixtureDir, 'archive.tar.gz');
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-download-commit-bin-'));
    const callsPath = path.join(fakeBin, 'curl.calls');
    tmpDirs.push(fixtureDir, fakeBin);

    fs.mkdirSync(archiveRoot, { recursive: true });
    fs.writeFileSync(path.join(archiveRoot, 'package.json'), '{"name":"fixture"}\n');
    execFileSync('tar', ['czf', archivePath, '-C', fixtureDir, 'repo-commit']);
    fs.writeFileSync(path.join(fakeBin, 'curl'), `#!/bin/sh
printf '%s\n' "$@" > "${callsPath}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    cp "${archivePath}" "$2"
    exit 0
  fi
  shift
done
exit 2
`, { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH}`;

    const sha = '0123456789abcdef0123456789abcdef01234567';
    const destDir = makeDestDir();
    const result = downloadBranch('org/repo', sha, destDir);

    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(fs.existsSync(path.join(destDir, 'package.json')), true);
    assert.match(
      fs.readFileSync(callsPath, 'utf8'),
      new RegExp(`https://github\\.com/org/repo/archive/${sha}\\.tar\\.gz`),
    );
  });
});
