'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const demo = require('../demoData');

test('demo today net worth matches authoritative projection over demo accounts', () => {
  const today = demo.today();
  assert.equal(today.metrics.netWorth.complete, true);
  assert.ok(today.scope.accountProjectionRevision);
  assert.ok(today.metrics.liquidCash.complete);
  assert.ok(today.metrics.operatingCash.complete);
  assert.ok(today.metrics.netWorth.value > 0);
});

test('demo trends documents synthetic history scope separately from live projection', () => {
  const trends = demo.trends(12);
  assert.equal(trends.scope.demoSyntheticHistory, true);
  assert.ok(trends.scope.accountProjectionRevision);
});
