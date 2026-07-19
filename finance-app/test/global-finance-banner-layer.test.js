const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const layer = require('../src/lib/global-finance-banner-layer.js');

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

test('route-aware banner layout avoids tab and push native headers', () => {
  const tabs = layer.resolveGlobalFinanceBannerLayout(['(tabs)', 'index']);
  assert.equal(tabs.mode, 'tabs');
  assert.ok(tabs.topInset > 40, 'tab banners sit below custom Screen header');

  const push = layer.resolveGlobalFinanceBannerLayout(['networth']);
  assert.equal(push.mode, 'pushNative');
  assert.ok(push.topInset >= 44, 'push banners sit below native navigation header');

  const hidden = layer.resolveGlobalFinanceBannerLayout(['split', '[id]']);
  assert.equal(hidden.mode, 'hiddenHeader');
  assert.ok(hidden.topInset >= 44, 'modal custom header routes offset banners');

  const txn = layer.resolveGlobalFinanceBannerLayout(['transaction', '[id]']);
  assert.equal(txn.mode, 'hiddenHeader', 'transaction detail hides native header');

  const category = layer.resolveGlobalFinanceBannerLayout(['category', '[name]']);
  assert.equal(category.mode, 'hiddenHeader', 'category detail hides native header');

  const offsets = layer.resolveGlobalFinanceBannerOffsets(59, push);
  assert.equal(offsets.statusTop, 59 + push.topInset);
  assert.ok(offsets.staleTop > offsets.statusTop);
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
