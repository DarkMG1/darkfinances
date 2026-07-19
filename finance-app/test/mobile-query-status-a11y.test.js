const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { resolveAccessibilityAnnouncement } = require('../src/lib/accessibility-announcement.js');
const layer = require('../src/lib/global-finance-banner-layer.js');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('resolveAccessibilityAnnouncement skips empty and unchanged messages', () => {
  assert.deepEqual(resolveAccessibilityAnnouncement('', ''), { announce: false, next: '' });
  assert.deepEqual(resolveAccessibilityAnnouncement('', '   '), { announce: false, next: '' });
  assert.deepEqual(resolveAccessibilityAnnouncement('Server unavailable', 'Server unavailable'), {
    announce: false,
    next: 'Server unavailable',
  });
});

test('resolveAccessibilityAnnouncement trims and announces new messages', () => {
  assert.deepEqual(resolveAccessibilityAnnouncement('', '  Could not refresh  '), {
    announce: true,
    next: 'Could not refresh',
    message: 'Could not refresh',
  });
  assert.deepEqual(resolveAccessibilityAnnouncement('Could not refresh', 'Finance sync needs attention'), {
    announce: true,
    next: 'Finance sync needs attention',
    message: 'Finance sync needs attention',
  });
});

test('AccessibilityLiveRegion wires announceForAccessibility and polite live region semantics', () => {
  const source = read('src/components/accessibility-live-region.tsx');
  assert.match(source, /resolveAccessibilityAnnouncement/);
  assert.match(source, /AccessibilityInfo\.announceForAccessibility/);
  assert.match(source, /accessibilityLiveRegion="polite"/);
  assert.match(source, /useRef\(/);
});

test('MutationLiveRegion reuses shared AccessibilityLiveRegion', () => {
  const source = read('src/components/mutation-form.tsx');
  assert.match(source, /import \{ AccessibilityLiveRegion \} from '@\/components\/accessibility-live-region'/);
  assert.match(source, /return <AccessibilityLiveRegion message=\{message\} \/>;/);
  assert.doesNotMatch(source, /AccessibilityInfo\.announceForAccessibility/);
});

test('QueryRefetchBanner announces refetch failures without duplicating pressable labels', () => {
  const source = read('src/components/query-refetch-banner.tsx');
  assert.match(source, /<AccessibilityLiveRegion message=\{message\} \/>/);
  assert.match(source, /accessibilityRole="button"/);
  assert.match(source, /accessibilityLabel=\{message\}/);
  assert.match(source, /accessibilityElementsHidden/);
  assert.doesNotMatch(source, /accessibilityLiveRegion="polite"/);
});

test('FinanceStatusBanner announces server and sync failures', () => {
  const source = read('src/components/finance-status-banner.tsx');
  assert.match(source, /<AccessibilityLiveRegion message=\{text\} \/>/);
  assert.match(source, /const text = ping\.isError/);
  assert.match(source, /Server unavailable/);
  assert.match(source, /Finance sync needs attention/);
  assert.match(source, /accessibilityRole="button"/);
  assert.match(source, /accessibilityLabel=\{text\}/);
});

test('ReconnectStaleBanner announces stale warnings via shared live region', () => {
  const source = read('src/components/reconnect-stale-banner.tsx');
  assert.match(source, /<AccessibilityLiveRegion message=\{announcement\} \/>/);
  assert.match(source, /const announcement = `\$\{text\}\. Tap to retry refresh\.`;/);
  assert.match(source, /accessibilityRole="button"/);
  assert.match(source, /accessibilityLabel=\{announcement\}/);
  assert.doesNotMatch(source, /accessibilityLiveRegion="polite"/);
  assert.match(source, /testID="reconnect-stale-banner"/);
});

test('ErrorState fatal errors announce resolved message including fallback copy', () => {
  const source = read('src/components/ui.tsx');
  const errorState = source.slice(source.indexOf('export function ErrorState'), source.indexOf('export const text'));
  assert.match(errorState, /<AccessibilityLiveRegion message=\{message\} \/>/);
  assert.match(errorState, /const message = error \|\| 'Something went wrong'/);
  assert.match(errorState, /accessibilityRole="button"/);
  assert.match(errorState, /accessibilityLabel=\{retryLabel\}/);
});

test('global finance banners stay unmounted during privacy gate so status announcements do not leak', () => {
  assert.equal(layer.shouldMountGlobalFinanceBanners(true, true), false);
  const globalBanners = read('src/components/global-finance-banners.tsx');
  assert.match(globalBanners, /shouldMountGlobalFinanceBanners\(true, privacyGateActive\)/);
  assert.match(globalBanners, /<FinanceStatusBanner/);
  assert.match(globalBanners, /<ReconnectStaleBanner/);
  assert.match(read('src/components/finance-status-banner.tsx'), /AccessibilityLiveRegion/);
});
