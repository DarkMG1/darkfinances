const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  shouldShowFatalError,
  shouldShowRefetchError,
  collectRefetchErrorQueries,
} = require('../src/lib/query-display-state.js');

const root = path.resolve(__dirname, '..');

const DATA_SCREENS = [
  { file: 'src/app/(tabs)/index.tsx', testID: 'home-screen', refetchTestID: 'home-refetch-banner' },
  { file: 'src/app/(tabs)/spending.tsx', testID: 'spending-screen', refetchTestID: 'spending-refetch-banner' },
  { file: 'src/app/(tabs)/transactions.tsx', refetchTestID: 'activity-refetch-banner' },
  { file: 'src/app/bills.tsx', testID: 'bills-screen', refetchTestID: 'bills-refetch-banner' },
  { file: 'src/app/income.tsx', testID: 'income-screen', refetchTestID: 'income-refetch-banner' },
  { file: 'src/app/forecast.tsx', testID: 'forecast-screen', refetchTestID: 'forecast-refetch-banner' },
  { file: 'src/app/review.tsx', testID: 'review-screen', refetchTestID: 'review-refetch-banner' },
  { file: 'src/app/reconcile.tsx', testID: 'reconcile-screen', refetchTestID: 'reconcile-refetch-banner' },
  { file: 'src/app/reimbursement.tsx', testID: 'reimbursement-screen', refetchTestID: 'reimbursement-refetch-banner' },
  { file: 'src/app/networth.tsx', testID: 'networth-screen', refetchTestID: 'networth-refetch-banner' },
  { file: 'src/app/category/[name].tsx', testID: 'category-detail-screen', refetchTestID: 'category-refetch-banner' },
  { file: 'src/app/account/[id].tsx', testID: 'account-detail-screen', refetchTestID: 'account-refetch-banner' },
  { file: 'src/app/tag/[tag].tsx', testID: 'tag-detail-screen', refetchTestID: 'tag-refetch-banner' },
  { file: 'src/app/merchant/[name].tsx', testID: 'merchant-detail-screen', refetchTestID: 'merchant-refetch-banner' },
  { file: 'src/app/subscriptions.tsx', testID: 'subscriptions-screen', refetchTestID: 'subscriptions-refetch-banner' },
  { file: 'src/app/recurring/[key].tsx', testID: 'recurring-detail-screen', refetchTestID: 'recurring-refetch-banner' },
  { file: 'src/app/goals.tsx', testID: 'goals-screen', refetchTestID: 'goals-refetch-banner' },
  { file: 'src/app/budgets.tsx', testID: 'budgets-screen', refetchTestID: 'budgets-refetch-banner' },
  { file: 'src/app/cashflow.tsx', testID: 'cashflow-screen', refetchTestID: 'cashflow-refetch-banner' },
  { file: 'src/app/investments.tsx', testID: 'investments-screen', refetchTestID: 'investments-refetch-banner' },
  { file: 'src/app/debt.tsx', testID: 'debt-screen', refetchTestID: 'debt-refetch-banner' },
  { file: 'src/app/rules.tsx', testID: 'rules-screen', refetchTestID: 'rules-refetch-banner' },
  { file: 'src/app/events.tsx', testID: 'events-screen', refetchTestID: 'events-refetch-banner' },
];

