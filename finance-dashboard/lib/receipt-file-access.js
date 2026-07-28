'use strict';

const fs = require('fs');
const path = require('path');
const { AppError } = require('./errors');

class ReceiptFileAccessError extends AppError {
  constructor(message = 'Receipt not found', { code = 'NOT_FOUND', status = 404, cause } = {}) {
    super(message, { code, status, expose: status < 500, cause });
    this.name = 'ReceiptFileAccessError';
  }
}

class ReceiptImageFormatError extends AppError {
  constructor(message = 'Receipt image format is not supported') {
    super(message, {
      code: 'UNSUPPORTED_MEDIA_TYPE',
      status: 415,
      expose: true,
    });
    this.name = 'ReceiptImageFormatError';
  }
}

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heif']);

const STORED_MIME_TO_FORMAT = Object.freeze({
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heif',
  'image/heif': 'heif',
});

function normalizeReceiptBasename(file) {
  if (!file || typeof file !== 'string') return null;
  const basename = path.basename(file);
  if (basename !== file || basename.includes('/') || basename.includes('\\')) return null;
  if (!basename || basename === '.' || basename === '..') return null;
  return basename;
}

function resolveReceiptsRoot(receiptsDir) {
  if (!receiptsDir || typeof receiptsDir !== 'string') {
    throw new ReceiptFileAccessError('Receipt storage is unavailable', {
      code: 'RECEIPT_STORAGE_UNAVAILABLE',
      status: 500,
    });
  }
  let realRoot;
  try {
    realRoot = fs.realpathSync(receiptsDir);
  } catch (cause) {
    throw new ReceiptFileAccessError('Receipt storage is unavailable', {
      code: 'RECEIPT_STORAGE_UNAVAILABLE',
      status: 500,
      cause,
    });
  }
  const rootStat = fs.lstatSync(realRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new ReceiptFileAccessError('Receipt storage is unavailable', {
      code: 'RECEIPT_STORAGE_UNAVAILABLE',
      status: 500,
    });
  }
  return { realRoot, rootStat };
}

function assertContainedRegularFile(realRoot, candidate, preOpenStat) {
  const relative = path.relative(realRoot, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ReceiptFileAccessError('Receipt not found');
  }
  let realFile;
  try {
    realFile = fs.realpathSync(candidate);
  } catch (cause) {
    if (cause?.code === 'ENOENT') throw new ReceiptFileAccessError('Receipt not found', { cause });
    throw new ReceiptFileAccessError('Receipt storage is unavailable', {
      code: 'RECEIPT_STORAGE_UNAVAILABLE',
      status: 500,
      cause,
    });
  }
  const contained = path.relative(realRoot, realFile);
  if (contained === '..' || contained.startsWith(`..${path.sep}`) || path.isAbsolute(contained)) {
    throw new ReceiptFileAccessError('Receipt not found');
  }
  if (!preOpenStat.isFile()) {
    throw new ReceiptFileAccessError('Receipt not found');
  }
  return { realFile, preOpenStat };
}

function sniffReceiptImageFormat(header) {
  if (!header || header.length < 12) return null;
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'jpeg';
  if (header.length >= 8
    && header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47
    && header[4] === 0x0d && header[5] === 0x0a && header[6] === 0x1a && header[7] === 0x0a) {
    return 'png';
  }
  if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp';
  }
  if (header.toString('ascii', 4, 8) === 'ftyp') {
    const brand = header.toString('ascii', 8, 12);
    if (HEIF_BRANDS.has(brand)) return 'heif';
  }
  return null;
}

function readReceiptHeaderAtOffsetZero(fd, dependencies = {}) {
  const readSync = dependencies.readSync || fs.readSync;
  const buffer = Buffer.alloc(32);
  const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
  return buffer.subarray(0, bytesRead);
}

function assertStoredMimeMatchesSniff(storedMime, detectedFormat) {
  const normalizedMime = String(storedMime || '').toLowerCase();
  const expectedFormat = STORED_MIME_TO_FORMAT[normalizedMime];
  if (!expectedFormat || !detectedFormat || expectedFormat !== detectedFormat) {
    throw new ReceiptImageFormatError();
  }
}

/**
 * Sniffs magic bytes from offset 0 on a verified descriptor and ensures they
 * match the stored MIME before streaming.
 */
