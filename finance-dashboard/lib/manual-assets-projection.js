'use strict';

const { fromCents, sumCents, toCents } = require('./domain/money');

const MANUAL_ASSETS_UNAVAILABLE = 'manual_assets_unavailable';

function validateManualAssetsStore(store) {
  if (!store || typeof store !== 'object' || Array.isArray(store)) {
    return {
      complete: false,
      incompleteReasons: [MANUAL_ASSETS_UNAVAILABLE],
      items: [],
      assets: null,
      liabilities: null,
      net: null,
      assetCents: null,
      liabilityCents: null,
    };
  }
  if (!Array.isArray(store.items)) {
    return {
      complete: false,
      incompleteReasons: [MANUAL_ASSETS_UNAVAILABLE],
      items: [],
      assets: null,
      liabilities: null,
      net: null,
      assetCents: null,
      liabilityCents: null,
    };
  }

  let assetCents = 0;
  let liabilityCents = 0;
  for (const item of store.items) {
    if (!item || typeof item !== 'object') {
      return {
        complete: false,
        incompleteReasons: [MANUAL_ASSETS_UNAVAILABLE],
        items: store.items,
        assets: null,
        liabilities: null,
        net: null,
        assetCents: null,
        liabilityCents: null,
      };
    }
    if (typeof item.value !== 'number' || !Number.isFinite(item.value)) {
      return {
        complete: false,
        incompleteReasons: [MANUAL_ASSETS_UNAVAILABLE],
        items: store.items,
        assets: null,
        liabilities: null,
        net: null,
        assetCents: null,
        liabilityCents: null,
      };
    }
    try {
      const cents = toCents(item.value);
      if (item.kind === 'liability') liabilityCents = sumCents([liabilityCents, cents]);
      else assetCents = sumCents([assetCents, cents]);
    } catch (_) {
      return {
        complete: false,
        incompleteReasons: [MANUAL_ASSETS_UNAVAILABLE],
        items: store.items,
        assets: null,
        liabilities: null,
        net: null,
        assetCents: null,
        liabilityCents: null,
      };
    }
  }

  const assets = fromCents(assetCents);
  const liabilities = fromCents(liabilityCents);
  return {
    complete: true,
    incompleteReasons: [],
    items: store.items,
    assets,
    liabilities,
    net: fromCents(sumCents([assetCents, -liabilityCents])),
    assetCents,
    liabilityCents,
  };
}

module.exports = {
  MANUAL_ASSETS_UNAVAILABLE,
  validateManualAssetsStore,
};
