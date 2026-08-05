'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.ACTUAL_API_PATH = path.join(__dirname, 'fixtures', 'repayment-actual.js');
const actual = require('./fixtures/repayment-actual');
const originalInit = actual.init;
actual.init = async () => {
  throw new Error('Bearer sensitive-value password=sensitive-value https://user:sensitive-value@example.test');
};
const data = require('../dataModule');

test.after(() => {
  actual.init = originalInit;
});

test('health exposes only a generic finance-data error after startup failure', async () => {
  await assert.rejects(data.initApi({ skipRecover: true }), /sensitive-value/);

  const health = data.getHealth();
  assert.equal(health.ready, false);
  assert.equal(health.lastError, 'Finance data is unavailable');
  assert.equal(typeof health.lastErrorAt, 'string');
  assert.doesNotMatch(JSON.stringify(health), /sensitive-value|password=|Bearer|https:\/\/user:/);
});
