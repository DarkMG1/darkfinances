const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  resolveAccessibilityAnnouncement,
  shouldUseExplicitVisibleStatusAnnouncement,
  shouldUseVisibleStatusLiveRegion,
  shouldUseExplicitNativeMutationAnnouncement,
  shouldUseWebMutationLiveRegionSurface,
  resolveMutationStatusPresentation,
} = require('../src/lib/accessibility-announcement.js');
const layer = require('../src/lib/global-finance-banner-layer.js');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function mutationStatusLiveRegionSource() {
  const source = read('src/components/accessibility-live-region.tsx');
  const start = source.indexOf('export function MutationStatusLiveRegion');
  const end = source.indexOf('const styles = StyleSheet.create', start);
  return source.slice(start, end);
}

const VISIBLE_BANNERS = [
  'src/components/query-refetch-banner.tsx',
  'src/components/finance-status-banner.tsx',
  'src/components/reconnect-stale-banner.tsx',
];

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
});

test('visible status platform policy keeps iOS explicit and Android/web live region', () => {
  assert.equal(shouldUseExplicitVisibleStatusAnnouncement('ios'), true);
  assert.equal(shouldUseExplicitVisibleStatusAnnouncement('android'), false);
  assert.equal(shouldUseExplicitVisibleStatusAnnouncement('web'), false);
  assert.equal(shouldUseVisibleStatusLiveRegion('android'), true);
  assert.equal(shouldUseVisibleStatusLiveRegion('web'), true);
  assert.equal(shouldUseVisibleStatusLiveRegion('ios'), false);
});

test('mutation status platform policy uses native explicit announce and web-only surface', () => {
  assert.equal(shouldUseExplicitNativeMutationAnnouncement('ios'), true);
  assert.equal(shouldUseExplicitNativeMutationAnnouncement('android'), true);
  assert.equal(shouldUseExplicitNativeMutationAnnouncement('web'), false);
  assert.equal(shouldUseWebMutationLiveRegionSurface('web'), true);
  assert.equal(shouldUseWebMutationLiveRegionSurface('ios'), false);
  assert.equal(shouldUseWebMutationLiveRegionSurface('android'), false);
});

test('resolveMutationStatusPresentation keeps Android on explicit announce with no render surface', () => {
  assert.deepEqual(resolveMutationStatusPresentation('android', 'Saved'), {
    explicitAnnounce: true,
    webLiveRegionSurface: false,
  });
  assert.deepEqual(resolveMutationStatusPresentation('ios', 'Saved'), {
    explicitAnnounce: true,
    webLiveRegionSurface: false,
  });
  assert.deepEqual(resolveMutationStatusPresentation('web', 'Saved'), {
    explicitAnnounce: false,
    webLiveRegionSurface: true,
  });
  assert.deepEqual(resolveMutationStatusPresentation('android', '   '), {
    explicitAnnounce: false,
    webLiveRegionSurface: false,
  });
});

test('AccessibilityAnnouncementEffect is visible-status effect-only and never focusable', () => {
  const source = read('src/components/accessibility-live-region.tsx');
  assert.match(source, /export function AccessibilityAnnouncementEffect/);
  assert.match(source, /useVisibleStatusAnnouncement\(message\)/);
  assert.match(source, /return null;/);
  assert.match(source, /shouldUseExplicitVisibleStatusAnnouncement\(Platform\.OS\)/);
  assert.match(source, /AccessibilityInfo\.announceForAccessibility/);
  assert.doesNotMatch(source, /export function AccessibilityLiveRegion/);
});

test('visible banners use one pressable label and never mount hidden live region duplicates', () => {
  for (const rel of VISIBLE_BANNERS) {
    const source = read(rel);
    assert.doesNotMatch(source, /<AccessibilityLiveRegion|<MutationStatusLiveRegion/, `${rel} must not render hidden live region duplicate`);
    assert.match(source, /<AccessibilityAnnouncementEffect message=/, `${rel} must wire visible-status iOS explicit announce effect`);
    assert.match(source, /\{\.\.\.visibleStatusLiveRegionProps\(\)\}/, `${rel} must attach live region to visible control only`);
    assert.match(source, /accessibilityRole="button"/, `${rel} keeps pressable retry`);
    assert.equal((source.match(/accessibilityRole="button"/g) || []).length, 1, `${rel} must expose exactly one button`);
    assert.doesNotMatch(source, /useNativeMutationAnnouncement/, `${rel} must not use mutation-only announce hook`);
  }
});

test('MutationStatusLiveRegion uses native explicit announce and renders null on Android', () => {
  const mutationForm = read('src/components/mutation-form.tsx');
  assert.match(mutationForm, /MutationStatusLiveRegion message=\{message\}/);
  assert.doesNotMatch(mutationForm, /AccessibilityAnnouncementEffect/);

  const liveRegion = read('src/components/accessibility-live-region.tsx');
  assert.match(liveRegion, /export function useNativeMutationAnnouncement/);
  assert.match(liveRegion, /shouldUseExplicitNativeMutationAnnouncement\(Platform\.OS\)/);
  assert.match(liveRegion, /shouldUseWebMutationLiveRegionSurface\(Platform\.OS\)/);

  const mutationBlock = mutationStatusLiveRegionSource();
  assert.match(mutationBlock, /useNativeMutationAnnouncement\(message\)/);
  assert.match(mutationBlock, /if \(!shouldUseWebMutationLiveRegionSurface\(Platform\.OS\) \|\| !label\) return null;/);
  assert.doesNotMatch(mutationBlock, /importantForAccessibility="no"/);
  assert.doesNotMatch(mutationBlock, /accessible=\{false\}/);
  assert.doesNotMatch(mutationBlock, /<Text/);
  assert.match(mutationBlock, /focusable=\{false\}/);
});

test('ErrorState uses visible error text as live region surface with separate retry button', () => {
  const source = read('src/components/ui.tsx');
  const errorState = source.slice(source.indexOf('export function ErrorState'), source.indexOf('export const text'));
  assert.match(errorState, /<AccessibilityAnnouncementEffect message=\{message\} \/>/);
  assert.doesNotMatch(errorState, /<MutationStatusLiveRegion|<AccessibilityLiveRegion/);
  assert.match(errorState, /\{\.\.\.visibleStatusLiveRegionProps\(\)\}/);
  assert.match(errorState, /accessibilityRole="text"/);
  assert.match(errorState, /accessibilityRole="button"/);
  assert.match(errorState, /accessibilityLabel=\{retryLabel\}/);
  assert.doesNotMatch(errorState, /useNativeMutationAnnouncement/);
});

test('global finance banners stay unmounted during privacy gate so status announcements do not leak', () => {
  assert.equal(layer.shouldMountGlobalFinanceBanners(true, true), false);
  const globalBanners = read('src/components/global-finance-banners.tsx');
  assert.match(globalBanners, /shouldMountGlobalFinanceBanners\(true, privacyGateActive\)/);
});
