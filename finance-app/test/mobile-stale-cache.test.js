const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  shouldShowInitialLoad,
  shouldShowFatalError,
  shouldShowRefetchError,
  isSearchQuerySettled,
  transactionsWindowKey,
  isQueryWindowCurrent,
} = require('../src/lib/query-display-state.js');
const {
  createSettingsConnectionSaveAdmission,
  runSettingsConnectionSave,
} = require('../src/lib/settings-connection-save.js');
const { statCardAccessibilityLabel, heroMetricAccessibilityLabel } = require('../src/lib/metric-a11y.js');

const root = path.resolve(__dirname, '..');

test('query display keeps cached payload visible on refetch error', () => {
  const cached = { total: 42 };
  assert.equal(shouldShowInitialLoad(true, cached), false);
  assert.equal(shouldShowFatalError(true, cached), false);
  assert.equal(shouldShowRefetchError(true, cached), true);
  assert.equal(shouldShowFatalError(true, null), true);
  assert.equal(shouldShowInitialLoad(true, null), true);
});

test('query display treats empty arrays as cached data', () => {
  assert.equal(shouldShowFatalError(true, []), false);
  assert.equal(shouldShowRefetchError(true, []), true);
});

test('search query settlement avoids stale debounced mismatches', () => {
  assert.equal(isSearchQuerySettled('a', 'a'), true);
  assert.equal(isSearchQuerySettled('amazon', 'amaz'), false);
  assert.equal(isSearchQuerySettled('amazon', 'amazon'), true);
  assert.equal(isSearchQuerySettled('  amazon  ', 'amazon'), true);
  assert.equal(isSearchQuerySettled('a', ''), true);
});

test('transactions window keys distinguish range/account/collapse', () => {
  const a = transactionsWindowKey({ start: '2026-01-01', accountId: null, collapse: true });
  const b = transactionsWindowKey({ start: '2026-04-01', accountId: null, collapse: true });
  const c = transactionsWindowKey({ start: '2026-01-01', accountId: 'acct-1', collapse: true });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.equal(isQueryWindowCurrent(a, a), true);
  assert.equal(isQueryWindowCurrent(a, b), false);
});

test('settings connection save admission rejects concurrent verify/purge/setConfig', async () => {
  const admission = createSettingsConnectionSaveAdmission();
  let running = 0;
  let maxRunning = 0;
  const task = async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((resolve) => setTimeout(resolve, 20));
    running -= 1;
    return 'ok';
  };

  const first = runSettingsConnectionSave(admission, task);
  const second = runSettingsConnectionSave(admission, task);
  const [a, b] = await Promise.all([first, second]);
  const outcomes = [a, b];
  assert.equal(outcomes.filter((o) => o.skipped).length, 1);
  assert.equal(outcomes.filter((o) => o.ok).length, 1);
  assert.equal(maxRunning, 1);
  assert.equal(admission.isBusy(), false);
});

test('metric a11y helpers consolidate label/value/sub without duplication', () => {
  assert.equal(statCardAccessibilityLabel({ label: 'Spent', value: '$100.00', sub: '▲ 5% vs prev' }), 'Spent, $100.00, ▲ 5% vs prev');
  assert.equal(heroMetricAccessibilityLabel('Net worth', '$10,000.00', 'assets and liabilities'), 'Net worth, $10,000.00, assets and liabilities');
});

test('spending tab uses fatal error gate only when payload missing', () => {
  const source = fs.readFileSync(path.join(root, 'src/app/(tabs)/spending.tsx'), 'utf8');
  assert.match(source, /shouldShowFatalError/);
  assert.match(source, /shouldShowRefetchError/);
  assert.match(source, /QueryRefetchBanner/);
  assert.doesNotMatch(source, /spendingIsError\s*\?\s*\(/);
});

test('activity tab preserves cached list and settled search results', () => {
  const source = fs.readFileSync(path.join(root, 'src/app/(tabs)/transactions.tsx'), 'utf8');
  assert.match(source, /isSearchQuerySettled/);
  assert.match(source, /shouldShowFatalError/);
  assert.match(source, /searchSettled/);
  assert.match(source, /QueryRefetchBanner/);
  assert.match(source, /categorizeAction\.isLocked/);
});

test('review navigation is gated while acknowledge mutation is locked', () => {
  const source = fs.readFileSync(path.join(root, 'src/app/review.tsx'), 'utf8');
  assert.match(source, /if \(acknowledgeAction\.isLocked\) return;/);
  assert.match(source, /disabled={acknowledgeAction\.isLocked}/);
  assert.match(source, /if \(navLocked\) return/);
});

test('settings connection saves share one admission guard with busy UI', () => {
  const source = fs.readFileSync(path.join(root, 'src/app/(tabs)/settings.tsx'), 'utf8');
  assert.match(source, /createSettingsConnectionSaveAdmission/);
  assert.match(source, /runSettingsConnectionSave/);
  assert.match(source, /disabled={connectionBusy}/);
  assert.match(source, /accessibilityState={{ disabled: connectionBusy, busy: connectionBusy }}/);
});

test('reimbursement range chips disable while confirm/dismiss in flight', () => {
  const source = fs.readFileSync(path.join(root, 'src/app/reimbursement.tsx'), 'utf8');
  assert.match(source, /disabled={rangeLocked}/);
  assert.match(source, /const rangeLocked = banner\.isLocked/);
});

test('StatCard exposes one consolidated accessibility label', () => {
  const source = fs.readFileSync(path.join(root, 'src/components/ui.tsx'), 'utf8');
  assert.match(source, /accessibilityElementsHidden/);
  assert.match(source, /accessible accessibilityLabel={a11yLabel}/);
});
