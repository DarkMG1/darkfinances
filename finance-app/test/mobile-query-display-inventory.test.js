const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  shouldShowFatalError,
  shouldShowRefetchError,
  collectRefetchErrorQueries,
} = require('../src/lib/query-display-state.js');
const {
  PRIMARY_QUERY_GATE_ORDER,
  COMPOUND_SCREEN_QUERY_CONTRACTS,
  buildHomeRefetchQueries,
  buildSpendingRefetchQueries,
  buildActivityRefetchQueries,
  buildAddTransactionRefetchQueries,
} = require('../src/lib/screen-query-display-config.js');
const {
  buildTransactionEditorAuxiliaryRefetchQueries,
  buildSplitEditorAuxiliaryRefetchQueries,
  buildAccountDetailRefetchQueries,
} = require('../src/lib/editor-refetch-queries.js');
const { resolveReconcileEnabledSetting, SETTINGS_QUERY_EXCLUSION } = require('../src/lib/settings-query-display.js');

const root = path.resolve(__dirname, '..');

/** Screens that fetch finance read data and must follow query display contracts. */
const DATA_SCREENS = [
  { file: 'src/app/(tabs)/index.tsx', testID: 'home-screen', refetchTestID: 'home-refetch-banner', compound: true, builder: 'buildHomeRefetchQueries' },
  { file: 'src/app/(tabs)/spending.tsx', testID: 'spending-screen', refetchTestID: 'spending-refetch-banner', compound: true, builder: 'buildSpendingRefetchQueries' },
  { file: 'src/app/(tabs)/transactions.tsx', refetchTestID: 'activity-refetch-banner', compound: true, fatalErrorProp: 'queryErrorMessage(listQuery.error)', builder: 'buildActivityRefetchQueries' },
  { file: 'src/app/bills.tsx', testID: 'bills-screen', refetchTestID: 'bills-refetch-banner' },
  { file: 'src/app/income.tsx', testID: 'income-screen', refetchTestID: 'income-refetch-banner' },
  { file: 'src/app/forecast.tsx', testID: 'forecast-screen', refetchTestID: 'forecast-refetch-banner' },
  { file: 'src/app/review.tsx', testID: 'review-screen', refetchTestID: 'review-refetch-banner' },
  { file: 'src/app/reconcile.tsx', testID: 'reconcile-screen', refetchTestID: 'reconcile-refetch-banner' },
  { file: 'src/app/reimbursement.tsx', testID: 'reimbursement-screen', refetchTestID: 'reimbursement-refetch-banner', compound: true, builder: 'buildReimbursementRefetchQueries' },
  { file: 'src/app/networth.tsx', testID: 'networth-screen', refetchTestID: 'networth-refetch-banner', compound: true, builder: 'buildNetworthRefetchQueries' },
  { file: 'src/app/category/[name].tsx', testID: 'category-detail-screen', refetchTestID: 'category-refetch-banner' },
  { file: 'src/app/account/[id].tsx', testID: 'account-detail-screen', refetchTestID: 'account-refetch-banner', builder: 'buildAccountDetailRefetchQueries' },
  { file: 'src/app/tag/[tag].tsx', testID: 'tag-detail-screen', refetchTestID: 'tag-refetch-banner' },
  { file: 'src/app/merchant/[name].tsx', testID: 'merchant-detail-screen', refetchTestID: 'merchant-refetch-banner' },
  { file: 'src/app/subscriptions.tsx', testID: 'subscriptions-screen', refetchTestID: 'subscriptions-refetch-banner' },
  { file: 'src/app/recurring/[key].tsx', testID: 'recurring-detail-screen', refetchTestID: 'recurring-refetch-banner' },
  { file: 'src/app/goals.tsx', testID: 'goals-screen', refetchTestID: 'goals-refetch-banner', compound: true, builder: 'buildGoalsRefetchQueries' },
  { file: 'src/app/budgets.tsx', testID: 'budgets-screen', refetchTestID: 'budgets-refetch-banner', compound: true, builder: 'buildBudgetsRefetchQueries' },
  { file: 'src/app/cashflow.tsx', testID: 'cashflow-screen', refetchTestID: 'cashflow-refetch-banner' },
  { file: 'src/app/investments.tsx', testID: 'investments-screen', refetchTestID: 'investments-refetch-banner' },
  { file: 'src/app/debt.tsx', testID: 'debt-screen', refetchTestID: 'debt-refetch-banner' },
  { file: 'src/app/rules.tsx', testID: 'rules-screen', refetchTestID: 'rules-refetch-banner', compound: true, builder: 'buildRulesRefetchQueries' },
  { file: 'src/app/events.tsx', testID: 'events-screen', refetchTestID: 'events-refetch-banner' },
  { file: 'src/app/transaction/[id].tsx', testID: 'transaction-detail-screen', refetchTestID: 'transaction-refetch-banner', editor: true, auxRefetchTestID: 'transaction-aux-refetch-banner', builder: 'buildTransactionEditorAuxiliaryRefetchQueries' },
  { file: 'src/app/split/[id].tsx', testID: 'split-editor-screen', refetchTestID: 'split-refetch-banner', editor: true, auxRefetchTestID: 'split-aux-refetch-banner', builder: 'buildSplitEditorAuxiliaryRefetchQueries' },
  { file: 'src/app/add-transaction.tsx', testID: 'add-transaction-screen', refetchTestID: 'add-transaction-refetch-banner', dependencyReads: true, builder: 'buildAddTransactionRefetchQueries' },
];

