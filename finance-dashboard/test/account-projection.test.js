'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ACCOUNT_METRIC,
  ACCOUNT_PROJECTION_REASON,
  buildNetWorthMetric,
  projectAccounts,
} = require('../lib/account-projection');
const {
  matrixAccounts,
  overrides,
  splitwiseMirrorAccountId,
  OPERATING_ID,
  PROTECTED_ID,
  CREDIT_ID,
  HIDDEN_SPEND_ID,
  EXCLUDED_ID,
  UNKNOWN_ID,
  CLOSED_ID,
  SPLITWISE_ID,
} = require('./fixtures/account-projection-matrix');

function balancesFromAccounts(accounts) {
  return Object.fromEntries(accounts.map((account) => [account.id, account.balance]));
}

test('hidden and excluded accounts are absent from net worth live but remain in display list', () => {
  const projection = projectAccounts({
    accountsRaw: matrixAccounts,
    balancesById: balancesFromAccounts(matrixAccounts),
    overrides,
    metric: ACCOUNT_METRIC.netWorthLive,
    splitwiseMirrorAccountId,
  });
  assert.equal(projection.includedIds.has(HIDDEN_SPEND_ID), false);
  assert.equal(projection.includedIds.has(EXCLUDED_ID), false);
  assert.equal(projection.includedIds.has(SPLITWISE_ID), false);
  assert.equal(projection.includedIds.has(OPERATING_ID), true);
  assert.equal(projection.includedIds.has(PROTECTED_ID), true);
  assert.equal(projection.includedIds.has(CLOSED_ID), false);

  const display = projectAccounts({
    accountsRaw: matrixAccounts,
    balancesById: balancesFromAccounts(matrixAccounts),
    overrides,
    metric: ACCOUNT_METRIC.displayList,
    splitwiseMirrorAccountId,
  });
  assert.equal(display.includedIds.has(HIDDEN_SPEND_ID), true);
  assert.equal(display.accounts.find((row) => row.id === OPERATING_ID).name, 'Everyday');
});

test('unknown role fails closed for role-dependent metrics without silent inclusion', () => {
  const projection = projectAccounts({
    accountsRaw: matrixAccounts,
    balancesById: balancesFromAccounts(matrixAccounts),
    overrides,
    metric: ACCOUNT_METRIC.netWorthLive,
    splitwiseMirrorAccountId,
  });
  assert.ok(projection.incompleteReasons.includes(ACCOUNT_PROJECTION_REASON.netWorthRoleUnknown));
  const metric = buildNetWorthMetric({ projection, manualAssets: { assets: 0, liabilities: 0 }, asOf: new Date().toISOString(), financeDate: '2026-07-18' });
  assert.equal(metric.complete, false);
  assert.equal(metric.value, null);
  assert.equal(metric.valueCents, null);
  assert.ok(!projection.includedIds.has(UNKNOWN_ID));
});

test('liquid cash includes operating and protected only', () => {
  const projection = projectAccounts({
    accountsRaw: matrixAccounts.filter((account) => account.id !== UNKNOWN_ID),
    balancesById: balancesFromAccounts(matrixAccounts.filter((account) => account.id !== UNKNOWN_ID)),
    overrides,
    metric: ACCOUNT_METRIC.liquidCash,
    splitwiseMirrorAccountId,
  });
  assert.deepEqual([...projection.includedIds].sort(), [OPERATING_ID, PROTECTED_ID].sort());
});

test('spending attribution includes splitwise mirror but excludes hidden and excluded', () => {
  const projection = projectAccounts({
    accountsRaw: matrixAccounts.filter((account) => account.id !== UNKNOWN_ID),
    balancesById: balancesFromAccounts(matrixAccounts.filter((account) => account.id !== UNKNOWN_ID)),
    overrides,
    metric: ACCOUNT_METRIC.spendingAttribution,
    splitwiseMirrorAccountId,
  });
  assert.equal(projection.includedIds.has(SPLITWISE_ID), true);
  assert.equal(projection.includedIds.has(HIDDEN_SPEND_ID), false);
  assert.equal(projection.includedIds.has(EXCLUDED_ID), false);
});

test('net worth history retains closed accounts within bounded history scope', () => {
  const projection = projectAccounts({
    accountsRaw: matrixAccounts.filter((account) => account.id !== UNKNOWN_ID),
    balancesById: balancesFromAccounts(matrixAccounts.filter((account) => account.id !== UNKNOWN_ID)),
    overrides,
    metric: ACCOUNT_METRIC.netWorthHistory,
    splitwiseMirrorAccountId,
  });
  assert.equal(projection.includedIds.has(CLOSED_ID), true);
  assert.equal(projection.scope.includesClosedAccountHistory, true);
});

test('authoritative net worth sums recognized roles exactly once with manual assets', () => {
  const accounts = matrixAccounts.filter((account) => ![UNKNOWN_ID, HIDDEN_SPEND_ID, EXCLUDED_ID, SPLITWISE_ID, CLOSED_ID].includes(account.id));
  const projection = projectAccounts({
    accountsRaw: accounts,
    balancesById: balancesFromAccounts(accounts),
    overrides,
    metric: ACCOUNT_METRIC.netWorthLive,
    splitwiseMirrorAccountId,
  });
  const metric = buildNetWorthMetric({
    projection,
    manualAssets: { assets: 100, liabilities: 25 },
    asOf: new Date().toISOString(),
    financeDate: '2026-07-18',
  });
  assert.equal(metric.complete, true);
  // 1000 + 2000 - 50 + 100 - 25 = 3025
  assert.equal(metric.value, 3025);
  assert.equal(metric.valueCents, 302500);
});

test('splitwise mirror identity excludes net worth but not spending', () => {
  const projection = projectAccounts({
    accountsRaw: matrixAccounts.filter((account) => account.id !== UNKNOWN_ID),
    balancesById: balancesFromAccounts(matrixAccounts),
    overrides,
    metric: ACCOUNT_METRIC.netWorthLive,
    splitwiseMirrorAccountId: SPLITWISE_ID,
  });
  assert.equal(projection.excludedReasons[SPLITWISE_ID], 'splitwise_mirror');
  const spend = projectAccounts({
    accountsRaw: matrixAccounts.filter((account) => account.id !== UNKNOWN_ID),
    balancesById: balancesFromAccounts(matrixAccounts),
    overrides,
    metric: ACCOUNT_METRIC.spendingAttribution,
    splitwiseMirrorAccountId: SPLITWISE_ID,
  });
  assert.equal(spend.includedIds.has(SPLITWISE_ID), true);
});
