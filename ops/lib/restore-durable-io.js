'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIRECTORY_FSYNC_UNSUPPORTED_CODES = new Set(['EOPNOTSUPP', 'ENOTSUP', 'ENOSYS']);

function createFsyncOptions(options = {}) {
  return {
    onDirectoryFsyncUnsupported: options.onDirectoryFsyncUnsupported || null,
  };
}

function shouldIgnoreDirectoryFsyncError(error, options = {}) {
  if (process.platform === 'linux') return false;
  if (!DIRECTORY_FSYNC_UNSUPPORTED_CODES.has(error.code)) return false;
  options.onDirectoryFsyncUnsupported?.(error.path || null, error);
  return true;
}

function fsyncPath(targetPath, isDirectory = false, options = {}) {
  if (typeof fs.openSync !== 'function') return;
  const fsyncOptions = createFsyncOptions(options);
  const flag = isDirectory ? fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) : fs.constants.O_RDONLY;
  let fd;
  try {
    fd = fs.openSync(targetPath, flag);
    fs.fsyncSync(fd);
  } catch (error) {
    error.path = targetPath;
    if (isDirectory && shouldIgnoreDirectoryFsyncError(error, fsyncOptions)) {
      return;
    }
    throw error;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

function fsyncFile(filePath, options = {}) {
  if (typeof fs.fsyncSync !== 'function') return;
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } catch (error) {
    error.path = filePath;
    throw error;
  } finally {
    fs.closeSync(fd);
  }
}

function writeFileAtomic(filePath, payload, mode = 0o600, injectFault = null, fsyncOptions = {}) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  injectFault?.('before:atomic-write', filePath);
  fs.writeFileSync(temp, payload, { mode });
  injectFault?.('before:atomic-fsync-temp', filePath);
  fsyncFile(temp, fsyncOptions);
  injectFault?.('after:atomic-fsync-temp', filePath);
  injectFault?.('before:atomic-rename', filePath);
  fs.renameSync(temp, filePath);
  injectFault?.('after:atomic-rename', filePath);
  fsyncFile(filePath, fsyncOptions);
  injectFault?.('before:atomic-fsync-dir', filePath);
  fsyncPath(dir, true, fsyncOptions);
  injectFault?.('after:atomic-fsync-dir', filePath);
}

function publishFileDurable(finalPath, stagingPath, mode = 0o600, injectFault = null, fsyncOptions = {}) {
  injectFault?.('before:publish-fsync-staging', finalPath);
  fsyncFile(stagingPath, fsyncOptions);
  injectFault?.('after:publish-fsync-staging', finalPath);
  injectFault?.('before:publish-rename', finalPath);
  fs.renameSync(stagingPath, finalPath);
  injectFault?.('after:publish-rename', finalPath);
  fs.chmodSync(finalPath, mode);
  injectFault?.('before:publish-fsync-final', finalPath);
  fsyncFile(finalPath, fsyncOptions);
  injectFault?.('after:publish-fsync-final', finalPath);
  injectFault?.('before:publish-fsync-dir', finalPath);
  fsyncPath(path.dirname(finalPath), true, fsyncOptions);
  injectFault?.('after:publish-fsync-dir', finalPath);
}

function publishSidecarFromStaging(finalPath, stagingPath, mode = 0o600, injectFault = null, fsyncOptions = {}) {
  writeFileAtomic(finalPath, fs.readFileSync(stagingPath), mode, injectFault, fsyncOptions);
}

function writeChecksumSidecarDurable(archivePath, injectFault = null, fsyncOptions = {}) {
  const checksum = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
  const checksumPath = `${archivePath}.sha256`;
  const payload = `${checksum}  ${path.basename(archivePath)}\n`;
  injectFault?.('before:checksum-sidecar', checksumPath);
  writeFileAtomic(checksumPath, payload, 0o600, injectFault, fsyncOptions);
  injectFault?.('after:checksum-sidecar', checksumPath);
  return checksum;
}

function fsyncPublishedFile(filePath, injectFault = null, fsyncOptions = {}) {
  injectFault?.('before:published-fsync-file', filePath);
  fsyncFile(filePath, fsyncOptions);
  injectFault?.('after:published-fsync-file', filePath);
  injectFault?.('before:published-fsync-dir', filePath);
  fsyncPath(path.dirname(filePath), true, fsyncOptions);
  injectFault?.('after:published-fsync-dir', filePath);
}

module.exports = {
  DIRECTORY_FSYNC_UNSUPPORTED_CODES,
  fsyncPath,
  fsyncFile,
  writeFileAtomic,
  publishFileDurable,
  publishSidecarFromStaging,
  writeChecksumSidecarDurable,
  fsyncPublishedFile,
};
