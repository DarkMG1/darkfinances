'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ACCOUNT_METRIC,
  ACCOUNT_PROJECTION_REASON,
  buildBalanceMetric,
  buildNetWorthMetric,
  detectDuplicateAccountTopology,
  normalizeBalanceCents,
  projectAccounts,
} = require('../lib/account-projection');
const { validateManualAssetsStore } = require('../lib/manual-assets-projection');
const {
  resolveSplitwiseMirrorIdentity,
  SPLITWISE_MIRROR_IDENTITY_INVALID,
  SPLITWISE_MIRROR_MIGRATION_REQUIRED,
} = require('../lib/splitwise-mirror-account');
const {
  matrixAccounts,
  overrides,
  splitwiseMirrorAccountId,
  OPERATING_ID,
  PROTECTED_ID,
  UNKNOWN_ID,
  SPLITWISE_ID,
} = require('./fixtures/account-projection-matrix');

function balancesFromAccounts(accounts, { omit = [] } = {}) {
  const omitted = new Set(omit);
  const balances = {};
  for (const account of accounts) {
    if (omitted.has(account.id)) {
      balances[account.id] = null;
      continue;
    }
    balances[account.id] = account.balance;
  }
  return balances;
}

function unavailableIdsFromBalances(balancesById) {
  return new Set(Object.entries(balancesById).filter(([, cents]) => !Number.isSafeInteger(cents)).map(([id]) => id));
}

test('normalizeBalanceCents rejects null, nonfinite, and unsafe values', () => {
  assert.equal(normalizeBalanceCents(null).ok, false);
  assert.equal(normalizeBalanceCents(undefined).ok, false);
  assert.equal(normalizeBalanceCents(Number.NaN).ok, false);
  assert.equal(normalizeBalanceCents(Number.POSITIVE_INFINITY).ok, false);
  assert.equal(normalizeBalanceCents(Number.MAX_SAFE_INTEGER + 1).ok, false);
  assert.deepEqual(normalizeBalanceCents(1500), { ok: true, cents: 1500 });
});

test('one unavailable included balance fails net worth with empty sources', () => {
  const accounts = matrixAccounts.filter((account) => account.id !== UNKNOWN_ID);
  const balancesById = balancesFromAccounts(accounts, { omit: [OPERATING_ID] });
  const projection = projectAccounts({
    accountsRaw: accounts,
    balancesById,
    balanceUnavailableIds: unavailableIdsFromBalances(balancesById),
    overrides,
    metric: ACCOUNT_METRIC.netWorthLive,
    splitwiseMirrorAccountId,
  });
  assert.ok(projection.incompleteReasons.includes(ACCOUNT_PROJECTION_REASON.accountBalanceUnavailable));
  const metric = buildNetWorthMetric({
    projection,
    manualAssets: validateManualAssetsStore({ items: [] }),
    asOf: new Date().toISOString(),
    financeDate: '2026-07-18',
  });
  assert.equal(metric.complete, false);
  assert.equal(metric.value, null);
  assert.equal(metric.valueCents, null);
  assert.deepEqual(metric.provenance?.sources, []);
});

test('many unavailable balances still fail once with empty sources', () => {
  const accounts = matrixAccounts.filter((account) => account.id !== UNKNOWN_ID);
  const balancesById = balancesFromAccounts(accounts, { omit: [OPERATING_ID, PROTECTED_ID] });
  const projection = projectAccounts({
    accountsRaw: accounts,
    balancesById,
    balanceUnavailableIds: unavailableIdsFromBalances(balancesById),
    overrides,
    metric: ACCOUNT_METRIC.operatingCash,
    splitwiseMirrorAccountId,
  });
  assert.deepEqual(projection.incompleteReasons, [ACCOUNT_PROJECTION_REASON.accountBalanceUnavailable]);
  const metric = buildBalanceMetric({
    projection,
    metric: 'operating_cash',
    asOf: new Date().toISOString(),
    financeDate: '2026-07-18',
  });
  assert.equal(metric.complete, false);
  assert.deepEqual(metric.provenance?.sources, []);
});

test('manual assets malformed store fails net worth without partial sources', () => {
  const accounts = matrixAccounts.filter((account) => ![UNKNOWN_ID].includes(account.id));
  const projection = projectAccounts({
    accountsRaw: accounts,
    balancesById: balancesFromAccounts(accounts),
    overrides,
    metric: ACCOUNT_METRIC.netWorthLive,
    splitwiseMirrorAccountId,
  });
  const metric = buildNetWorthMetric({
    projection,
    manualAssets: validateManualAssetsStore({ items: [{ id: 'x', name: 'Bad', value: Number.NaN, kind: 'asset' }] }),
    asOf: new Date().toISOString(),
    financeDate: '2026-07-18',
  });
  assert.equal(metric.complete, false);
  assert.equal(metric.value, null);
  assert.deepEqual(metric.provenance?.sources, []);
});

test('manual assets JSON malformed runtime state fails closed', () => {
  const validated = validateManualAssetsStore('not-json');
  assert.equal(validated.complete, false);
  assert.equal(validated.assets, null);
  assert.equal(validated.liabilities, null);
});

