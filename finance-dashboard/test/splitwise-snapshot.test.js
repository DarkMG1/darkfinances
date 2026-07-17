const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-snapshot-'));
process.env.PERSONAL_CONFIG_PATH = path.join(dir, 'personal-config.json');
const { validateSplitwiseMirrorSnapshot } = require('../dataModule');
const { SplitwiseMirrorSnapshotError } = require('../lib/splitwise-mirror');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const now = Date.parse('2026-07-10T03:00:00.000Z');
const complete = {
  schemaVersion: 2,
  generatedAt: '2026-07-10T02:30:00.000Z',
  manifest: {
    complete: true,
    expectedEvents: 2,
    resolvedEvents: 2,
    failedEvents: [],
    uniqueGroupIds: ['1', '2'],
    itemizedComplete: true,
    currency: 'USD',
  },
  othersPaidItems: [
    { id: '1001', myShare: 12.34 },
    { id: '1002', myShare: 5 },
  ],
};

test('accepts a complete, fresh and unique mirror manifest', () => {
  assert.equal(validateSplitwiseMirrorSnapshot(complete, { now }).length, 2);
});

test('rejects partial snapshots before any prune can run', () => {
  assert.throws(
    () => validateSplitwiseMirrorSnapshot({
      ...complete,
      manifest: { ...complete.manifest, complete: false, resolvedEvents: 1 },
    }, { now }),
    (error) => error instanceof SplitwiseMirrorSnapshotError && /incomplete/.test(error.message),
  );
});

test('rejects stale and duplicate itemized data', () => {
  assert.throws(
    () => validateSplitwiseMirrorSnapshot({ ...complete, generatedAt: '2026-07-09T00:00:00.000Z' }, { now }),
    (error) => error instanceof SplitwiseMirrorSnapshotError && /stale/.test(error.message),
  );
  assert.throws(
    () => validateSplitwiseMirrorSnapshot({
      ...complete,
      othersPaidItems: [{ id: '1001', myShare: 1 }, { id: '1001', myShare: 2 }],
    }, { now }),
    (error) => error instanceof SplitwiseMirrorSnapshotError && /duplicate/.test(error.message),
  );
});

test('rejects shares that are not exact cent amounts', () => {
  assert.throws(
    () => validateSplitwiseMirrorSnapshot({
      ...complete,
      othersPaidItems: [{ id: '1003', myShare: 1.005 }],
    }, { now }),
    (error) => error instanceof SplitwiseMirrorSnapshotError && /exact cent amount/.test(error.message),
  );
});
