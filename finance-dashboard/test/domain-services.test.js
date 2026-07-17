const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCategoryInfo, transactionLeaves, summarizeCents, classifyTransactionLeaves, buildTransferIndex } = require('../lib/domain/classification');
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
  assert.equal(toCents(0.29), 29);
  assert.equal(toCents(-0.01), -1);
  assert.equal(fromCents(-501), -5.01);
  assert.equal(sumCents([-10033, 502, 9531]), 0);
  assert.throws(() => toCents(12.345), /two decimal/);
  assert.throws(() => toCents(0.0100000001), /two decimal/);
  assert.throws(() => toCents('12.34'), /finite number/);
  assert.throws(() => toCents(-0), /negative zero/);
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

test('Actual transfer identity excludes paired legs from spending summaries', () => {
  const info = buildCategoryInfo([
    { name: 'Money Movement', categories: [{ id: 'transfer', name: 'Transfer' }] },
    { name: 'Spending', categories: [{ id: 'food', name: 'Food' }] },
  ], patterns);
  const pair = classifyTransactionLeaves(
    { id: 'out', amount: -900, transfer_id: 'in', category: 'transfer' },
    info,
    {
      accountId: 'checking',
      transferIndex: buildTransferIndex([
        { transaction: { id: 'out', amount: -900, transfer_id: 'in', category: 'transfer' }, accountId: 'checking' },
        { transaction: { id: 'in', amount: 900, transfer_id: 'out', category: 'transfer' }, accountId: 'savings' },
      ]),
    },
  );
  assert.equal(summarizeCents(pair, info).totalSpendCents, 0);
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
  const accountId = '00000000-0000-4000-8000-000000000010';
  const migrated = migrateAccountOverrides({ [accountId]: { name: 'Renamed', role: 'operating_cash' } });
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.accounts[accountId].role, 'operating_cash');
  migrated.accounts[accountId].name = 'Another name';
  assert.equal(migrated.accounts[accountId].role, 'operating_cash');
  assert.deepEqual(accountsForMetric([{ id: 'a', role: 'operating_cash' }, { id: 'b', role: 'unknown' }], 'operating_cash'), [{ id: 'a', role: 'operating_cash' }]);
});

test('incomplete metrics never expose a decision value', () => {
  const metric = metricValue({
    metric: 'safe_to_spend',
    value: 100,
    valueCents: 10000,
    complete: false,
    financeDate: '2026-07-09',
    incompleteReasons: [
      'credit_card_coverage_unknown',
      'goal_commitment_unknown',
      'credit_card_coverage_unknown',
    ],
  });
  assert.equal(metric.value, null);
  assert.equal(metric.valueCents, null);
  assert.deepEqual(metric.incompleteReasons, [
    'credit_card_coverage_unknown',
    'goal_commitment_unknown',
  ]);
  assert.equal(metric.incompleteReasons.every((reason) => /^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(reason)), true);
});