test('duplicate account ids quarantine role metrics with account_identity_duplicate', () => {
  const duplicate = { ...matrixAccounts[0], name: 'Checking duplicate row' };
  const accountsRaw = [matrixAccounts[0], duplicate, ...matrixAccounts.slice(1)];
  const duplicates = detectDuplicateAccountTopology(accountsRaw);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].conflicting, true);
  const projection = projectAccounts({
    accountsRaw,
    balancesById: balancesFromAccounts(accountsRaw),
    duplicateAccountIds: duplicates.map((entry) => entry.id),
    overrides,
    metric: ACCOUNT_METRIC.netWorthLive,
    splitwiseMirrorAccountId,
  });
  assert.ok(projection.incompleteReasons.includes(ACCOUNT_PROJECTION_REASON.accountIdentityDuplicate));
});

test('identical duplicate rows still quarantine metrics', () => {
  const accountsRaw = [matrixAccounts[0], matrixAccounts[0], ...matrixAccounts.slice(1)];
  const duplicates = detectDuplicateAccountTopology(accountsRaw);
  assert.equal(duplicates[0].conflicting, false);
  const projection = projectAccounts({
    accountsRaw,
    balancesById: balancesFromAccounts(accountsRaw),
    duplicateAccountIds: duplicates.map((entry) => entry.id),
    overrides,
    metric: ACCOUNT_METRIC.spendingAttribution,
    splitwiseMirrorAccountId,
  });
  assert.ok(projection.incompleteReasons.includes(ACCOUNT_PROJECTION_REASON.accountIdentityDuplicate));
});

test('splitwise durable identity agreement excludes mirror from net worth and includes spending once', () => {
  const accounts = matrixAccounts.filter((account) => account.id !== UNKNOWN_ID);
  const identity = resolveSplitwiseMirrorIdentity({
    accountsRaw: accounts,
    env: { SPLITWISE_MIRROR_ACCOUNT_ID: SPLITWISE_ID },
  });
  assert.equal(identity.status, 'valid');
  assert.equal(identity.accountId, SPLITWISE_ID);
  const nw = projectAccounts({
    accountsRaw: accounts,
    balancesById: balancesFromAccounts(accounts),
    overrides,
    metric: ACCOUNT_METRIC.netWorthLive,
    splitwiseMirrorAccountId: identity.accountId,
    splitwiseMirrorIdentity: identity,
  });
  const spend = projectAccounts({
    accountsRaw: accounts,
    balancesById: balancesFromAccounts(accounts),
    overrides,
    metric: ACCOUNT_METRIC.spendingAttribution,
    splitwiseMirrorAccountId: identity.accountId,
    splitwiseMirrorIdentity: identity,
  });
  assert.equal(nw.includedIds.has(SPLITWISE_ID), false);
  assert.equal(spend.includedIds.has(SPLITWISE_ID), true);
});

test('splitwise disagreeing durable ids invalidate role metrics', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-splitwise-identity-'));
  const owesConfigPath = path.join(dir, 'owes-config.json');
  fs.writeFileSync(owesConfigPath, JSON.stringify({ mirrorAccountId: 'other-id' }));
  const identity = resolveSplitwiseMirrorIdentity({
    accountsRaw: matrixAccounts,
    env: { SPLITWISE_MIRROR_ACCOUNT_ID: SPLITWISE_ID },
    owesConfigPath,
  });
  assert.equal(identity.status, 'disagreement');
  assert.deepEqual(identity.incompleteReasons, [SPLITWISE_MIRROR_IDENTITY_INVALID]);
  const projection = projectAccounts({
    accountsRaw: matrixAccounts,
    balancesById: balancesFromAccounts(matrixAccounts),
    overrides,
    metric: ACCOUNT_METRIC.netWorthLive,
    splitwiseMirrorIdentity: identity,
  });
  assert.ok(projection.incompleteReasons.includes(SPLITWISE_MIRROR_IDENTITY_INVALID));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('legacy splitwise name without durable id requires migration and never excludes by name', () => {
  const accounts = matrixAccounts.map((account) => (
    account.id === SPLITWISE_ID ? { ...account, name: 'Splitwise' } : account
  ));
  const identity = resolveSplitwiseMirrorIdentity({
    accountsRaw: accounts,
    env: {},
  });
  assert.equal(identity.status, 'migration_required');
  assert.deepEqual(identity.incompleteReasons, [SPLITWISE_MIRROR_MIGRATION_REQUIRED]);
  assert.ok(identity.legacyNameCandidates.includes(SPLITWISE_ID));
  const projection = projectAccounts({
    accountsRaw: accounts.filter((account) => account.id !== UNKNOWN_ID),
    balancesById: balancesFromAccounts(matrixAccounts),
    overrides,
    metric: ACCOUNT_METRIC.netWorthLive,
    splitwiseMirrorIdentity: identity,
  });
  assert.ok(projection.incompleteReasons.includes(SPLITWISE_MIRROR_MIGRATION_REQUIRED));
  assert.equal(projection.includedIds.has(SPLITWISE_ID), true);
  assert.equal(projection.excludedReasons[SPLITWISE_ID], undefined);
});

test.after(() => {});
