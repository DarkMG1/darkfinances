'use strict';

const fs = require('fs');

function fsyncPath(targetPath, isDirectory = false) {
  if (typeof fs.openSync !== 'function') return;
  const flag = isDirectory ? fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) : fs.constants.O_RDONLY;
  let fd;
  try {
    fd = fs.openSync(targetPath, flag);
    fs.fsyncSync(fd);
  } catch {
    // Some platforms disallow directory fsync; best-effort only.
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

function fsyncFile(filePath) {
  if (typeof fs.fsyncSync !== 'function') return;
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeFileAtomic(filePath, payload, mode = 0o600) {
  const dir = require('path').dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, payload, { mode });
  fsyncFile(temp);
  fs.renameSync(temp, filePath);
  fsyncFile(filePath);
  fsyncPath(dir, true);
}

module.exports = {
  fsyncPath,
  fsyncFile,
  writeFileAtomic,
};
