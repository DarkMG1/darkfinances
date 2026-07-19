const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  resolveAccessibilityAnnouncement,
  shouldUseExplicitAccessibilityAnnouncement,
  shouldUseVisibleLiveRegion,
} = require('../src/lib/accessibility-announcement.js');
const layer = require('../src/lib/global-finance-banner-layer.js');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
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

test('platform contract splits explicit iOS announce from visible live region', () => {
  assert.equal(shouldUseExplicitAccessibilityAnnouncement('ios'), true);
  assert.equal(shouldUseExplicitAccessibilityAnnouncement('android'), false);
  assert.equal(shouldUseExplicitAccessibilityAnnouncement('web'), false);
  assert.equal(shouldUseVisibleLiveRegion('android'), true);
  assert.equal(shouldUseVisibleLiveRegion('web'), true);
  assert.equal(shouldUseVisibleLiveRegion('ios'), false);
});

test('AccessibilityAnnouncementEffect is effect-only and never focusable', () => {
  const source = read('src/components/accessibility-live-region.tsx');
  assert.match(source, /export function AccessibilityAnnouncementEffect/);
  assert.match(source, /return null;/);
  assert.match(source, /shouldUseExplicitAccessibilityAnnouncement\(Platform\.OS\)/);
  assert.match(source, /AccessibilityInfo\.announceForAccessibility/);
  assert.doesNotMatch(source, /export function AccessibilityLiveRegion/);
});

test('visible banners use one pressable label and never mount AccessibilityLiveRegion', () => {
  for (const rel of VISIBLE_BANNERS) {
    const source = read(rel);
    assert.doesNotMatch(source, /<AccessibilityLiveRegion/, `${rel} must not render hidden live region duplicate`);
    assert.match(source, /<AccessibilityAnnouncementEffect message=/, `${rel} must wire iOS explicit announce effect`);
    assert.match(source, /\{\.\.\.visibleStatusLiveRegionProps\(\)\}/, `${rel} must attach live region to visible control only`);
    assert.match(source, /accessibilityRole="button"/, `${rel} keeps pressable retry`);
    assert.equal((source.match(/accessibilityRole="button"/g) || []).length, 1, `${rel} must expose exactly one button`);
    assert.doesNotMatch(source, /accessible=\{true\}/, `${rel} must not add extra accessible nodes`);
  }
});

test('MutationLiveRegion uses mutation-only sr-only live region without empty focus stop', () => {
  const mutationForm = read('src/components/mutation-form.tsx');
  assert.match(mutationForm, /MutationStatusLiveRegion message=\{message\}/);
  assert.doesNotMatch(mutationForm, /AccessibilityLiveRegion/);
  const liveRegion = read('src/components/accessibility-live-region.tsx');
  assert.match(liveRegion, /export function MutationStatusLiveRegion/);
  assert.match(liveRegion, /if \(!label\) return null;/);
  assert.match(liveRegion, /accessible=\{false\}/);
});

test('ErrorState uses visible error text as live region surface with separate retry button', () => {
  const source = read('src/components/ui.tsx');
  const errorState = source.slice(source.indexOf('export function ErrorState'), source.indexOf('export const text'));
  assert.match(errorState, /<AccessibilityAnnouncementEffect message=\{message\} \/>/);
  assert.doesNotMatch(errorState, /<AccessibilityLiveRegion/);
  assert.match(errorState, /\{\.\.\.visibleStatusLiveRegionProps\(\)\}/);
  assert.match(errorState, /accessibilityRole="text"/);
  assert.match(errorState, /accessibilityRole="button"/);
  assert.match(errorState, /accessibilityLabel=\{retryLabel\}/);
});

test('global finance banners stay unmounted during privacy gate so status announcements do not leak', () => {
  assert.equal(layer.shouldMountGlobalFinanceBanners(true, true), false);
  const globalBanners = read('src/components/global-finance-banners.tsx');
  assert.match(globalBanners, /shouldMountGlobalFinanceBanners\(true, privacyGateActive\)/);
});
