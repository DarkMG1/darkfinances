/**
 * Header metrics for global finance banner placement.
 * Values mirror in-screen styles so overlays clear custom chrome.
 */

/** iOS native stack navigation bar content height (below safe area). */
const NATIVE_STACK_HEADER_HEIGHT = 44;

/** Tab Screen header — see components/screen.tsx styles.header */
const TAB_SCREEN_HEADER = {
  paddingTopExtra: 6,
  paddingBottom: 10,
  titleLineHeight: 20,
};

/** Transaction detail custom hero — see transaction/[id].tsx menuHero + menuTopBar */
const TRANSACTION_EDITOR_HEADER = {
  menuHeroMarginTop: 8,
  menuHeroPaddingTopExtra: 14,
  menuTopBarMinHeight: 32,
};

/** Split editor top bar — see split/[id].tsx styles.topBar */
const SPLIT_EDITOR_HEADER = {
  paddingTopExtra: 6,
  paddingBottom: 12,
  rowLineHeight: 22,
};

/** Category detail header — see category/[name].tsx styles.header */
const CATEGORY_DETAIL_HEADER = {
  minTotalHeight: 82,
  paddingTopExtra: 12,
  rowMinHeight: 34,
};

function tabScreenHeaderBelowSafeArea() {
  const h = TAB_SCREEN_HEADER;
  return h.paddingTopExtra + h.titleLineHeight + h.paddingBottom;
}

function transactionEditorHeaderBelowSafeArea() {
  const h = TRANSACTION_EDITOR_HEADER;
  return h.menuHeroMarginTop + h.menuHeroPaddingTopExtra + h.menuTopBarMinHeight;
}

function splitEditorHeaderBelowSafeArea() {
  const h = SPLIT_EDITOR_HEADER;
  return h.paddingTopExtra + h.rowLineHeight + h.paddingBottom;
}

function categoryDetailHeaderBelowSafeArea(safeAreaTop) {
  const h = CATEGORY_DETAIL_HEADER;
  return Math.max(
    h.minTotalHeight - safeAreaTop,
    h.paddingTopExtra + h.rowMinHeight,
  );
}

/**
 * @param {'transaction' | 'split' | 'category'} routeName
 * @param {number} safeAreaTop
 */
function hiddenHeaderBelowSafeArea(routeName, safeAreaTop) {
  if (routeName === 'transaction') return transactionEditorHeaderBelowSafeArea();
  if (routeName === 'split') return splitEditorHeaderBelowSafeArea();
  if (routeName === 'category') return categoryDetailHeaderBelowSafeArea(safeAreaTop);
  return NATIVE_STACK_HEADER_HEIGHT;
}

module.exports = {
  NATIVE_STACK_HEADER_HEIGHT,
  TAB_SCREEN_HEADER,
  TRANSACTION_EDITOR_HEADER,
  SPLIT_EDITOR_HEADER,
  CATEGORY_DETAIL_HEADER,
  tabScreenHeaderBelowSafeArea,
  transactionEditorHeaderBelowSafeArea,
  splitEditorHeaderBelowSafeArea,
  categoryDetailHeaderBelowSafeArea,
  hiddenHeaderBelowSafeArea,
};
