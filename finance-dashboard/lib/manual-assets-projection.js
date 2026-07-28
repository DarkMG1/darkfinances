'use strict';

const crypto = require('crypto');
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

function normalizeManualAssetName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function canonicalManualAssetTuple(item, index) {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.value !== 'number' || !Number.isFinite(item.value)) return null;
  const kind = item.kind === 'liability' ? 'liability' : 'asset';
  try {
    const valueCents = toCents(item.value);
    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : null;
    const name = normalizeManualAssetName(item.name);
    return { id, name, kind, valueCents, index };
  } catch (_) {
    return null;
  }
}

function compareCanonicalTuples(a, b) {
  const idA = a.id ?? `\0legacy:${a.index}`;
  const idB = b.id ?? `\0legacy:${b.index}`;
  return idA.localeCompare(idB)
    || a.name.localeCompare(b.name)
    || a.kind.localeCompare(b.kind)
    || a.valueCents - b.valueCents
    || a.index - b.index;
}

function canonicalManualAssetItems(validated) {
  if (!validated?.complete || !Array.isArray(validated.items)) return [];
  return validated.items
    .map((item, index) => canonicalManualAssetTuple(item, index))
    .filter(Boolean)
    .sort(compareCanonicalTuples)
    .map(({ id, name, kind, valueCents }) => ({ id, name, kind, valueCents }));
}

function manualAssetsRevision(validated) {
  if (!validated || validated.complete !== true) {
    return crypto.createHash('sha256').update('manual-assets:incomplete').digest('hex').slice(0, 16);
  }
  const payload = JSON.stringify({
    complete: true,
    items: canonicalManualAssetItems(validated),
  });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

module.exports = {
  MANUAL_ASSETS_UNAVAILABLE,
  canonicalManualAssetItems,
  compareCanonicalTuples,
  manualAssetsRevision,
  normalizeManualAssetName,
  validateManualAssetsStore,
};
