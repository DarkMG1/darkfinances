'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function assertNotSymlink(targetPath, label = 'path') {
  let stat;
  try {
    stat = fs.lstatSync(targetPath);
  } catch (cause) {
    if (cause?.code === 'ENOENT') return;
    throw cause;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: ${targetPath}`);
  }
}

function assertSafeParentDir(dir) {
  assertNotSymlink(dir, 'parent directory');
  if (!fs.existsSync(dir)) return;
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) throw new Error(`parent path is not a directory: ${dir}`);
}

function assertSafeOutputTarget(filePath) {
  assertNotSymlink(filePath, 'output target');
  if (!fs.existsSync(filePath)) return;
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) throw new Error(`output target must not be a symbolic link: ${filePath}`);
  if (stat.isDirectory()) throw new Error(`output target must not be a directory: ${filePath}`);
  if (stat.nlink > 1) throw new Error(`output target must not be a hard link: ${filePath}`);
}

function writePrivateFileAtomic(filePath, contents, { mode = 0o600, dirMode = 0o700 } = {}) {
  assertSafeOutputTarget(filePath);
  const dir = path.dirname(filePath);
  assertSafeParentDir(dir);
  fs.mkdirSync(dir, { recursive: true, mode: dirMode });
  assertNotSymlink(dir, 'output directory');
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  assertNotSymlink(tmp, 'temporary output file');
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeFileSync(fd, contents, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, filePath);
    fs.chmodSync(filePath, mode);
    try {
      const dirFd = fs.openSync(dir, 'r');
      fs.fsyncSync(dirFd);
      fs.closeSync(dirFd);
    } catch (_) {
      // Some filesystems do not support directory fsync.
    }
  } catch (cause) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw cause;
  }
}

module.exports = {
  assertNotSymlink,
  assertSafeOutputTarget,
  writePrivateFileAtomic,
};