const EXCLUDED_QUERY_ROUTES = [
  {
    file: 'src/app/onboarding.tsx',
    reason: 'Setup flow only; no finance read queries.',
  },
  SETTINGS_QUERY_EXCLUSION,
  {
    file: 'src/app/(tabs)/_layout.tsx',
    reason: 'Tab chrome only.',
  },
];

function readScreen(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assertUsesQueryDisplayGate(source, file) {
  assert.match(
    source,
    /shouldShowFatalError|resolveQueryDisplay|QueryScreenBody|QueryFatalGate/,
    `${file} must gate fatal errors separately from empty content`,
  );
  assert.match(
    source,
    /ErrorState|QueryScreenBody|QueryFatalGate/,
    `${file} must render ErrorState for fatal fetch failures`,
  );
  assert.doesNotMatch(
    source,
    /isError\s*&&\s*![\w.]+\s*\?\s*\([\s\S]{0,120}?EmptyState/,
    `${file} must not route fatal errors directly to EmptyState`,
  );
}

function assertRefetchAffordance(source, screen) {
  assert.match(
    source,
    /QueryRefetchBanner|QueryRefetchBanners|QueryScreenBody/,
    `${screen.file} must expose a cached-refetch banner or helper`,
  );
  if (screen.refetchTestID) {
    assert.match(source, new RegExp(screen.refetchTestID), `${screen.file} must wire ${screen.refetchTestID}`);
  }
  if (screen.auxRefetchTestID) {
    assert.match(source, new RegExp(screen.auxRefetchTestID), `${screen.file} must wire ${screen.auxRefetchTestID}`);
  }
  if (screen.builder) {
    assert.match(source, new RegExp(screen.builder), `${screen.file} must use ${screen.builder}`);
  }
}

test('query display inventory covers every app route file or explicit exclusion', () => {
  const appDir = path.join(root, 'src/app');
  const routeFiles = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.tsx') && entry.name !== '+not-found.tsx') {
        routeFiles.push(path.relative(root, full));
      }
    }
  }
  walk(appDir);

  const covered = new Set([
    ...DATA_SCREENS.map((s) => s.file),
    ...EXCLUDED_QUERY_ROUTES.map((s) => s.file),
    'src/app/_layout.tsx',
  ]);

  for (const file of routeFiles) {
    assert.ok(covered.has(file), `${file} must appear in DATA_SCREENS or EXCLUDED_QUERY_ROUTES`);
  }
});

test('query display inventory separates fatal errors from empty states', () => {
  for (const screen of DATA_SCREENS) {
    assertUsesQueryDisplayGate(readScreen(screen.file), screen.file);
  }
});

test('query display inventory exposes cached-refetch affordance on data screens', () => {
  for (const screen of DATA_SCREENS) {
    assertRefetchAffordance(readScreen(screen.file), screen);
  }
});

test('compound screen contracts declare primary gate order and refetch membership', () => {
  for (const contract of Object.values(COMPOUND_SCREEN_QUERY_CONTRACTS)) {
    assert.deepEqual(contract.gateOrder, PRIMARY_QUERY_GATE_ORDER);
    assert.ok(contract.primaryQuery, `${contract.file} must name a primary query`);
    assert.ok(contract.refetchMemberKeys.length >= 2, `${contract.file} must list compound members`);
    assert.equal(typeof contract.buildRefetchQueries, 'function');
    const source = readScreen(contract.file);
    assert.match(source, /build\w+RefetchQueries/, `${contract.file} must call exported refetch builder`);
  }
});

