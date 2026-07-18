'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const hooksPath = path.join(__dirname, '../src/api/hooks/finance.hooks.ts');
const hooks = fs.readFileSync(hooksPath, 'utf8');
const { MUTATION_PAYLOAD_FIXTURES: payloads } = require('../../finance-dashboard/test/fixtures/mutation-payloads');

test('useSetRecurringOverride invalidates today and forecast derived reads', () => {
  assert.match(hooks, /RECURRING_OVERRIDE_DERIVED_KEYS/);
  assert.match(hooks, /API_ENDPOINTS\.today\.key/);
  assert.match(hooks, /API_ENDPOINTS\.forecast\.key/);
  assert.match(hooks, /API_ENDPOINTS\.recurring\.key/);
  assert.match(hooks, /API_ENDPOINTS\.bills\.key/);
  assert.match(hooks, /invalidateKeys\(qc, RECURRING_OVERRIDE_DERIVED_KEYS\)/);
});

test('mutation payload fixtures cover recurring categoryId override', () => {
  const payload = payloads.find((entry) => entry.source === 'mobile:useSetRecurringOverrideCategory');
  assert.ok(payload, 'expected mobile:useSetRecurringOverrideCategory fixture');
  assert.equal(payload.body.categoryId, 'loan-payment');
  assert.equal(payload.body.forced, true);
  assert.equal(payload.body.isBill, true);
});
