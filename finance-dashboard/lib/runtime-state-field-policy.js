'use strict';

const { validEntry, PRESERVED_METADATA_KEYS } = require('./account-overrides-schema');

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const RESERVED_OPEN_MAP_KEYS = new Set(['schemaVersion']);

const ENVELOPE_KEYS = Object.freeze({
  accountOverrides: new Set(['schemaVersion', 'accounts', 'metadata', 'source', 'generatedAt', 'manifest', 'auditTrail', 'version']),
  debtPlanner: new Set(['debts', 'schemaVersion']),
  events: new Set(['events', 'schemaVersion']),
  investmentHoldings: new Set(['holdings', 'schemaVersion']),
  manualAssets: new Set(['items', 'schemaVersion']),
  operationJournal: new Set(['schemaVersion', 'operations']),
  phantomLog: new Set(['deleted', 'schemaVersion']),
  phantomSeen: new Set(['seen', 'schemaVersion']),
  receipts: new Set(['schemaVersion', 'byTxn']),
  reimbursementLinks: new Set(['links', 'schemaVersion']),
  reimbursementSuggestions: new Set(['confirmed', 'dismissed', 'schemaVersion']),
  reconciliation: new Set(['enabled', 'months', 'schemaVersion']),
  reviewState: new Set(['schemaVersion', 'dispositions']),
  rules: new Set(['rules', 'schemaVersion']),
  transactionDeletionSagas: new Set(['schemaVersion', 'sagas']),
  bulkOperationSagas: new Set(['schemaVersion', 'sagas']),
  splitwiseMirrorResolutions: new Set(['schemaVersion', 'resolutions']),
  repaymentConfirmationSagas: new Set(['schemaVersion', 'sagas']),
  transactionSagas: new Set(['schemaVersion', 'sagas']),
  owesTruth: new Set(['schemaVersion', 'bySlug', 'source', 'generatedAt', 'manifest']),
  venmoTruth: new Set(['schemaVersion', 'bySlug', 'source', 'generatedAt', 'manifest']),
});

const OPEN_MAP_STORES = new Set([
  'billsPaid',
  'budgetSettings',
  'owesConfig',
  'personalConfig',
  'recurringOverrides',
]);

const ARRAY_ROOT_STORES = new Set(['goals', 'passkeyCredentials']);

const ARRAY_ROOT_LEGACY_WRAPPERS = Object.freeze({
  goals: 'goals',
  passkeyCredentials: 'credentials',
});