test('home refetch builder respects widget enable conditions', () => {
  const base = { today: { id: 't' }, trends: { id: 'tr' }, manual: { id: 'm' }, recurring: { id: 'r' } };
  const allOn = buildHomeRefetchQueries({ ...base, widgets: { netWorth: true, subscriptions: true } });
  assert.deepEqual(allOn, [base.today, base.trends, base.manual, base.recurring]);

  const minimal = buildHomeRefetchQueries({ ...base, widgets: { netWorth: false, subscriptions: false } });
  assert.deepEqual(minimal, [base.today]);
});

test('spending refetch aggregation includes tags used by breakdown toggle', () => {
  const members = {
    spendingQuery: { q: 1 },
    trends: { q: 2 },
    budgets: { q: 3 },
    reimb: { q: 4 },
    insights: { q: 5 },
    tags: { q: 6 },
  };
  const queries = buildSpendingRefetchQueries(members);
  assert.deepEqual(queries, Object.values(members));
  const source = readScreen('src/app/(tabs)/spending.tsx');
  assert.match(source, /tags\.refetch\(\)/);
});

test('activity refetch builder disables events when search or grouping is off', () => {
  const listQuery = { isError: true, data: [{ id: 't' }], refetch: () => {} };
  const accounts = { id: 'a' };
  const categories = { id: 'c' };
  const events = { isError: true, data: { events: [] }, refetch: () => {} };

  const grouped = buildActivityRefetchQueries({
    listQuery, accounts, categories, events, groupEvents: true, searching: false,
  });
  assert.equal(collectRefetchErrorQueries(grouped).length, 2);

  const searchMode = buildActivityRefetchQueries({
    listQuery, accounts, categories, events, groupEvents: true, searching: true,
  });
  assert.equal(collectRefetchErrorQueries(searchMode).length, 1);
  assert.equal(collectRefetchErrorQueries(searchMode)[0], listQuery);

  const eventsOff = buildActivityRefetchQueries({
    listQuery, accounts, categories, events, groupEvents: false, searching: false,
  });
  assert.equal(collectRefetchErrorQueries(eventsOff).length, 1);
  assert.equal(collectRefetchErrorQueries(eventsOff)[0], listQuery);
});

test('editor/detail routes keep content visible with refetch banner on cached failure', () => {
  for (const file of ['src/app/transaction/[id].tsx', 'src/app/split/[id].tsx']) {
    const source = readScreen(file);
    assert.match(source, /shouldShowRefetchError\(detail\.isError, detail\.data\)/, `${file} gates refetch on cached detail`);
    assert.match(source, /detail\.isError[\s\S]*ErrorState/, `${file} keeps fatal retry for empty detail`);
    assert.doesNotMatch(source, /detail\.isError[\s\S]{0,200}?EmptyState/, `${file} must not replace editor with empty state on error`);
  }
});

test('transaction editor auxiliary refetch enumerates rendered dependencies with enable gates', () => {
  const stub = { isError: true, data: { ok: 1 }, refetch: () => {} };
  const disabledSearch = buildTransactionEditorAuxiliaryRefetchQueries({
    categories: stub,
    recurring: stub,
    links: stub,
    receipts: stub,
    allTags: stub,
    events: stub,
    mhist: stub,
    search: stub,
    counterpartyLinks: stub,
    canHistory: true,
    showTags: false,
    linking: false,
    linkQuery: 'abc',
    linkTarget: { id: 'x' },
  });
  const failed = collectRefetchErrorQueries(disabledSearch);
  assert.equal(failed.length, 5);

  const withTags = buildTransactionEditorAuxiliaryRefetchQueries({
    categories: stub,
    recurring: stub,
    links: stub,
    receipts: stub,
    allTags: stub,
    events: stub,
    mhist: { isError: false, data: null, refetch: () => {} },
    search: stub,
    counterpartyLinks: stub,
    canHistory: false,
    showTags: true,
    linking: true,
    linkQuery: 'ab',
    linkTarget: { id: 'x' },
  });
  assert.equal(collectRefetchErrorQueries(withTags).length, 8);
});

test('split editor auxiliary refetch includes categories picker data', () => {
  const categories = { isError: true, data: [{ id: '1' }], refetch: () => {} };
  const queries = buildSplitEditorAuxiliaryRefetchQueries({ categories });
  assert.deepEqual(queries, [categories]);
});

test('account detail refetch aggregates accounts balance and transactions', () => {
  const accounts = { isError: true, data: [{ id: 'a' }], refetch: () => {} };
  const txns = { isError: false, data: [], refetch: () => {} };
  const queries = buildAccountDetailRefetchQueries({ accounts, txns });
  assert.deepEqual(queries, [accounts, txns]);
  assert.equal(collectRefetchErrorQueries(queries).length, 1);
  const source = readScreen('src/app/account/[id].tsx');
  assert.match(source, /buildAccountDetailRefetchQueries/);
  assert.match(source, /accounts\.refetch\(\)/);
});

