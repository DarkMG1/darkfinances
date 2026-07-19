const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const layer = require('../src/lib/global-finance-banner-layer.js');
const metrics = require('../src/lib/route-header-metrics.js');

const root = path.resolve(__dirname, '..');

function readScreen(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('privacy lock and demo watermark z-index always win over global finance banners', () => {
  assert.equal(layer.privacyOverlayWinsOverGlobalBanners(), true);
  assert.ok(layer.PRIVACY_COVER_Z_INDEX > layer.GLOBAL_FINANCE_BANNER_Z_INDEX);
  assert.ok(layer.PRIVACY_LOCK_Z_INDEX > layer.GLOBAL_FINANCE_BANNER_Z_INDEX);
  assert.ok(layer.DEMO_WATERMARK_Z_INDEX > layer.GLOBAL_FINANCE_BANNER_Z_INDEX);
});

test('global finance banners unmount while privacy gate is active', () => {
  assert.equal(layer.shouldMountGlobalFinanceBanners(true, true), false);
  assert.equal(layer.shouldMountGlobalFinanceBanners(true, false), true);
  assert.equal(layer.shouldMountGlobalFinanceBanners(false, false), false);

  const layoutSource = readScreen('src/app/_layout.tsx');
  assert.match(layoutSource, /privacyGateActive=\{!!faceId && \(privacyVisible \|\| !unlocked \|\| lockFading\)\}/);
  assert.match(layoutSource, /GlobalFinanceBanners[\s\S]*privacyGateActive/);

  const bannerSource = readScreen('src/components/global-finance-banners.tsx');
  assert.match(bannerSource, /shouldMountGlobalFinanceBanners/);
  assert.match(bannerSource, /GLOBAL_FINANCE_BANNER_Z_INDEX/);
  assert.doesNotMatch(bannerSource, /zIndex:\s*10_?000/);
});

test('route-aware banner layout derives header metrics from screen styles', () => {
  const safeTop = 59;
  const tabs = layer.resolveGlobalFinanceBannerLayout(['(tabs)', 'index']);
  assert.equal(tabs.mode, 'tabs');
  assert.equal(tabs.topInset, metrics.tabScreenHeaderBelowSafeArea() + 4);

  const push = layer.resolveGlobalFinanceBannerLayout(['networth']);
  assert.equal(push.mode, 'pushNative');
  assert.equal(push.topInset, metrics.NATIVE_STACK_HEADER_HEIGHT + 4);

  const splitLayout = layer.resolveGlobalFinanceBannerLayout(['split', '[id]']);
  assert.equal(splitLayout.mode, 'hiddenHeader');
  assert.equal(splitLayout.routeName, 'split');
  const splitOffsets = layer.resolveGlobalFinanceBannerOffsets(safeTop, splitLayout);
  assert.equal(
    splitOffsets.statusTop,
    safeTop + metrics.splitEditorHeaderBelowSafeArea() + 4,
  );

  const txnLayout = layer.resolveGlobalFinanceBannerLayout(['transaction', '[id]']);
  assert.equal(txnLayout.mode, 'hiddenHeader');
  const txnOffsets = layer.resolveGlobalFinanceBannerOffsets(safeTop, txnLayout);
  assert.equal(
    txnOffsets.statusTop,
    safeTop + metrics.transactionEditorHeaderBelowSafeArea() + 4,
  );
  assert.ok(txnOffsets.statusTop > safeTop + 50, 'transaction custom header clears menu top bar');

  const categoryLayout = layer.resolveGlobalFinanceBannerLayout(['category', '[name]']);
  const categoryOffsets = layer.resolveGlobalFinanceBannerOffsets(safeTop, categoryLayout);
  assert.equal(
    categoryOffsets.statusTop,
    safeTop + metrics.categoryDetailHeaderBelowSafeArea(safeTop) + 4,
  );
  assert.ok(categoryOffsets.staleTop > categoryOffsets.statusTop);
});

test('root layout keeps privacy overlay after demo watermark and finance banners', () => {
  const source = readScreen('src/app/_layout.tsx');
  const bannerIdx = source.indexOf('<GlobalFinanceBanners');
  const demoIdx = source.indexOf('style={styles.demoWatermark}');
  const privacyIdx = source.indexOf('<PrivacyGateOverlay');
  assert.ok(bannerIdx > 0 && demoIdx > bannerIdx && privacyIdx > demoIdx);
  assert.match(source, /lockOverlay:[\s\S]*zIndex:\s*9998/);
  assert.match(source, /demoWatermark:[\s\S]*zIndex:\s*9000/);
});
