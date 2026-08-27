import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function fsyncDirectory(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (err) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(err.code)) throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function atomicWriteJson(filePath, value, { mode } = {}) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const targetMode = mode ?? (() => {
    try { return fs.statSync(filePath).mode & 0o777; } catch { return 0o600; }
  })();
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx', targetMode);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, filePath);
    fsyncDirectory(dir);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    fs.rmSync(tempPath, { force: true });
    throw err;
  }
}

export function removeDurably(filePath) {
  const dir = path.dirname(filePath);
  fs.rmSync(filePath, { force: true });
  if (fs.existsSync(dir)) fsyncDirectory(dir);
}
