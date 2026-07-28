'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalManualAssetItems,
  manualAssetsRevision,
  validateManualAssetsStore,
} = require('../lib/manual-assets-projection');

test('manualAssetsRevision changes on rename-only edits', () => {
  const before = validateManualAssetsStore({ items: [{ id: 'm1', name: 'Car', value: 100, kind: 'asset' }] });
  const after = validateManualAssetsStore({ items: [{ id: 'm1', name: 'Truck', value: 100, kind: 'asset' }] });
  assert.notEqual(manualAssetsRevision(before), manualAssetsRevision(after));
});

test('manualAssetsRevision includes id-less legacy items and value changes', () => {
  const before = validateManualAssetsStore({ items: [{ name: 'Legacy', value: 50, kind: 'asset' }] });
  const after = validateManualAssetsStore({ items: [{ name: 'Legacy', value: 75, kind: 'asset' }] });
  assert.deepEqual(canonicalManualAssetItems(before), [{ id: null, name: 'legacy', kind: 'asset', valueCents: 5000 }]);
  assert.notEqual(manualAssetsRevision(before), manualAssetsRevision(after));
});

test('duplicate identical items affect revision multiplicity', () => {
  const single = validateManualAssetsStore({ items: [{ id: 'm1', name: 'Dup', value: 10, kind: 'asset' }] });
  const duplicate = validateManualAssetsStore({
    items: [
      { id: 'm1', name: 'Dup', value: 10, kind: 'asset' },
      { id: 'm2', name: 'Dup', value: 10, kind: 'asset' },
    ],
  });
  assert.notEqual(manualAssetsRevision(single), manualAssetsRevision(duplicate));
});

test('reordering semantically identical items does not change manualAssetsRevision', () => {
  const items = [
    { id: 'a', name: 'One', value: 10, kind: 'asset' },
    { id: 'b', name: 'Two', value: 20, kind: 'liability' },
  ];
  const forward = manualAssetsRevision(validateManualAssetsStore({ items }));
  const reversed = manualAssetsRevision(validateManualAssetsStore({ items: [...items].reverse() }));
  assert.equal(forward, reversed);
});
