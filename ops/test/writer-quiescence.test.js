'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const {
  ACTUAL_GENERATION_PREFIX,
  ACTUAL_GENERATION_VERSION,
  actualGenerationVersion,
  assertActualGenerationStable,
  computeActualDataGeneration,
} = require('../lib/writer-quiescence');

function mkRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('Actual generation v2 separates legacy path/content concatenation collisions', (t) => {
  const left = mkRoot(t, 'darkfinances-actual-collision-left-');
  const right = mkRoot(t, 'darkfinances-actual-collision-right-');
  fs.writeFileSync(path.join(left, 'a'), 'bc', { mode: 0o600 });
  fs.writeFileSync(path.join(right, 'ab'), 'c', { mode: 0o600 });

  const legacyLeft = computeActualDataGeneration(left, { version: 1 });
  const legacyRight = computeActualDataGeneration(right, { version: 1 });
  assert.equal(legacyLeft, legacyRight, 'fixture must reproduce the legacy concatenation collision');

  const currentLeft = computeActualDataGeneration(left);
  const currentRight = computeActualDataGeneration(right);
  assert.match(currentLeft, new RegExp(`^${ACTUAL_GENERATION_PREFIX}[a-f0-9]{64}$`));
  assert.notEqual(currentLeft, currentRight);
  assert.equal(actualGenerationVersion(currentLeft), ACTUAL_GENERATION_VERSION);
  assert.equal(actualGenerationVersion(legacyLeft), 1);
  assert.equal(assertActualGenerationStable(left, currentLeft), currentLeft);
  assert.equal(assertActualGenerationStable(left, legacyLeft), legacyLeft);
});

test('Actual generation v2 binds empty directories, type-independent mode, size, and content', (t) => {
  const root = mkRoot(t, 'darkfinances-actual-records-');
  const emptyRootGeneration = computeActualDataGeneration(root);

  const emptyDirectory = path.join(root, 'empty');
  fs.mkdirSync(emptyDirectory, { mode: 0o700 });
  const withEmptyDirectory = computeActualDataGeneration(root);
  assert.notEqual(withEmptyDirectory, emptyRootGeneration);

  fs.chmodSync(emptyDirectory, 0o750);
  const withModeChange = computeActualDataGeneration(root);
  assert.notEqual(withModeChange, withEmptyDirectory);

  const data = path.join(root, 'db');
  fs.writeFileSync(data, 'one', { mode: 0o600 });
  const withFile = computeActualDataGeneration(root);
  fs.writeFileSync(data, 'two-two', { mode: 0o600 });
  const withSizeAndContentChange = computeActualDataGeneration(root);
  assert.notEqual(withSizeAndContentChange, withFile);

  fs.writeFileSync(data, 'changed', { mode: 0o600 });
  const sameSizeContentChange = computeActualDataGeneration(root);
  assert.notEqual(sameSizeContentChange, withSizeAndContentChange);
});

test('Actual generation rejects symlinks and unsupported filesystem entry types', {
  skip: process.platform === 'win32' ? 'Unix sockets and symlinks are POSIX-specific' : false,
}, async (t) => {
  const root = mkRoot(t, 'darkfinances-actual-types-');
  const target = path.join(root, 'db');
  const link = path.join(root, 'db-link');
  fs.writeFileSync(target, 'data', { mode: 0o600 });
  fs.symlinkSync(target, link);
  assert.throws(() => computeActualDataGeneration(root), /contains symlink/);
  fs.rmSync(link);

  const socketPath = path.join(root, 'actual.sock');
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  try {
    assert.throws(() => computeActualDataGeneration(root), /unsupported type/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Actual generation rejects Unicode-normalized path collisions', {
  skip: process.platform !== 'linux' ? 'fixture requires a non-normalizing filesystem' : false,
}, (t) => {
  const root = mkRoot(t, 'darkfinances-actual-unicode-collision-');
  fs.writeFileSync(path.join(root, '\u00e9'), 'left', { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'e\u0301'), 'right', { mode: 0o600 });
  assert.throws(() => computeActualDataGeneration(root), /normalized path collision/);
});

test('Actual generation hashing propagates descriptor metadata race failures', (t) => {
  const root = mkRoot(t, 'darkfinances-actual-race-');
  fs.writeFileSync(path.join(root, 'db'), 'data', { mode: 0o600 });
  let fstatCalls = 0;
  assert.throws(
    () => computeActualDataGeneration(root, {
      dependencies: {
        fstatSync(descriptor) {
          const stat = fs.fstatSync(descriptor);
          fstatCalls += 1;
          return fstatCalls === 2
            ? Object.assign(stat, { mtimeMs: stat.mtimeMs + 1 })
            : stat;
        },
      },
    }),
    /metadata changed while it was being read/,
  );
});
