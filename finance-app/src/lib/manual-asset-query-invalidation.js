'use strict';

const { scheduleQueryInvalidation } = require('./query-invalidation');

/** Must stay aligned with API_ENDPOINTS.manualAssets.key and API_ENDPOINTS.today.key */
const MANUAL_ASSET_DERIVED_QUERY_KEYS = Object.freeze(['manualAssets', 'today']);

function invalidateManualAssetDerivedQueries(queryClient) {
  scheduleQueryInvalidation(queryClient, [...MANUAL_ASSET_DERIVED_QUERY_KEYS]);
}

module.exports = {
  MANUAL_ASSET_DERIVED_QUERY_KEYS,
  invalidateManualAssetDerivedQueries,
};
