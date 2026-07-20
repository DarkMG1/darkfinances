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
  assert.match(forecast, /renderContent=\{\(data\)/);

  const merchant = read('src/app/merchant/[name].tsx');
  assert.match(merchant, /hist\.data\?\.months \?\? \[\]\)\.find/);
  assert.match(merchant, /selMonth\?\.items \?\? \[\]/);
});

test('recurring detail resolves items with empty fallback', () => {
  const source = read('src/app/recurring/[key].tsx');
  assert.match(source, /recurring\.data\?\.items \?\? \[\]\)\.find/);
});