const LEGACY_MIGRATION_SHAPES = Object.freeze({
  accountOverrides: [{
    legacyShape: 'flat account-id map (no schemaVersion 2 envelope)',
    consumed: 'each top-level key with a valid account entry',
    preservedAs: 'accounts.<key>',
  }, {
    legacyShape: 'flat map with recognized metadata keys alongside account overrides',
    consumed: 'valid account-id keys and recognized metadata keys only',
    preservedAs: 'accounts.<id> plus metadata/source/generatedAt/manifest/auditTrail/version',
  }],
  billsPaid: [{
    legacyShape: 'open-map (any top-level keys)',
    consumed: 'none (identity migration)',
    preservedAs: 'same top-level keys',
  }],
  budgetSettings: [{
    legacyShape: 'open-map (any top-level keys)',
    consumed: 'none (identity migration)',
    preservedAs: 'same top-level keys',
  }],
  debtPlanner: [{
    legacyShape: 'object with debts array (schemaVersion optional)',
    consumed: 'debts when present',
    preservedAs: 'debts',
  }],
  events: [{
    legacyShape: 'bare events array',
    consumed: 'array root',
    preservedAs: 'events',
  }],
  goals: [{
    legacyShape: 'bare goals array',
    consumed: 'array root',
    preservedAs: 'array root (unchanged)',
  }, {
    legacyShape: 'object wrapper { goals: [...] }',
    consumed: 'goals',
    preservedAs: 'array root from goals',
  }],
  investmentHoldings: [{
    legacyShape: 'bare holdings array',
    consumed: 'array root',
    preservedAs: 'holdings',
  }],
  manualAssets: [{
    legacyShape: 'bare items array',
    consumed: 'array root',
    preservedAs: 'items',
  }],
  operationJournal: [{
    legacyShape: 'schemaVersion 1 envelope (normalize only)',
    consumed: 'none beyond declared envelope keys',
    preservedAs: 'schemaVersion, operations',
  }],
  owesConfig: [{
    legacyShape: 'open-map (any top-level keys)',
    consumed: 'none (identity migration)',
    preservedAs: 'same top-level keys',
  }],
  owesTruth: [{
    legacyShape: 'v0 sidecar { bySlug, ...metadata } without schemaVersion',
    consumed: 'bySlug, source, generatedAt, manifest, and all undeclared metadata',
    preservedAs: 'same top-level keys with schemaVersion 2',
  }, {
    legacyShape: 'v1 envelope { schemaVersion: 1, bySlug, ...metadata }',
    consumed: 'schemaVersion only (bumped to 2)',
    preservedAs: 'all other top-level keys including undeclared metadata',
  }],
  personalConfig: [{
    legacyShape: 'open-map (any top-level keys)',
    consumed: 'none (identity migration)',
    preservedAs: 'same top-level keys',
  }],
  phantomLog: [{
    legacyShape: 'object with deleted array (schemaVersion optional)',
    consumed: 'deleted when present',
    preservedAs: 'deleted',
  }],
  phantomSeen: [{
    legacyShape: 'object with seen record (schemaVersion optional)',
    consumed: 'seen when present',
    preservedAs: 'seen',
  }],
  receipts: [{
    legacyShape: 'bare receipts array with txnId on every entry',
    consumed: 'array entries grouped by txnId',
    preservedAs: 'byTxn.<txnId>[]',
  }, {
    legacyShape: 'schemaVersion 1 envelope with optional undeclared metadata',
    consumed: 'none beyond declared envelope keys',
    preservedAs: 'schemaVersion, byTxn, and undeclared top-level metadata',
  }],
  reimbursementLinks: [{
    legacyShape: 'schemaVersion 1 envelope with optional undeclared metadata',
    consumed: 'none beyond declared envelope keys',
    preservedAs: 'links, schemaVersion, and undeclared top-level metadata',
  }],
  reimbursementSuggestions: [{
    legacyShape: 'schemaVersion 1 envelope with optional undeclared metadata',
    consumed: 'none beyond declared envelope keys',
    preservedAs: 'confirmed, dismissed, schemaVersion, and undeclared top-level metadata',
  }],
  reconciliation: [{
    legacyShape: 'object with enabled/months (schemaVersion optional)',
    consumed: 'enabled, months when present',
    preservedAs: 'enabled, months',
  }],
  recurringOverrides: [{
    legacyShape: 'open-map (any top-level keys)',
    consumed: 'none (identity migration)',
    preservedAs: 'same top-level keys',
  }],
  reviewState: [{
    legacyShape: 'flat disposition map (no schemaVersion/dispositions envelope)',
    consumed: 'every top-level disposition key',
    preservedAs: 'dispositions.<key> with exact values',
  }, {
    legacyShape: 'schemaVersion 1 envelope { dispositions: {...} }',
    consumed: 'none beyond declared envelope keys',
    preservedAs: 'schemaVersion, dispositions',
  }],
  rules: [{
    legacyShape: 'bare rules array',
    consumed: 'array root',
    preservedAs: 'rules',
  }],
  transactionDeletionSagas: [{
    legacyShape: 'schemaVersion 1 saga envelope (normalize only)',
    consumed: 'none beyond declared envelope keys',
    preservedAs: 'schemaVersion, sagas',
  }],
  bulkOperationSagas: [{
    legacyShape: 'schemaVersion 1 saga envelope (normalize only)',
    consumed: 'none beyond declared envelope keys',
    preservedAs: 'schemaVersion, sagas',
  }],
  splitwiseMirrorResolutions: [{
    legacyShape: 'schemaVersion 1 envelope with optional undeclared metadata',
    consumed: 'none beyond declared envelope keys',
    preservedAs: 'schemaVersion, resolutions, and undeclared top-level metadata',
  }],
  repaymentConfirmationSagas: [{
    legacyShape: 'schemaVersion 1 saga envelope (normalize only)',
    consumed: 'none beyond declared envelope keys',
    preservedAs: 'schemaVersion, sagas',
  }],
  transactionSagas: [{
    legacyShape: 'schemaVersion 1 saga envelope (normalize only)',
    consumed: 'none beyond declared envelope keys',
    preservedAs: 'schemaVersion, sagas',
  }],
  venmoTruth: [{
    legacyShape: 'v0 sidecar { bySlug, ...metadata } without schemaVersion',
    consumed: 'bySlug, source, generatedAt, manifest, and all undeclared metadata',
    preservedAs: 'same top-level keys with schemaVersion 2',
  }, {
    legacyShape: 'v1 envelope { schemaVersion: 1, bySlug, ...metadata }',
    consumed: 'schemaVersion only (bumped to 2)',
    preservedAs: 'all other top-level keys including undeclared metadata',
  }],
  passkeyCredentials: [{
    legacyShape: 'bare credentials array',
    consumed: 'array root',
    preservedAs: 'array root (unchanged)',
  }, {
    legacyShape: 'object wrapper { credentials: [...] }',
    consumed: 'credentials',
    preservedAs: 'array root from credentials',
  }],
});

function arrayRootLegacyMigrated(name, raw, value) {
  if (!ARRAY_ROOT_STORES.has(name) || !Array.isArray(value)) return false;
  if (Array.isArray(raw)) return true;
  if (!isPlainObject(raw)) return false;
  const wrapperKey = ARRAY_ROOT_LEGACY_WRAPPERS[name];
  return wrapperKey != null && Array.isArray(raw[wrapperKey]);
}

