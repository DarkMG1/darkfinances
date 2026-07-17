'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PROVENANCE,
  TRANSFER_REASON,
  buildCategoryInfo,
  buildTransferIndex,
  classifyLeaf,
  classifyTransactionLeaves,
  hasActualTransferIdentity,
  incompleteTransferReviewFingerprint,
  summarizeClassifiedLeaves,
  transactionLeaves,
} = require('../lib/domain/classification');
const { sumCents } = require('../lib/domain/money');

const patterns = {
  incomeGroup: /^income$/i,
  moneyMovementGroup: /money movement/i,
  moneyMovementCategory: /^transfer$/i,
  reimbursementCategory: /^reimbursement$/i,
};

const catInfo = buildCategoryInfo([
  { name: 'Income', is_income: true, categories: [{ id: 'salary', name: 'Salary' }] },
  { name: 'Money Movement', categories: [{ id: 'transfer', name: 'Transfer' }, { id: 'invest', name: 'Investments' }] },
  { name: 'Spending', categories: [{ id: 'food', name: 'Food' }, { id: 'reimb', name: 'Reimbursement' }] },
], patterns);

function classifyRows(rows) {
  const index = buildTransferIndex(rows);
  return rows.flatMap((row) => classifyTransactionLeaves(row.transaction, catInfo, {
    accountId: row.accountId,
    transferIndex: index,
  }));
}

function reconWouldInclude(transaction, accountId, rows) {
  const index = buildTransferIndex(rows);
  const isSplit = transaction.subtransactions && transaction.subtransactions.length;
  if (isSplit) {
    const classified = classifyTransactionLeaves(transaction, catInfo, { accountId, transferIndex: index });
    return classified.some((lf) => lf.countsAsSpending || (lf.kind === 'uncat' && lf.amount < 0) || (lf.kind === 'income' && lf.amount > 0));
  }
  const [classified] = classifyTransactionLeaves(transaction, catInfo, { accountId, transferIndex: index });
  if (!classified) return false;
  if (classified.kind === 'transfer' || classified.kind === 'incomplete') return false;
  if (classified.kind === 'mm' || classified.kind === 'reimb') return false;
  return classified.kind === 'income' ? classified.amount > 0 : true;
}

test('reproduction: category Transfer and transfer payee names do not prove transfer without identity', () => {
  const byNameOnly = classifyTransactionLeaves({ id: 'ext-1', amount: -12000, category: 'transfer' }, catInfo)[0];
  assert.equal(byNameOnly.kind, 'mm');
  assert.equal(byNameOnly.countsAsSpending, false);

  const payeeNamed = classifyTransactionLeaves({ id: 'ext-2', amount: -5000, category: 'food', notes: 'Transfer from Mom gift' }, catInfo)[0];
  assert.equal(payeeNamed.kind, 'spend');
  assert.equal(payeeNamed.countsAsSpending, true);
});

test('mutual-reference pair requires reciprocal ids, opposite signs, and equal absolute cents', () => {
  const rows = [
    { transaction: { id: 'a', amount: -50000, transfer_id: 'b' }, accountId: 'checking' },
    { transaction: { id: 'b', amount: 50000, transfer_id: 'a' }, accountId: 'savings' },
  ];
  const classified = classifyRows(rows);
  assert.equal(classified.every((leaf) => leaf.kind === 'transfer'), true);
  assert.equal(summarizeClassifiedLeaves(classified).totalSpendCents, 0);
  assert.equal(sumCents(classified.map((leaf) => leaf.amount)), 0);
});

test('mutual-reference mismatch on amount or sign fails closed as incomplete', () => {
  for (const [name, bAmount] of [['amount', 25000], ['sign', -50000]]) {
    const rows = [
      { transaction: { id: 'a', amount: -50000, transfer_id: 'b' }, accountId: 'checking' },
      { transaction: { id: 'b', amount: bAmount, transfer_id: 'a' }, accountId: 'savings' },
    ];
    const leaf = classifyRows(rows)[0];
    assert.equal(leaf.kind, 'incomplete', name);
    assert.equal(leaf.countsAsSpending, false, name);
    assert.match(leaf.reason, /^transfer_pair_/);
  }
});

test('non-reciprocal counterpart in window fails closed', () => {
  const rows = [
    { transaction: { id: 'a', amount: -100, transfer_id: 'b' }, accountId: 'x' },
    { transaction: { id: 'b', amount: 100, transfer_id: 'c' }, accountId: 'y' },
    { transaction: { id: 'c', amount: -100, transfer_id: 'b' }, accountId: 'z' },
  ];
  const a = classifyRows(rows).find((leaf) => leaf.id === 'a');
  assert.equal(a.kind, 'incomplete');
  assert.equal(a.reason, TRANSFER_REASON.PAIR_FAN_IN);
});

test('duplicate transaction ids in index fail closed', () => {
  const txn = { id: 'dup', amount: -100, transfer_id: 'other' };
  const rows = [
    { transaction: txn, accountId: 'a' },
    { transaction: txn, accountId: 'b' },
  ];
  const leaf = classifyRows(rows)[0];
  assert.equal(leaf.kind, 'incomplete');
  assert.equal(leaf.reason, TRANSFER_REASON.PAIR_DUPLICATE_ID);
});

