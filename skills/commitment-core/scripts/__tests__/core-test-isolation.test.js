import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);

function listTestFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listTestFiles(entryPath));
    else if (/\.(?:test|spec)\.js$/.test(entry.name)) files.push(entryPath);
  }
  return files;
}

function skipQuoted(source, start, quote) {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === '\\') index += 1;
    else if (source[index] === quote) return index + 1;
  }
  return source.length;
}

function skipTrivia(source, start) {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index])) index += 1;
    else if (source.startsWith('//', index)) {
      index = source.indexOf('\n', index + 2);
      if (index === -1) return source.length;
    } else if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      if (end === -1) return source.length;
      index = end + 2;
    } else break;
  }
  return index;
}

function readCallArguments(source, openParenthesis) {
  let depth = 1;
  for (let index = openParenthesis + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "'" || character === '"' || character === '`') {
      index = skipQuoted(source, index, character) - 1;
    } else if (source.startsWith('//', index)) {
      index = source.indexOf('\n', index + 2);
      if (index === -1) break;
    } else if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      if (end === -1) break;
      index = end + 1;
    } else if (character === '(') depth += 1;
    else if (character === ')' && --depth === 0) {
      return { argumentsSource: source.slice(openParenthesis + 1, index), end: index + 1 };
    }
  }
  throw new Error('unterminated openCommitmentCore call in test source');
}

function findCoreOpenCalls(source) {
  const calls = [];
  const identifier = 'openCommitmentCore';
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (character === "'" || character === '"' || character === '`') {
      index = skipQuoted(source, index, character);
    } else if (source.startsWith('//', index) || source.startsWith('/*', index)) {
      index = skipTrivia(source, index);
    } else if (
      source.startsWith(identifier, index)
      && !/[\w$]/.test(source[index - 1] || '')
      && !/[\w$]/.test(source[index + identifier.length] || '')
    ) {
      const openParenthesis = skipTrivia(source, index + identifier.length);
      if (source[openParenthesis] !== '(') {
        index += identifier.length;
        continue;
      }
      const call = readCallArguments(source, openParenthesis);
      calls.push({ ...call, offset: index });
      index = call.end;
    } else index += 1;
  }
  return calls;
}

test('every Commitment Core test opens an explicit file database under a test temp directory', () => {
  const violations = [];
  for (const file of listTestFiles(REPOSITORY_ROOT)) {
    const source = readFileSync(file, 'utf8');
    for (const call of findCoreOpenCalls(source)) {
      const line = source.slice(0, call.offset).split('\n').length;
      const argumentsSource = call.argumentsSource.trim();
      if (!argumentsSource.startsWith('{')) {
        violations.push(`${path.relative(REPOSITORY_ROOT, file)}:${line} must pass an object literal`);
      } else if (!/\bdbPath\b/.test(argumentsSource)) {
        violations.push(`${path.relative(REPOSITORY_ROOT, file)}:${line} must pass dbPath explicitly`);
      } else if (/\bdbPath\s*:\s*['"]:memory:['"]/.test(argumentsSource)) {
        violations.push(`${path.relative(REPOSITORY_ROOT, file)}:${line} must not use :memory:`);
      }
      if (!/\b(?:fs\.)?mkdtempSync\s*\(/.test(source)) {
        violations.push(`${path.relative(REPOSITORY_ROOT, file)}:${line} must use mkdtempSync`);
      }
    }
  }
  assert.deepEqual(violations, []);
});
