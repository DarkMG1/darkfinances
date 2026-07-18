'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const hooksPath = path.join(__dirname, '../src/api/hooks/finance.hooks.ts');
const hooks = fs.readFileSync(hooksPath, 'utf8');
const typesPath = path.join(__dirname, '../src/api/generated/types.ts');
const types = fs.readFileSync(typesPath, 'utf8');
const { MUTATION_PAYLOAD_FIXTURES: payloads } = require('../../finance-dashboard/test/fixtures/mutation-payloads');

test('useSetAccountOverride invalidates today and forecast derived reads', () => {
  assert.match(hooks, /ACCOUNT_OVERRIDE_DERIVED_KEYS/);
  assert.match(hooks, /API_ENDPOINTS\.today\.key/);
  assert.match(hooks, /API_ENDPOINTS\.forecast\.key/);
  assert.match(hooks, /invalidateKeys\(qc, ACCOUNT_OVERRIDE_DERIVED_KEYS\)/);
});

test('generated contract exposes recurring categoryId and credit override fields', () => {
  assert.match(types, /categoryId\?: string \| null;/);
  assert.match(types, /categoryIdentityStatus\?:/);
  assert.match(types, /creditLiabilityCoverage\?: CreditLiabilityCoverage/);
  assert.match(types, /paymentRecurringKey\?: string/);
  assert.match(types, /fundingAccountId\?: string/);
  assert.match(types, /statement\?: AccountCreditStatementOverride/);
  assert.match(types, /clearCreditLiability\?: boolean/);
});

test('mutation payload fixtures cover all account credit override fields', () => {
  const creditPayload = payloads.find((entry) => entry.source === 'mobile:useSetAccountOverrideCredit');
  assert.ok(creditPayload, 'expected mobile:useSetAccountOverrideCredit fixture');
  assert.equal(creditPayload.body.creditLiabilityCoverage, 'current_balance');
  assert.equal(typeof creditPayload.body.paymentRecurringKey, 'string');
  assert.equal(typeof creditPayload.body.fundingAccountId, 'string');
  assert.ok(creditPayload.body.statement);
  assert.equal(creditPayload.body.clearCreditLiability, true);
});
