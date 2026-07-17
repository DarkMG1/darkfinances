const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseTarVerboseLine,
  parseTarVerboseListingText,
} = require('../lib/backup-bundle-tar-listing');

test('parseTarVerboseLine accepts representative GNU tar verbose lines', () => {
  const gnuRegular = parseTarVerboseLine(
    '-rw------- runner/runner 12576 2026-07-17 13:16 bundle-manifest.json',
  );
  assert.deepEqual(gnuRegular, {
    type: '-',
    size: 12576,
    path: 'bundle-manifest.json',
  });

  const gnuDirectory = parseTarVerboseLine(
    'drwx------ runner/runner 512 2026-07-17 13:16 runtime',
  );
  assert.deepEqual(gnuDirectory, {
    type: 'd',
    size: 512,
    path: 'runtime',
  });

  const gnuSpacedPath = parseTarVerboseLine(
    '-rw------- runner/runner 42 2026-07-17 13:16 runtime/my file name.json',
  );
  assert.deepEqual(gnuSpacedPath, {
    type: '-',
    size: 42,
    path: 'runtime/my file name.json',
  });

  const gnuNumericOwner = parseTarVerboseLine(
    '-rw------- 1001/1001 2048 2026-01-02 03:04 tooling/ops/lib/backup-verify.js',
  );
  assert.deepEqual(gnuNumericOwner, {
    type: '-',
    size: 2048,
    path: 'tooling/ops/lib/backup-verify.js',
  });
});

test('parseTarVerboseLine accepts representative BSD tar verbose lines', () => {
  const bsdRegular = parseTarVerboseLine(
    '-rw-r--r--  0 FZ564H staff       5 Jul 17 06:39 f.txt',
  );
  assert.deepEqual(bsdRegular, {
    type: '-',
    size: 5,
    path: 'f.txt',
  });

  const bsdDirectory = parseTarVerboseLine(
    'drwx------  2 owner group      512 Jul 17 06:39 runtime',
  );
  assert.deepEqual(bsdDirectory, {
    type: 'd',
    size: 512,
    path: 'runtime',
  });

  const bsdSpacedPath = parseTarVerboseLine(
    '-rw-------  1 owner group      128 Jul 17 06:39 runtime/my file name.json',
  );
  assert.deepEqual(bsdSpacedPath, {
    type: '-',
    size: 128,
    path: 'runtime/my file name.json',
  });

  const bsdOldYear = parseTarVerboseLine(
    '-rw-------  1 owner group     4096 Jul 17  2024 archive-member.json',
  );
  assert.deepEqual(bsdOldYear, {
    type: '-',
    size: 4096,
    path: 'archive-member.json',
  });
});

test('parseTarVerboseLine classifies symlink, hardlink, device, and fifo entry types', () => {
  assert.deepEqual(
    parseTarVerboseLine('lrwxrwxrwx 1 user group 0 Jul 17 06:39 runtime/link.json'),
    { type: 'l', size: 0, path: 'runtime/link.json' },
  );
  assert.deepEqual(
    parseTarVerboseLine('lrwxrwxrwx runner/runner 0 2026-07-17 13:16 runtime/link.json'),
    { type: 'l', size: 0, path: 'runtime/link.json' },
  );
  assert.deepEqual(
    parseTarVerboseLine('hrw-r--r-- runner/runner 0 2026-07-17 13:16 runtime/hardlink.json'),
    { type: 'h', size: 0, path: 'runtime/hardlink.json' },
  );
  assert.deepEqual(
    parseTarVerboseLine('brw-r--r-- runner/runner 0 2026-07-17 13:16 dev/block'),
    { type: 'b', size: 0, path: 'dev/block' },
  );
  assert.deepEqual(
    parseTarVerboseLine('crw-r--r-- runner/runner 0 2026-07-17 13:16 dev/char'),
    { type: 'c', size: 0, path: 'dev/char' },
  );
  assert.deepEqual(
    parseTarVerboseLine('prw-r--r-- runner/runner 0 2026-07-17 13:16 runtime/pipe'),
    { type: 'p', size: 0, path: 'runtime/pipe' },
  );
});

test('parseTarVerboseListingText rejects ambiguous multiline and control-character listings', () => {
  assert.throws(
    () => parseTarVerboseLine('-rw------- runner/runner 1 2026-07-17 13:16 bad\u0001name.json'),
    /control characters are forbidden/,
  );
  assert.throws(
    () => parseTarVerboseLine('not-a-tar-line'),
    /unsupported tar entry type|unable to parse tar listing/,
  );

  const entries = parseTarVerboseListingText(
    '-rw------- runner/runner 1 2026-07-17 13:16 a.json\n\n-rw------- runner/runner 2 2026-07-17 13:16 b.json\n',
  );
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.path), ['a.json', 'b.json']);
});
