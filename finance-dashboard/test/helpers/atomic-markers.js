'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function testMarkersEnabled() {
  return process.env.NODE_ENV === 'test';
}

function markerPath(dir, name) {
  return path.join(dir, `${name}.json`);
}

function writeAtomicJsonMarker(dir, name, payload) {
  if (!testMarkersEnabled()) {
    throw new Error(`atomic-markers: refused outside NODE_ENV=test (${name})`);
  }
  if (!dir) {
    throw new Error(`atomic-markers: missing marker directory (${name})`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = markerPath(dir, name);
  const tmpPath = path.join(
    dir,
    `.${name}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
  );
  const body = `${JSON.stringify(payload)}\n`;
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, body, 0, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, finalPath);
}

function readAtomicJsonMarker(dir, name) {
  const finalPath = markerPath(dir, name);
  let raw;
  try {
    raw = fs.readFileSync(finalPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!raw.trim()) return null;
  return JSON.parse(raw);
}

async function waitForAtomicJsonMarker(dir, name, {
  timeoutMs = 5_000,
  predicate = null,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = readAtomicJsonMarker(dir, name);
      if (value != null && (predicate == null || predicate(value))) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (lastError) throw lastError;
  return null;
}

module.exports = {
  markerPath,
  readAtomicJsonMarker,
  waitForAtomicJsonMarker,
  writeAtomicJsonMarker,
};
