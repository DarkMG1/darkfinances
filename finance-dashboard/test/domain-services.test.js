const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCategoryInfo, transactionLeaves, summarizeCents } = require('../lib/domain/classification');
const { fromCents, sumCents, toCents } = require('../lib/domain/money');
const { accountsForMetric, migrateAccountOverrides } = require('../lib/account-overrides');
const { metricValue } = require('../lib/metric-provenance');

const patterns = {
  incomeGroup: /^income$/i,
  moneyMovementGroup: /money movement/i,
  moneyMovementCategory: /^transfer$/i,
  reimbursementCategory: /^reimbursement$/i,
};

test('money service conserves integer cents and rejects fractional cents', () => {
  assert.equal(toCents(12.34), 1234);
  assert.equal(fromCents(-501), -5.01);
  assert.equal(sumCents([-10033, 502, 9531]), 0);
  assert.throws(() => toCents(12.345), /two decimal/);
});

test('classification excludes movement and reimbursement without float drift', () => {
  const info = buildCategoryInfo([
    { name: 'Income', is_income: true, categories: [{ id: 'salary', name: 'Salary' }] },
    { name: 'Money Movement', categories: [{ id: 'transfer', name: 'Transfer' }] },
    { name: 'Spending', categories: [{ id: 'food', name: 'Food' }, { id: 'reimb', name: 'Reimbursement' }] },
  ], patterns);
  const leaves = [
    { amount: 100001, catId: 'salary' },
    { amount: -12345, catId: 'food' },
    { amount: -5000, catId: 'transfer' },
    { amount: -2000, catId: 'reimb' },
    { amount: 100, catId: null },
  ];
  assert.deepEqual(summarizeCents(leaves, info), {
    spendingCents: { Food: 12345 },
    totalSpendCents: 12345,
    totalIncomeCents: 100001,
  });
});

test('split parents flatten to cent-preserving leaves', () => {
  const leaves = transactionLeaves({
    id: 'parent',
    is_parent: true,
    subtransactions: [{ id: 'a', amount: -500 }, { id: 'b', amount: -501 }],
  });
  assert.equal(sumCents(leaves.map((leaf) => leaf.amount)), -1001);
  assert.equal(leaves.every((leaf) => leaf.parentId === 'parent' && leaf.isLeg), true);
});

test('account override migration is versioned and roles survive renames', () => {
  const migrated = migrateAccountOverrides({ account: { name: 'Renamed', role: 'operating_cash' } });
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.accounts.account.role, 'operating_cash');
  migrated.accounts.account.name = 'Another name';
  assert.equal(migrated.accounts.account.role, 'operating_cash');
  assert.deepEqual(accountsForMetric([{ id: 'a', role: 'operating_cash' }, { id: 'b', role: 'unknown' }], 'operating_cash'), [{ id: 'a', role: 'operating_cash' }]);
});

test('incomplete metrics never expose a decision value', () => {
  const metric = metricValue({
    metric: 'safe_to_spend',
    value: 100,
    valueCents: 10000,
    complete: false,
    financeDate: '2026-07-09',
    incompleteReasons: ['account roles unassigned'],
  });
  assert.equal(metric.value, null);
  assert.equal(metric.valueCents, null);
  assert.deepEqual(metric.incompleteReasons, ['account roles unassigned']);
});
