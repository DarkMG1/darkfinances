#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;

function parseArgs(argv) {
  const parsed = { allowedHosts: [] };
  for (const arg of argv) {
    if (arg.startsWith('--allowed-host=')) {
      parsed.allowedHosts.push(arg.slice('--allowed-host='.length));
      continue;
    }
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) throw new Error(`unsupported argument: ${arg}`);
    parsed[match[1]] = match[2];
  }
  if (!parsed.url || !parsed.output || !parsed.sha256) {
    throw new Error('usage: toolchain-download.js --url=URL --output=PATH --sha256=DIGEST [--allowed-host=HOST ...] [--max-bytes=N]');
  }
  parsed.maxBytes = parsed['max-bytes'] ? Number(parsed['max-bytes']) : DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(parsed.maxBytes) || parsed.maxBytes <= 0) {
    throw new Error('max-bytes must be a positive safe integer');
  }
  if (!/^[a-f0-9]{64}$/.test(parsed.sha256)) throw new Error('sha256 must be lowercase hex');
  if (parsed.allowedHosts.length === 0) throw new Error('at least one --allowed-host is required');
  return parsed;
}

function assertAllowedHost(hostname, allowedHosts) {
  if (!allowedHosts.includes(hostname)) {
    throw new Error(`refusing host outside allowlist (${allowedHosts.join(', ')}): ${hostname}`);
  }
}

async function downloadBounded(urlString, {
  fetchImpl = globalThis.fetch,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  maxBytes = DEFAULT_MAX_BYTES,
  allowedHosts,
} = {}) {
  if (!fetchImpl) throw new Error('fetch implementation is required');
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) {
    throw new Error('allowedHosts must be a non-empty array');
  }
  let current = new URL(urlString);
  assertAllowedHost(current.hostname, allowedHosts);
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    if (current.protocol !== 'https:') throw new Error(`refusing insecure URL: ${current.href}`);
    assertAllowedHost(current.hostname, allowedHosts);
    const response = await fetchImpl(current.href, { redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`redirect missing location from ${current.href}`);
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`download failed (${response.status}) from ${current.href}`);
    const reader = response.body?.getReader?.();
    if (!reader) {
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.length > maxBytes) throw new Error(`download exceeds size bound (${maxBytes} bytes)`);
      return buffer;
    }
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) throw new Error(`download exceeds size bound (${maxBytes} bytes)`);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  throw new Error('download exceeded redirect limit');
}

function atomicWriteFile(targetPath, buffer) {
  const directory = path.dirname(targetPath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, buffer);
  fs.renameSync(tempPath, targetPath);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const buffer = await downloadBounded(args.url, {
    allowedHosts: args.allowedHosts,
    maxBytes: args.maxBytes,
  });
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  if (digest !== args.sha256) {
    throw new Error(`SHA-256 mismatch: expected ${args.sha256}, got ${digest}`);
  }
  atomicWriteFile(path.resolve(args.output), buffer);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`toolchain-download: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_REDIRECTS,
  assertAllowedHost,
  atomicWriteFile,
  downloadBounded,
  parseArgs,
};