function verifyReceiptImageContent(handle, storedMime, dependencies = {}) {
  if (!handle || handle.fd === undefined) throw new ReceiptFileAccessError('Receipt not found');
  const header = readReceiptHeaderAtOffsetZero(handle.fd, dependencies);
  const detectedFormat = sniffReceiptImageFormat(header);
  if (!detectedFormat) throw new ReceiptImageFormatError();
  assertStoredMimeMatchesSniff(storedMime, detectedFormat);
  return { format: detectedFormat, mime: String(storedMime || '').toLowerCase() };
}

function openVerifiedReceiptFile(receiptsDir, file, dependencies = {}) {
  const basename = normalizeReceiptBasename(file);
  if (!basename) throw new ReceiptFileAccessError('Receipt not found');

  const { realRoot, rootStat } = resolveReceiptsRoot(receiptsDir);
  const candidate = path.resolve(realRoot, basename);

  let preOpenStat;
  try {
    preOpenStat = fs.lstatSync(candidate);
  } catch (cause) {
    if (cause?.code === 'ENOENT') throw new ReceiptFileAccessError('Receipt not found', { cause });
    throw new ReceiptFileAccessError('Receipt storage is unavailable', {
      code: 'RECEIPT_STORAGE_UNAVAILABLE',
      status: 500,
      cause,
    });
  }
  if (preOpenStat.isSymbolicLink()) {
    throw new ReceiptFileAccessError('Receipt not found');
  }

  const { realFile, preOpenStat: pathStat } = assertContainedRegularFile(realRoot, candidate, preOpenStat);

  const openSync = dependencies.openSync || fs.openSync;
  const fstatSync = dependencies.fstatSync || fs.fstatSync;
  const noFollow = fs.constants.O_NOFOLLOW;
  if (!noFollow) {
    throw new ReceiptFileAccessError('Receipt storage is unavailable', {
      code: 'RECEIPT_STORAGE_UNAVAILABLE',
      status: 500,
      cause: new Error('secure receipt reads require O_NOFOLLOW support'),
    });
  }
  const nonBlock = fs.constants.O_NONBLOCK || 0;
  let fd;
  try {
    fd = openSync(realFile, fs.constants.O_RDONLY | noFollow | nonBlock);
    const fdStat = fstatSync(fd);
    if (!fdStat.isFile()) {
      throw new ReceiptFileAccessError('Receipt not found');
    }
    if (fdStat.dev !== pathStat.dev || fdStat.ino !== pathStat.ino) {
      throw new ReceiptFileAccessError('Receipt not found');
    }
    if (fdStat.nlink > 1) {
      throw new ReceiptFileAccessError('Receipt not found');
    }
    const afterRoot = fs.lstatSync(realRoot);
    if (
      !afterRoot.isDirectory()
      || afterRoot.isSymbolicLink()
      || afterRoot.dev !== rootStat.dev
      || afterRoot.ino !== rootStat.ino
    ) {
      throw new ReceiptFileAccessError('Receipt not found');
    }
    return {
      fd,
      size: fdStat.size,
      path: realFile,
      basename,
      dev: fdStat.dev,
      ino: fdStat.ino,
    };
  } catch (cause) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    if (cause instanceof ReceiptFileAccessError) throw cause;
    if (cause?.code === 'ENOENT') throw new ReceiptFileAccessError('Receipt not found', { cause });
    throw new ReceiptFileAccessError('Receipt storage is unavailable', {
      code: 'RECEIPT_STORAGE_UNAVAILABLE',
      status: 500,
      cause,
    });
  }
}

function closeReceiptFileHandle(handle) {
  if (!handle || handle.fd === undefined) return;
  try {
    fs.closeSync(handle.fd);
  } catch (_) {}
  handle.fd = undefined;
}

function createReceiptFileReadStream(handle, dependencies = {}) {
  if (!handle || handle.fd === undefined) {
    throw new ReceiptFileAccessError('Receipt not found');
  }
  const createReadStream = dependencies.createReadStream || fs.createReadStream;
  return createReadStream(null, { fd: handle.fd, start: 0, autoClose: false });
}

module.exports = {
  ReceiptFileAccessError,
  ReceiptImageFormatError,
  closeReceiptFileHandle,
  createReceiptFileReadStream,
  normalizeReceiptBasename,
  openVerifiedReceiptFile,
  resolveReceiptsRoot,
  sniffReceiptImageFormat,
  verifyReceiptImageContent,
};
