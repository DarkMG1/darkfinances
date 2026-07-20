'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const hooks = fs.readFileSync(
  path.resolve(__dirname, '..', 'src', 'api', 'hooks', 'finance.hooks.ts'),
  'utf8',
);
const types = fs.readFileSync(
  path.resolve(__dirname, '..', 'src', 'api', 'generated', 'types.ts'),
  'utf8',
);

test('ReviewTask contract exposes fingerprint metadata for mobile clients', () => {
  assert.match(types, /stableKey: string;/);
  assert.match(types, /contentHash: string;/);
  assert.match(types, /contentVersion: number;/);
});

test('receipt mutations invalidate review and today derived caches', () => {
  assert.match(hooks, /useAddReceipt[\s\S]*invalidateTransactionDerivedData/);
  assert.match(hooks, /useDeleteReceipt[\s\S]*invalidateTransactionDerivedData/);
  assert.match(hooks, /API_ENDPOINTS\.review\.key/);
  assert.match(hooks, /API_ENDPOINTS\.today\.key/);
});

test('setReviewDisposition invalidates review and today', () => {
  assert.match(hooks, /useSetReviewDisposition[\s\S]*API_ENDPOINTS\.review\.key/);
  assert.match(hooks, /useSetReviewDisposition[\s\S]*API_ENDPOINTS\.today\.key/);
});
