'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  readTrustedRegularFile,
  resolveTrustedOpenFlags,
} = require('../../finance-dashboard/lib/trusted-regular-file-read');

const temporaryDirectories = [];

test.after(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

test('readTrustedRegularFile requires a positive safe integer maxBytes', () => {
  const root = tempDir('trusted-read-maxbytes-');
  const filePath = path.join(root, 'file.txt');
  fs.writeFileSync(filePath, 'hello\n', { mode: 0o600 });
  assert.throws(
    () => readTrustedRegularFile(filePath, { label: 'test file', allowedModes: [0o600] }),
    /maxBytes must be a positive safe integer/,
  );
  assert.throws(
    () => readTrustedRegularFile(filePath, { label: 'test file', maxBytes: 0, allowedModes: [0o600] }),
    /maxBytes must be a positive safe integer/,
  );
});

test('readTrustedRegularFile rejects invalid allowedModes', () => {
  const root = tempDir('trusted-read-modes-');
  const filePath = path.join(root, 'file.txt');
  fs.writeFileSync(filePath, 'hello\n', { mode: 0o600 });
  assert.throws(
    () => readTrustedRegularFile(filePath, { label: 'test file', maxBytes: 16, allowedModes: [] }),
    /allowedModes must be a non-empty array/,
  );
});

test('resolveTrustedOpenFlags requires O_NOFOLLOW or fails closed', () => {
  if (fs.constants.O_NOFOLLOW) {
    assert.ok(resolveTrustedOpenFlags());
    return;
  }
  assert.throws(() => resolveTrustedOpenFlags(), /O_NOFOLLOW support/);
});

test('readTrustedRegularFile rejects path swap, short read, and metadata races', () => {
  const root = tempDir('trusted-read-races-');
  const filePath = path.join(root, 'token.json');
  fs.writeFileSync(filePath, '{"ok":true}\n', { mode: 0o600 });
  const readOptions = {
    label: 'test file',
    maxBytes: 1024,
    allowedModes: [0o600],
  };

  assert.throws(
    () => readTrustedRegularFile(filePath, readOptions, {
      fstatSync(descriptor) {
        const opened = fs.fstatSync(descriptor);
        return Object.assign(opened, { ino: opened.ino + 1 });
      },
    }),
    /changed before it could be read/,
  );

  assert.throws(
    () => readTrustedRegularFile(filePath, readOptions, {
      readSync(descriptor, buffer, offset, length, position) {
        if (offset === 0) return 1;
        return 0;
      },
    }),
    /changed while it was being read/,
  );

  let pathStats = 0;
  let fstatCalls = 0;
  assert.throws(
    () => readTrustedRegularFile(filePath, readOptions, {
      lstatSync(target) {
        const stat = fs.lstatSync(target);
        if (target === filePath) {
          pathStats += 1;
          if (pathStats >= 2) {
            return Object.assign(stat, { ino: stat.ino + 1 });
          }
        }
        return stat;
      },
    }),
    /path changed while it was being read/,
  );

  assert.throws(
    () => readTrustedRegularFile(filePath, readOptions, {
      fstatSync(descriptor) {
        const opened = fs.fstatSync(descriptor);
        fstatCalls += 1;
        if (fstatCalls >= 2) {
          return Object.assign(opened, { mtimeMs: opened.mtimeMs + 1 });
        }
        return opened;
      },
    }),
    /changed while it was being read/,
  );
});

test('readTrustedRegularFile rejects post-open mode and hard-link changes where observable', {
  skip: process.platform === 'win32' ? 'POSIX-specific nlink semantics' : false,
}, () => {
  const root = tempDir('trusted-read-postopen-');
  const filePath = path.join(root, 'secret.json');
  fs.writeFileSync(filePath, '{"ok":true}\n', { mode: 0o600 });
  const readOptions = {
    label: 'test file',
    maxBytes: 1024,
    allowedModes: [0o600],
  };

  assert.throws(
    () => readTrustedRegularFile(filePath, readOptions, {
      fstatSync(descriptor) {
        const opened = fs.fstatSync(descriptor);
        if ((opened.mode & 0o777) === 0o600) {
          return Object.assign(opened, { mode: (opened.mode & ~0o777) | 0o644 });
        }
        return opened;
      },
    }),
    /permissions must be 600/,
  );

  const hardLink = path.join(root, 'linked.json');
  fs.linkSync(filePath, hardLink);
  assert.throws(
    () => readTrustedRegularFile(hardLink, readOptions),
    /hard-linked/,
  );
});