function legacyConsumedTopLevelKeys(name, raw) {
  const consumed = new Set();
  if (raw == null) return consumed;

  if (name === 'accountOverrides' && isPlainObject(raw) && raw.schemaVersion !== 2) {
    for (const [key, entry] of Object.entries(raw)) {
      if (PRESERVED_METADATA_KEYS.has(key)) {
        consumed.add(key);
        continue;
      }
      if (validEntry(entry)) consumed.add(key);
    }
    return consumed;
  }

  if (name === 'events' && Array.isArray(raw)) {
    consumed.add('events');
    return consumed;
  }
  if ((name === 'investmentHoldings' || name === 'manualAssets' || name === 'rules') && Array.isArray(raw)) {
    consumed.add(name === 'rules' ? 'rules' : name === 'manualAssets' ? 'items' : 'holdings');
    return consumed;
  }

  if (name === 'goals' && isPlainObject(raw) && Array.isArray(raw.goals)) {
    consumed.add('goals');
    return consumed;
  }

  if (name === 'reviewState' && isPlainObject(raw) && raw.schemaVersion !== 1 && raw.dispositions == null) {
    for (const key of Object.keys(raw)) consumed.add(key);
  }

  return consumed;
}

function unknownFieldPolicyFor(name, schema) {
  return schema?.unknownFieldPolicy || 'reject';
}

function assertNoForbiddenOpenMapKeys(name, raw) {
  if (!isPlainObject(raw)) return;
  for (const key of Object.keys(raw)) {
    if (RESERVED_OPEN_MAP_KEYS.has(key)) {
      const error = new Error(`${name} must not declare reserved top-level key ${key}`);
      error.code = 'RUNTIME_STATE_UNKNOWN_FIELD';
      throw error;
    }
  }
}

function assertEnvelopeKeys(name, value, { allowed, raw, policy }) {
  if (value == null) return;
  if (!isPlainObject(value)) return;

  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      const error = new Error(`${name} rejects unknown top-level field ${key}`);
      error.code = 'RUNTIME_STATE_UNKNOWN_FIELD';
      throw error;
    }
  }

  if (policy !== 'reject' || !isPlainObject(raw)) return;
  const consumed = legacyConsumedTopLevelKeys(name, raw);
  for (const key of Object.keys(raw)) {
    if (allowed.has(key) || consumed.has(key)) continue;
    const error = new Error(`${name} rejects unknown top-level field ${key}`);
    error.code = 'RUNTIME_STATE_UNKNOWN_FIELD';
    throw error;
  }
}

function assertPreserveRoundTrip(name, raw, value) {
  if (!isPlainObject(raw) || !isPlainObject(value)) return;
  const allowed = ENVELOPE_KEYS[name] || new Set();
  for (const [key, entry] of Object.entries(raw)) {
    if (allowed.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      const error = new Error(`${name} dropped preserved top-level field ${key}`);
      error.code = 'RUNTIME_STATE_UNKNOWN_FIELD';
      throw error;
    }
    if (JSON.stringify(value[key]) !== JSON.stringify(entry)) {
      const error = new Error(`${name} mutated preserved top-level field ${key}`);
      error.code = 'RUNTIME_STATE_UNKNOWN_FIELD';
      throw error;
    }
  }
}

function enforceUnknownFieldPolicy(name, raw, value, schema) {
  const policy = unknownFieldPolicyFor(name, schema);
  if (value == null && raw == null) return value;

  if (ARRAY_ROOT_STORES.has(name)) {
    if (isPlainObject(raw) && !Array.isArray(raw)) {
      if (arrayRootLegacyMigrated(name, raw, value)) return value;
      const error = new Error(`${name} legacy wrapper must migrate before policy enforcement`);
      error.code = 'RUNTIME_STATE_UNKNOWN_FIELD';
      throw error;
    }
    return value;
  }

  if (OPEN_MAP_STORES.has(name)) {
    assertNoForbiddenOpenMapKeys(name, raw);
    assertNoForbiddenOpenMapKeys(name, value);
    return value;
  }

  const allowed = ENVELOPE_KEYS[name];
  if (!allowed) return value;

  if (policy === 'preserve-top-level') {
    assertPreserveRoundTrip(name, raw, value);
    return value;
  }

  assertEnvelopeKeys(name, value, { allowed, raw, policy });
  return value;
}

function registryPolicyMatrix() {
  const { RUNTIME_STATE_SCHEMAS } = require('./runtime-state-schemas');
  const { STATE_REGISTRY } = require('./state-registry');
  return Object.keys(STATE_REGISTRY).map((name) => ({
    name,
    policy: unknownFieldPolicyFor(name, RUNTIME_STATE_SCHEMAS[name]),
    shape: ARRAY_ROOT_STORES.has(name)
      ? 'array-root'
      : OPEN_MAP_STORES.has(name)
        ? 'open-map'
        : 'envelope',
    allowedTopLevel: ENVELOPE_KEYS[name]
      ? [...ENVELOPE_KEYS[name]].sort()
      : null,
    legacyShapes: LEGACY_MIGRATION_SHAPES[name] || [],
  }));
}

module.exports = {
  ENVELOPE_KEYS,
  LEGACY_MIGRATION_SHAPES,
  enforceUnknownFieldPolicy,
  legacyConsumedTopLevelKeys,
  registryPolicyMatrix,
};
