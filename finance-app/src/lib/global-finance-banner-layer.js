/**
 * Z-order and layout contracts for root-level finance connectivity banners.
 * Privacy lock and demo watermark must always win over GlobalFinanceBanners.
 */

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

const NATIVE_HEADER_HEIGHT = 44;
const TAB_CUSTOM_HEADER_HEIGHT = 44;
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
      topInset: TAB_CUSTOM_HEADER_HEIGHT + FINANCE_STATUS_BELOW_HEADER,
      staleTopInset: TAB_CUSTOM_HEADER_HEIGHT + FINANCE_STATUS_BELOW_HEADER + RECONNECT_STALE_BELOW_STATUS,
    };
  }

  if (HIDDEN_HEADER_ROUTE_NAMES.has(root)) {
    return {
      mode: 'hiddenHeader',
      topInset: NATIVE_HEADER_HEIGHT + FINANCE_STATUS_BELOW_HEADER,
      staleTopInset: NATIVE_HEADER_HEIGHT + FINANCE_STATUS_BELOW_HEADER + RECONNECT_STALE_BELOW_STATUS,
    };
  }

  if (PUSH_NATIVE_HEADER_ROUTE_NAMES.has(root)) {
    return {
      mode: 'pushNative',
      topInset: NATIVE_HEADER_HEIGHT + FINANCE_STATUS_BELOW_HEADER,
      staleTopInset: NATIVE_HEADER_HEIGHT + FINANCE_STATUS_BELOW_HEADER + RECONNECT_STALE_BELOW_STATUS,
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
 * @param {{ topInset: number; staleTopInset: number }} layout
 */
function resolveGlobalFinanceBannerOffsets(safeAreaTop, layout) {
  return {
    statusTop: safeAreaTop + layout.topInset,
    staleTop: safeAreaTop + layout.staleTopInset,
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
