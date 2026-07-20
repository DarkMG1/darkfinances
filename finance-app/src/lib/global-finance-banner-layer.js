/**
 * Z-order and layout contracts for root-level finance connectivity banners.
 * Privacy lock and demo watermark must always win over GlobalFinanceBanners.
 */

const {
  hiddenHeaderBelowSafeArea,
  NATIVE_STACK_HEADER_HEIGHT,
  tabScreenHeaderBelowSafeArea,
} = require('./route-header-metrics.js');

/** Above normal Stack content; below demo watermark and privacy overlays. */
const GLOBAL_FINANCE_BANNER_Z_INDEX = 100;

const DEMO_WATERMARK_Z_INDEX = 9000;
const PRIVACY_LOCK_Z_INDEX = 9998;
const PRIVACY_COVER_Z_INDEX = 9999;

/** Native Stack push routes that render under the system navigation header. */
const PUSH_NATIVE_HEADER_ROUTE_NAMES = new Set([
  'networth',
  'investments',
  'debt',
  'budgets',
  'cashflow',
  'forecast',
  'bills',
  'income',
  'subscriptions',
  'add-transaction',
  'goals',
  'review',
  'rules',
  'events',
  'reconcile',
  'reimbursement',
  'recurring',
  'merchant',
  'tag',
  'account',
]);

/** Routes with custom in-screen headers (no native nav bar). */
const HIDDEN_HEADER_ROUTE_NAMES = new Set(['split', 'transaction', 'category']);

const TAB_SEGMENT = '(tabs)';

const FINANCE_STATUS_BELOW_HEADER = 4;
const RECONNECT_STALE_BELOW_STATUS = 36;

/**
 * @param {boolean} configured
 * @param {boolean} privacyGateActive Face ID / privacy overlay is shown or fading
 */
function shouldMountGlobalFinanceBanners(configured, privacyGateActive) {
  return !!configured && !privacyGateActive;
}

/**
 * @param {string[]} segments expo-router useSegments() output
 */
function resolveGlobalFinanceBannerLayout(segments) {
  const normalized = (segments ?? []).filter(Boolean);
  const root = normalized[0] ?? '';

  if (root === TAB_SEGMENT) {
    return {
      mode: 'tabs',
      topInset: tabScreenHeaderBelowSafeArea() + FINANCE_STATUS_BELOW_HEADER,
      staleTopInset: tabScreenHeaderBelowSafeArea() + FINANCE_STATUS_BELOW_HEADER + RECONNECT_STALE_BELOW_STATUS,
    };
  }

  if (HIDDEN_HEADER_ROUTE_NAMES.has(root)) {
    return {
      mode: 'hiddenHeader',
      routeName: root,
      topInset: null,
      staleTopInset: null,
    };
  }

  if (PUSH_NATIVE_HEADER_ROUTE_NAMES.has(root)) {
    return {
      mode: 'pushNative',
      topInset: NATIVE_STACK_HEADER_HEIGHT + FINANCE_STATUS_BELOW_HEADER,
      staleTopInset: NATIVE_STACK_HEADER_HEIGHT + FINANCE_STATUS_BELOW_HEADER + RECONNECT_STALE_BELOW_STATUS,
    };
  }

  return {
    mode: 'default',
    topInset: FINANCE_STATUS_BELOW_HEADER,
    staleTopInset: FINANCE_STATUS_BELOW_HEADER + RECONNECT_STALE_BELOW_STATUS,
  };
}

/**
 * @param {number} safeAreaTop
 * @param {{ mode: string; routeName?: string; topInset?: number | null; staleTopInset?: number | null }} layout
 */
function resolveGlobalFinanceBannerOffsets(safeAreaTop, layout) {
  let topInset = layout.topInset;
  let staleTopInset = layout.staleTopInset;

  if (layout.mode === 'hiddenHeader' && layout.routeName) {
    const belowSafe = hiddenHeaderBelowSafeArea(layout.routeName, safeAreaTop);
    topInset = belowSafe + FINANCE_STATUS_BELOW_HEADER;
    staleTopInset = belowSafe + FINANCE_STATUS_BELOW_HEADER + RECONNECT_STALE_BELOW_STATUS;
  }

  return {
    statusTop: safeAreaTop + (topInset ?? FINANCE_STATUS_BELOW_HEADER),
    staleTop: safeAreaTop + (staleTopInset ?? FINANCE_STATUS_BELOW_HEADER + RECONNECT_STALE_BELOW_STATUS),
  };
}

function privacyOverlayWinsOverGlobalBanners() {
  return PRIVACY_COVER_Z_INDEX > GLOBAL_FINANCE_BANNER_Z_INDEX
    && PRIVACY_LOCK_Z_INDEX > GLOBAL_FINANCE_BANNER_Z_INDEX
    && DEMO_WATERMARK_Z_INDEX > GLOBAL_FINANCE_BANNER_Z_INDEX;
}

module.exports = {
  GLOBAL_FINANCE_BANNER_Z_INDEX,
  DEMO_WATERMARK_Z_INDEX,
  PRIVACY_LOCK_Z_INDEX,
  PRIVACY_COVER_Z_INDEX,
  PUSH_NATIVE_HEADER_ROUTE_NAMES,
  HIDDEN_HEADER_ROUTE_NAMES,
  TAB_SEGMENT,
  shouldMountGlobalFinanceBanners,
  resolveGlobalFinanceBannerLayout,
  resolveGlobalFinanceBannerOffsets,
  privacyOverlayWinsOverGlobalBanners,
};
