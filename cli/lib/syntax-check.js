import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const JAVASCRIPT_EXTENSIONS = new Set(['.cjs', '.js', '.mjs']);
const IGNORED_DIRECTORIES = new Set(['.backup', '.git', '.zylos', 'node_modules']);

function collectJavaScriptFiles(rootDir) {
  const files = [];

  function visit(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          visit(path.join(directory, entry.name));
        }
        continue;
      }
      if (entry.isFile() && JAVASCRIPT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(path.relative(rootDir, path.join(directory, entry.name)));
      }
    }
  }

  visit(rootDir);
  return files;
}

function readRootPackageType(rootDir) {
  const packagePath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(packagePath)) {
    return {
      status: 'UNMEASURABLE',
      reason: 'root package.json is missing; it must declare "type": "module" before this component can be validated with node --check',
    };
  }

  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch (error) {
    return {
      status: 'UNMEASURABLE',
      reason: `root package.json is invalid; this component cannot be validated with node --check: ${error.message}`,
    };
  }

  if (packageJson?.type !== 'module') {
    return {
      status: 'UNMEASURABLE',
      reason: `root package.json must declare "type": "module" before this component can be validated with node --check; found ${JSON.stringify(packageJson?.type ?? null)}`,
    };
  }

  return { status: 'PASS', packageType: 'module' };
}

function extractSyntaxError(output) {
  const match = output.match(/SyntaxError:\s*(.+)/);
  return match?.[1]?.trim() || output.split(/\r?\n/).find(Boolean) || 'node --check failed';
}

function extractLineNumber(output) {
  const match = output.match(/:(\d+)(?::\d+)?(?:\r?\n|$)/);
  return match ? Number(match[1]) : null;
}

function extractDuplicateIdentifier(output) {
  const match = output.match(/Identifier ['"]([^'"]+)['"] has already been declared/);
  return match?.[1] || null;
}

function formatFailure(failure) {
  const duplicate = failure.identifier
    ? `duplicate declaration ${JSON.stringify(failure.identifier)}`
    : 'node --check rejected the file';
  const line = failure.line ? ` at line ${failure.line}` : '';
  return `Syntax validation failed for ${failure.file}${line}: ${duplicate}\n${failure.raw}`;
}

/**
 * Validate every JavaScript file in a merged component tree without executing it.
 *
 * The root package must explicitly opt into ESM parsing. Without that invariant,
 * Node's syntax probe can accept ambiguous files or reject valid ESM as CommonJS,
 * so the result is deliberately UNMEASURABLE rather than PASS.
 *
 * @param {string} rootDir
 * @param {{ spawn?: Function, execPath?: string }} [deps]
 * @returns {{ status: 'PASS'|'FAIL'|'UNMEASURABLE'|'SKIPPED', checkedFiles: string[], failures: object[], packageType?: string, reason?: string, error?: string }}
 */
export function checkJavaScriptSyntax(rootDir, deps = {}) {
  const checkedFiles = collectJavaScriptFiles(rootDir);
  if (checkedFiles.length === 0) {
    return {
      status: 'SKIPPED',
      checkedFiles,
      failures: [],
      reason: 'no JavaScript files found',
    };
  }

  const packageType = readRootPackageType(rootDir);
  if (packageType.status !== 'PASS') {
    return {
      ...packageType,
      checkedFiles,
      failures: [],
    };
  }

  const spawn = deps.spawn ?? spawnSync;
  const execPath = deps.execPath ?? process.execPath;
  const failures = [];

  for (const file of checkedFiles) {
    const filePath = path.join(rootDir, file);
    let result;
    try {
      result = spawn(execPath, ['--check', filePath], {
        cwd: rootDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 300_000,
      });
    } catch (error) {
      result = { status: null, stdout: '', stderr: '', error };
    }

    const raw = [result?.stderr, result?.stdout]
      .filter(Boolean)
      .map(String)
      .join('\n')
      .trim();
    if (result?.status === 0 && !result?.error) continue;

    const failure = {
      file,
      status: result?.status ?? null,
      signal: result?.signal ?? null,
      line: extractLineNumber(raw),
      message: extractSyntaxError(raw),
      identifier: extractDuplicateIdentifier(raw),
      raw: raw || result?.error?.message || `node --check exited with status ${result?.status ?? 'unknown'}`,
    };
    failures.push(failure);
  }

  return {
    status: failures.length > 0 ? 'FAIL' : 'PASS',
    packageType: packageType.packageType,
    checkedFiles,
    failures,
    ...(failures.length > 0 ? { error: failures.map(formatFailure).join('\n') } : {}),
  };
}