test('activity fatal ErrorState receives the list query error message', () => {
  const source = readScreen('src/app/(tabs)/transactions.tsx');
  assert.match(source, /ErrorState error=\{queryErrorMessage\(listQuery\.error\)\}/);
});

test('add-transaction dependency reads gate accounts fatally and surface category retry', () => {
  const source = readScreen('src/app/add-transaction.tsx');
  assert.match(source, /shouldShowFatalError\(accounts\.isError, accounts\.data\)/);
  assert.match(source, /buildAddTransactionRefetchQueries/);
  assert.match(source, /add-transaction-categories-retry/);
  const queries = buildAddTransactionRefetchQueries({ accounts: {}, categories: {} });
  assert.deepEqual(queries.length, 2);
});

test('settings reconcile setting does not misrepresent on fatal pending query', () => {
  const pending = { isLoading: false, isError: true, data: undefined, refetch: () => {} };
  const resolved = resolveReconcileEnabledSetting(pending, null);
  assert.equal(resolved.fatalError, true);
  assert.equal(resolved.switchDisabled, true);
  assert.equal(resolved.misrepresentsWhenFatal, true);
  const settingsSource = readScreen('src/app/(tabs)/settings.tsx');
  assert.match(settingsSource, /resolveReconcileEnabledSetting/);
  assert.match(settingsSource, /settings-reconciliation-refetch-banner/);
  assert.match(settingsSource, /settings-reconciliation-retry/);
});

test('rules and events never conflate fatal list fetch with empty state', () => {
  for (const file of ['src/app/rules.tsx', 'src/app/events.tsx']) {
    const source = readScreen(file);
    assert.match(source, /resolveQueryDisplay/, `${file} uses query display helper`);
    assert.match(source, /fatalError[\s\S]*ErrorState/, `${file} renders ErrorState on fatal list fetch`);
    assert.doesNotMatch(source, /isError\s*&&\s*!.*\?\s*\([\s\S]{0,80}?No rules yet/, `${file} must not show rules empty copy on error`);
    assert.doesNotMatch(source, /isError\s*&&\s*!.*\?\s*\([\s\S]{0,80}?No trips yet/, `${file} must not show events empty copy on error`);
  }
});

test('global finance banners mount at root navigation instead of tabs layout', () => {
  const rootLayout = readScreen('src/app/_layout.tsx');
  const tabsLayout = readScreen('src/app/(tabs)/_layout.tsx');
  assert.match(rootLayout, /GlobalFinanceBanners/);
  assert.match(rootLayout, /privacyGateActive/);
  assert.doesNotMatch(tabsLayout, /FinanceStatusBanner/);
  assert.doesNotMatch(tabsLayout, /ReconnectStaleBanner/);
});

test('split fatal detail error exposes accessible Try again retry', () => {
  const source = readScreen('src/app/split/[id].tsx');
  assert.match(source, /detail\.isError[\s\S]*ErrorState/);
  assert.match(source, /retryLabel="Try again"/);
  assert.match(source, /detail\.refetch/);
});

test('multi-query refetch helper consolidates failed queries and respects enabled flag', () => {
  const failed = collectRefetchErrorQueries([
    { isError: true, data: { ok: 1 }, refetch: () => {} },
    { isError: true, data: [], refetch: () => {} },
    { isError: false, data: null, refetch: () => {} },
    { query: { isError: true, data: { stale: 1 }, refetch: () => {} }, enabled: false },
  ]);
  assert.equal(failed.length, 2);
  assert.equal(shouldShowFatalError(true, null), true);
  assert.equal(shouldShowRefetchError(true, { ok: 1 }), true);
  assert.equal(shouldShowRefetchError(true, []), true);
  assert.equal(shouldShowRefetchError(true, undefined), false);
});

test('query display component module exports reusable screen helpers', () => {
  const source = readScreen('src/components/query-display.tsx');
  assert.match(source, /export function QueryScreenBody/);
  assert.match(source, /export function QueryRefetchBanners/);
  assert.match(source, /export function resolveQueryDisplay/);
});

test('collectRefetchErrorQueries retries only failed queries passed to QueryRefetchBanners', () => {
  let a = 0;
  let b = 0;
  const queries = [
    { isError: true, data: { ok: 1 }, refetch: () => { a += 1; } },
    { isError: false, data: { ok: 2 }, refetch: () => { b += 1; } },
  ];
  const failed = collectRefetchErrorQueries(queries);
  failed.forEach((query) => query.refetch?.());
  assert.equal(a, 1);
  assert.equal(b, 0);
});
