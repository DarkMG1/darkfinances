const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  isSplitEditorDirty,
  seedSplitEditorBaseline,
  snapshotSplitEditor,
} = require('../src/lib/split-editor-dirty');

const sampleLegs = [
  {
    id: undefined,
    catId: 'cat-1',
    catName: 'Food',
    name: '',
    notes: '',
    amt: '50.00',
    pct: '100',
  },
];

test('fresh open baseline is not dirty', () => {
  const baseline = seedSplitEditorBaseline('equal', sampleLegs);
  assert.equal(isSplitEditorDirty('equal', sampleLegs, baseline), false);
});

test('edited legs are dirty against seeded baseline', () => {
  const baseline = seedSplitEditorBaseline('equal', sampleLegs);
  const edited = [{ ...sampleLegs[0], name: 'Lunch' }];
  assert.equal(isSplitEditorDirty('equal', edited, baseline), true);
});

test('split editor seeds baseline atomically from next mode and legs', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/app/split/[id].tsx'), 'utf8');
  assert.match(source, /seedSplitEditorBaseline\(nextMode, nextLegs\)/);
  assert.doesNotMatch(source, /setTimeout\(\(\) => \{\s*setMode/);
  assert.doesNotMatch(source, /baselineSnapshot != null\) return;\s*setBaselineSnapshot\(snapshotSplitEditor/);
});

test('snapshot ignores volatile leg keys', () => {
  const a = snapshotSplitEditor('specific', [{ key: 'k1', ...sampleLegs[0] }]);
  const b = snapshotSplitEditor('specific', [{ key: 'k2', ...sampleLegs[0] }]);
  assert.equal(a, b);
});
