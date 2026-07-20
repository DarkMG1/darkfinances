const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

const COLD_ROUTE_FILES = [
  'src/app/bills.tsx',
  'src/app/income.tsx',
  'src/app/debt.tsx',
  'src/app/investments.tsx',
  'src/app/forecast.tsx',
  'src/app/subscriptions.tsx',
  'src/app/merchant/[name].tsx',
];

const DATA_SCREEN_GLOB = [
  ...COLD_ROUTE_FILES,
  'src/app/(tabs)/index.tsx',
  'src/app/(tabs)/spending.tsx',
  'src/app/reconcile.tsx',
  'src/app/review.tsx',
  'src/app/cashflow.tsx',
  'src/app/goals.tsx',
];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('cold-route screens use lazy QueryScreenBody renderContent without data! hero dereferences', () => {
  for (const file of COLD_ROUTE_FILES) {
    const source = read(file);
    assert.match(source, /renderContent=\{/, `${file} must use lazy renderContent`);
    assert.doesNotMatch(source, /<QueryScreenBody[\s\S]*?>[\s\S]*?<\/QueryScreenBody>/, `${file} must not pass eager QueryScreenBody children`);
    assert.doesNotMatch(source, /data!/, `${file} must not non-null assert query data in render tree`);
  }
});

test('bills hasContent requires horizonDays shape needed by hero', () => {
  const source = read('src/app/bills.tsx');
  assert.match(source, /hasContent=\{Boolean\(data\?\.horizonDays/);
  assert.match(source, /renderContent=\{\(billData\)/);
});

test('investments allocation reads use optional byAssetClass chain', () => {
  const source = read('src/app/investments.tsx');
  assert.match(source, /allocation\?\.byAssetClass/);
  assert.doesNotMatch(source, /data\?\.allocation\.byAssetClass/);
});

test('home and spending partial today payloads use optional nested reads', () => {
  const home = read('src/app/(tabs)/index.tsx');
  assert.match(home, /obligations\?\.bills/);
  assert.match(home, /liquidity\?\.safeToSpend/);
  assert.match(home, /spending\?\.current/);

  const spending = read('src/app/(tabs)/spending.tsx');
  assert.match(spending, /spending\?\.current/);
});

test('forecast and merchant partial payload reads stay inside renderContent', () => {
  const forecast = read('src/app/forecast.tsx');
  assert.match(forecast, /points\?\.map/);
  assert.match(forecast, /events\?\.slice/);
  assert.match(forecast, /warnings \?\? \[\]/);
  assert.match(forecast, /formatOptionalMoney/);
  assert.match(forecast, /renderContent=\{\(data\)/);

  const merchant = read('src/app/merchant/[name].tsx');
  assert.match(merchant, /hist\.data\?\.months \?\? \[\]\)\.find/);
  assert.match(merchant, /selMonth\?\.items \?\? \[\]/);
  assert.match(merchant, /formatOptionalMoney\(merchantData\.total/);
});

test('subscriptions renderContent consumes typed data argument', () => {
  const source = read('src/app/subscriptions.tsx');
  assert.match(source, /renderContent=\{\(data\)/);
  assert.match(source, /subscriptionTotals\(data\)/);
  assert.doesNotMatch(source, /renderContent=\{\(\) =>/);
});

test('reconcile drops unused outer item derivations', () => {
  const source = read('src/app/reconcile.tsx');
  assert.doesNotMatch(source, /const items = data\?\.items/);
  assert.match(source, /renderContent=\{\(reconData\)/);
});

test('home review distinguishes unknown count from zero and all-clear', () => {
  const home = read('src/app/(tabs)/index.tsx');
  assert.match(home, /reviewCount != null && reviewCount > 0/);
  assert.match(home, /reviewCount === 0/);
  assert.match(home, /home-review-unavailable/);
  assert.match(home, /formatOptionalPos\(nextIncome\.amount/);
});

test('spending guards largestCharges locally without data!', () => {
  const spending = read('src/app/(tabs)/spending.tsx');
  assert.match(spending, /largestCharges = insights\.data\?\.largestCharges \?\? \[\]/);
  assert.doesNotMatch(spending, /data!/);
});

test('data screens avoid unsafe data! and bare optional-chained property reads in render trees', () => {
  const unsafeOptionalChain = /\?\.\w+\.\w+/;
  for (const file of DATA_SCREEN_GLOB) {
    const source = read(file);
    assert.doesNotMatch(source, /data!/, `${file} must not non-null assert query data in render tree`);
    if (file.includes('transaction/[id].tsx')) continue;
    const renderBody = source.split('renderContent')[1] ?? source;
    const matches = renderBody.match(unsafeOptionalChain) ?? [];
    assert.equal(matches.length, 0, `${file} render tree must not use ?.foo.bar chains (${matches.join(', ')})`);
  }
});

test('reimbursement summary uses fail-closed money fallbacks for absent aggregates', () => {
  const source = read('src/app/reimbursement.tsx');
  assert.match(source, /formatOptionalPos\(summary\?\.fronted/);
  assert.match(source, /formatOptionalPos\(summary\?\.paidBack/);
  assert.match(source, /reimbursementWindowNet\(summary\)/);
  assert.doesNotMatch(source, /fmtPos\(summary\?\.fronted \?\? 0\)/);
});

test('recurring detail resolves items with empty fallback', () => {
  const source = read('src/app/recurring/[key].tsx');
  assert.match(source, /recurring\.data\?\.items \?\? \[\]\)\.find/);
});
