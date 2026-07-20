const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class JsonStoreError extends Error {
  constructor(message, { code = 'JSON_STORE_ERROR', file, cause } = {}) {
    super(message, { cause });
    this.name = 'JsonStoreError';
    this.code = code;
    this.file = file;
  }
}

const quarantined = new Set();

function cloneFallback(value) {
  if (value == null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

const { writePrivateFileAtomic } = require('./private-durable-io');

function writePrivateFileAtomicWrapped(file, contents) {
  try {
    writePrivateFileAtomic(file, contents);
  } catch (cause) {
    throw new JsonStoreError(`Could not atomically write ${path.basename(file)}`, {
      code: 'JSON_WRITE_FAILED',
      file,
      cause,
    });
  }
}

function quarantineCorruptFile(file) {
  if (quarantined.has(file)) return;
  quarantined.add(file);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const quarantine = `${file}.corrupt-${stamp}`;
  try {
    fs.copyFileSync(file, quarantine, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(quarantine, 0o600);
  } catch (_) {
    // Keep the original in place even if the diagnostic copy cannot be made.
  }
}

function readJsonFile(file, fallback, validate) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (cause) {
    if (cause && cause.code === 'ENOENT') return cloneFallback(fallback);
    throw new JsonStoreError(`Could not read ${path.basename(file)}`, {
      code: 'JSON_READ_FAILED',
      file,
      cause,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    quarantineCorruptFile(file);
    throw new JsonStoreError(`Refusing to overwrite corrupt JSON in ${path.basename(file)}`, {
      code: 'JSON_CORRUPT',
      file,
      cause,
    });
  }

  if (validate && !validate(parsed)) {
    quarantineCorruptFile(file);
    throw new JsonStoreError(`Unexpected JSON shape in ${path.basename(file)}`, {
      code: 'JSON_INVALID_SHAPE',
      file,
    });
  }
  return parsed;
}

function writeJsonFile(file, value) {
  let serialized;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch (cause) {
    throw new JsonStoreError(`Could not serialize ${path.basename(file)}`, {
      code: 'JSON_SERIALIZE_FAILED',
      file,
      cause,
    });
  }
  if (serialized === undefined) {
    throw new JsonStoreError(`Cannot serialize undefined into ${path.basename(file)}`, {
      code: 'JSON_SERIALIZE_FAILED',
      file,
    });
  }

  if (fs.existsSync(file)) {
    try {
      const current = fs.readFileSync(file, 'utf8');
      JSON.parse(current);
      writePrivateFileAtomicWrapped(`${file}.last-good`, current);
    } catch (cause) {
      if (cause instanceof SyntaxError) quarantineCorruptFile(file);
      throw new JsonStoreError(`Refusing to replace unreadable JSON in ${path.basename(file)}`, {
        code: cause instanceof SyntaxError ? 'JSON_CORRUPT' : 'JSON_READ_FAILED',
        file,
        cause,
      });
    }
  }

  writePrivateFileAtomicWrapped(file, `${serialized}\n`);
}

module.exports = {
  JsonStoreError,
  quarantineCorruptFile,
  readJsonFile,
  writeJsonFile,
};