test('one-sided cross-window counterpart stays transfer not incomplete', () => {
  const rows = [{ transaction: { id: 'only', amount: -25000, transfer_id: 'absent' }, accountId: 'checking' }];
  const leaf = classifyRows(rows)[0];
  assert.equal(leaf.kind, 'transfer');
  assert.equal(leaf.reason, TRANSFER_REASON.ACTUAL_ONE_SIDED);
});

test('transferred_id-only split leg classifies as transfer across surfaces', () => {
  const split = {
    id: 'split-parent',
    is_parent: true,
    amount: -5000,
    subtransactions: [
      { id: 'xfer-leg', amount: -5000, transferred_id: 'acc-savings' },
    ],
  };
  const rows = [{ transaction: split, accountId: 'checking' }];
  const leaf = classifyRows(rows)[0];
  assert.equal(leaf.kind, 'transfer');
  assert.equal(leaf.reason, TRANSFER_REASON.ACTUAL_SPLIT_LEG);
  assert.equal(reconWouldInclude(split, 'checking', rows), false);
});

test('split mixed expense and transferred_id-only transfer leg counts spending once', () => {
  const split = {
    id: 'parent',
    is_parent: true,
    amount: -15000,
    subtransactions: [
      { id: 'leg-exp', amount: -10000, category: 'food' },
      { id: 'leg-xfer', amount: -5000, transferred_id: 'acc-remote' },
    ],
  };
  const rows = [{ transaction: split, accountId: 'checking' }];
  const leaves = classifyRows(rows);
  assert.deepEqual(leaves.map((leaf) => leaf.kind).sort(), ['spend', 'transfer']);
  assert.equal(summarizeClassifiedLeaves(leaves).totalSpendCents, 10000);
  assert.equal(reconWouldInclude(split, 'checking', rows), true);
});

test('transfer-only split parent is excluded from recon integration filter', () => {
  const split = {
    id: 'xfer-only-parent',
    is_parent: true,
    amount: -8000,
    subtransactions: [{ id: 'xfer-leg', amount: -8000, transfer_id: 'remote-xfer' }],
  };
  const rows = [{ transaction: split, accountId: 'checking' }];
  assert.equal(reconWouldInclude(split, 'checking', rows), false);
});

test('malformed self-reference fails closed with stable review fingerprint', () => {
  const leaf = classifyTransactionLeaves({ id: 'self', amount: -100, transfer_id: 'self', category: 'food' }, catInfo)[0];
  assert.equal(leaf.kind, 'incomplete');
  assert.equal(leaf.reason, TRANSFER_REASON.IDENTITY_SELF_REFERENCE);
  assert.equal(leaf.reviewFingerprint, incompleteTransferReviewFingerprint({}, { id: 'self', reason: TRANSFER_REASON.IDENTITY_SELF_REFERENCE }));
});

test('same-account mutual pair fails closed', () => {
  const rows = [
    { transaction: { id: 'a', amount: -100, transfer_id: 'b' }, accountId: 'same' },
    { transaction: { id: 'b', amount: 100, transfer_id: 'a' }, accountId: 'same' },
  ];
  const leaf = classifyRows(rows)[0];
  assert.equal(leaf.kind, 'incomplete');
  assert.equal(leaf.reason, TRANSFER_REASON.PAIR_SAME_ACCOUNT);
});

test('hasActualTransferIdentity uses transfer_id and transferred_id on parents and legs', () => {
  assert.equal(hasActualTransferIdentity({ id: 'a', transferred_id: 'acct' }), true);
  assert.equal(hasActualTransferIdentity({
    id: 'p',
    is_parent: true,
    subtransactions: [{ id: 'l', amount: -1, transferred_id: 'acct' }],
  }), true);
});

test('demo fixtures carry explicit synthetic identity and exclude transfers from merchant history', () => {
  process.env.FINANCE_TIME_ZONE = 'America/Los_Angeles';
  process.env.DEMO_FINANCE_NOW = '2026-07-09T17:01:00-07:00';
  const demoPath = path.resolve(__dirname, '../demoData.js');
  delete require.cache[require.resolve(demoPath)];
  const demo = require(demoPath);
  const txns = demo.transactions();
  assert.ok(txns.find((t) => t.id === 'tx-demo-xfer-out')?.transfer);
  assert.equal(txns.find((t) => t.payee === 'Transfer from Mom')?.transfer, false);
  const merchant = demo.merchantHistory({ payee: 'Transfer : to High-Yield Savings', months: 3 });
  assert.equal(merchant.total, 0);
});

test('dataModule spending path uses classifier rather than payee heuristics', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../dataModule.js'), 'utf8');
  assert.match(source, /classifyTransactionLeaves/);
  assert.match(source, /transfer_identity/);
  assert.doesNotMatch(source, /TRANSFER_PAYEE\.test\(payeeName\)/);
  assert.doesNotMatch(source, /accountRoleFor/);
});

test('replacement saga rejects transferred_id on parent and split legs', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../lib/transaction-replacement-saga.js'), 'utf8');
  assert.match(source, /transferred_id/);
  assert.match(source, /legHasTransferIdentity/);
});