function readScreen(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('query display inventory separates fatal errors from empty states', () => {
  for (const screen of DATA_SCREENS) {
    const source = readScreen(screen.file);
    assert.match(
      source,
      /shouldShowFatalError|resolveQueryDisplay|QueryScreenBody|QueryFatalGate/,
      `${screen.file} must gate fatal errors separately from empty content`,
    );
    assert.match(
      source,
      /ErrorState|QueryScreenBody|QueryFatalGate/,
      `${screen.file} must render ErrorState for fatal fetch failures`,
    );
    assert.doesNotMatch(
      source,
      /isError\s*&&\s*![\w.]+\s*\?\s*\([\s\S]{0,120}?EmptyState/,
      `${screen.file} must not route fatal errors directly to EmptyState`,
    );
  }
});

test('query display inventory exposes cached-refetch affordance on data screens', () => {
  for (const screen of DATA_SCREENS) {
    const source = readScreen(screen.file);
    assert.match(
      source,
      /QueryRefetchBanner|QueryRefetchBanners|QueryScreenBody/,
      `${screen.file} must expose a cached-refetch banner or helper`,
    );
    if (screen.refetchTestID) {
      assert.match(source, new RegExp(screen.refetchTestID), `${screen.file} must wire ${screen.refetchTestID}`);
    }
  }
});

test('rules and events never conflate fatal list fetch with empty state', () => {
  for (const file of ['src/app/rules.tsx', 'src/app/events.tsx']) {
    const source = readScreen(file);
    assert.match(source, /resolveQueryDisplay/, `${file} uses query display helper`);
    assert.match(source, /fatalError[\s\S]*ErrorState/, `${file} renders ErrorState on fatal list fetch`);
    assert.match(source, /refetchError[\s\S]*QueryRefetchBanner/, `${file} keeps forms/list visible with refetch banner`);
    assert.doesNotMatch(source, /isError\s*&&\s*!.*\?\s*\([\s\S]{0,80}?No rules yet/, `${file} must not show rules empty copy on error`);
    assert.doesNotMatch(source, /isError\s*&&\s*!.*\?\s*\([\s\S]{0,80}?No trips yet/, `${file} must not show events empty copy on error`);
  }
});

test('home shows today refetch banner independent of ping health strip', () => {
  const source = readScreen('src/app/(tabs)/index.tsx');
  assert.match(source, /shouldShowRefetchError\(today\.isError, today\.data\)/);
  assert.match(source, /home-refetch-banner/);
  assert.match(source, /todayFatal[\s\S]*ErrorState|shouldShowFatalError\(today\.isError, today\.data\)[\s\S]*ErrorState/);
});

test('global finance banners mount at root navigation instead of tabs layout', () => {
  const rootLayout = readScreen('src/app/_layout.tsx');
  const tabsLayout = readScreen('src/app/(tabs)/_layout.tsx');
  assert.match(rootLayout, /GlobalFinanceBanners/);
  assert.doesNotMatch(tabsLayout, /FinanceStatusBanner/);
  assert.doesNotMatch(tabsLayout, /ReconnectStaleBanner/);
});

test('split fatal detail error exposes accessible Try again retry', () => {
  const source = readScreen('src/app/split/[id].tsx');
  assert.match(source, /detail\.isError[\s\S]*ErrorState/);
  assert.match(source, /retryLabel="Try again"/);
  assert.match(source, /detail\.refetch/);
});

test('investments and debt hero totals use consolidated accessibility labels', () => {
  for (const file of ['src/app/investments.tsx', 'src/app/debt.tsx']) {
    const source = readScreen(file);
    assert.match(source, /heroMetricAccessibilityLabel/);
    assert.match(source, /accessibilityElementsHidden/);
  }
});

test('multi-query refetch helper consolidates failed queries without duplicate banners', () => {
  const failed = collectRefetchErrorQueries([
    { isError: true, data: { ok: 1 }, refetch: () => {} },
    { isError: true, data: [], refetch: () => {} },
    { isError: false, data: null, refetch: () => {} },
  ]);
  assert.equal(failed.length, 2);
  assert.equal(shouldShowFatalError(true, null), true);
  assert.equal(shouldShowRefetchError(true, { ok: 1 }), true);
  assert.equal(shouldShowRefetchError(true, []), true);

  const budgets = readScreen('src/app/budgets.tsx');
  assert.match(budgets, /QueryRefetchBanners queries=\{\[budgets, trends\]\}/);

  const networth = readScreen('src/app/networth.tsx');
  assert.match(networth, /QueryRefetchBanners queries=\{\[accounts, today, trends, manual\]\}/);
});

test('query display component module exports reusable screen helpers', () => {
  const source = readScreen('src/components/query-display.tsx');
  assert.match(source, /export function QueryScreenBody/);
  assert.match(source, /export function QueryRefetchBanners/);
  assert.match(source, /export function resolveQueryDisplay/);
});
