'use strict';

const { migrateAccountOverrides } = require('./account-overrides-schema');
const { validatePasskeyCredentials } = require('./passkey-credentials-schema');

class SchemaMigrationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SchemaMigrationError';
    this.code = code;
  }
}

function validOperationJournalState(value) {
  return require('./operation-journal').validState(value);
}

function loadSplitwiseMirrorResolutions(raw) {
  return require('./splitwise-mirror').loadSplitwiseMirrorResolutions(raw);
}

const TERMINAL_SAGA_PHASES = new Set([
  'completed',
  'rolled_back',
  'aborted',
  'legacy_unresolved',
]);

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function invalidShapeError(name, message) {
  const error = new Error(message || `${name} has invalid shape`);
  error.code = 'RUNTIME_STATE_INVALID_SHAPE';
  throw error;
}

function migrationShapeError(name, message) {
  const error = new Error(message || `${name} legacy payload is not migratable`);
  error.code = 'RUNTIME_STATE_MIGRATION_FAILED';
  throw error;
}

function hasOwn(source, field) {
  return Object.prototype.hasOwnProperty.call(source || {}, field);
}

function ownPlainObjectField(name, source, field, defaultValue) {
  if (!hasOwn(source, field)) return defaultValue;
  const value = source[field];
  if (!isPlainObject(value) || Array.isArray(value)) {
    invalidShapeError(name, `${name}.${field} must be an object`);
  }
  return cloneJson(value);
}

function ownArrayField(name, source, field, defaultValue) {
  if (!hasOwn(source, field)) return defaultValue;
  const value = source[field];
  if (!Array.isArray(value)) {
    invalidShapeError(name, `${name}.${field} must be an array`);
  }
  return cloneJson(value);
}

function ownBooleanField(name, source, field, defaultValue) {
  if (!hasOwn(source, field)) return defaultValue;
  const value = source[field];
  if (typeof value !== 'boolean') {
    invalidShapeError(name, `${name}.${field} must be a boolean`);
  }
  return value;
}

function requirePlainObjectRoot(name, source) {
  if (!isPlainObject(source)) {
    invalidShapeError(name, `${name} must be a JSON object`);
  }
}

function readSagasField(name, source) {
  if (!hasOwn(source, 'sagas')) return {};
  const sagas = source.sagas;
  if (!isPlainObject(sagas) || Array.isArray(sagas)) {
    invalidShapeError(name, `${name}.sagas must be an object`);
  }
  return sagas;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function schemaVersionOf(value) {
  return isPlainObject(value) && Number.isInteger(value.schemaVersion) ? value.schemaVersion : 0;
}

function rejectFutureVersion(name, version, current) {
  if (version > current) {
    throw new SchemaMigrationError(
      `${name} schemaVersion ${version} is newer than supported ${current}`,
      'RUNTIME_STATE_FUTURE_SCHEMA',
    );
  }
}

function preserveUnknownTopLevel(raw, allowedKeys, target) {
  for (const [key, value] of Object.entries(raw)) {
    if (!allowedKeys.has(key)) target[key] = value;
  }
  return target;
}

const UNSAFE_TOP_LEVEL_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function assertSafeTopLevelKeys(name, raw) {
  if (!isPlainObject(raw)) return;
  for (const key of Object.keys(raw)) {
    if (UNSAFE_TOP_LEVEL_KEYS.has(key)) {
      throw new SchemaMigrationError(
        `${name} rejects unsafe top-level field ${key}`,
        'RUNTIME_STATE_MIGRATION_FAILED',
      );
    }
  }
}

function spreadOwnTopLevel(raw) {
  const out = {};
  for (const key of Object.keys(raw || {})) {
    out[key] = raw[key];
  }
  return out;
}

function isFlatReviewStateLegacy(raw) {
  return isPlainObject(raw)
    && schemaVersionOf(raw) !== 1
    && raw.dispositions == null;
}

function migrateReviewState(raw) {
  return migrateEnvelope('reviewState', raw, 1, (source) => {
    if (isFlatReviewStateLegacy(source)) {
      return {
        schemaVersion: 1,
        dispositions: cloneJson(source),
      };
    }
    return {
      schemaVersion: 1,
      dispositions: ownPlainObjectField('reviewState', source, 'dispositions', {}),
    };
  }, [
    (legacy) => {
      if (!isFlatReviewStateLegacy(legacy)) return null;
      return {
        schemaVersion: 1,
        dispositions: cloneJson(legacy),
      };
    },
  ]);
}

function migrateEnvelope(name, raw, currentVersion, buildCurrent, legacyMigrations = []) {
  if (raw == null) {
    invalidShapeError(name, `${name} must be a JSON object`);
  }
  if (!isPlainObject(raw) && !Array.isArray(raw)) {
    invalidShapeError(name, `${name} must be a JSON object or array`);
  }

  let working = cloneJson(raw);
  let version = schemaVersionOf(working);
  let changed = version !== schemaVersionOf(raw) || version === 0;

  if (version === 0) {
    for (const step of legacyMigrations) {
      const next = step(working);
      if (next) {
        working = next;
        version = schemaVersionOf(working) || currentVersion;
        changed = true;
        break;
      }
    }
    if (schemaVersionOf(working) === 0) {
      working = buildCurrent(working);
      changed = true;
      version = currentVersion;
    }
  }

  while (version > 0 && version < currentVersion) {
    let upgraded = null;
    for (const step of legacyMigrations) {
      const next = step(working);
      if (next && schemaVersionOf(next) > version) {
        upgraded = next;
        break;
      }
    }
    if (!upgraded) {
      const error = new Error(`${name} schemaVersion ${version} has no supported migration path`);
      error.code = 'RUNTIME_STATE_MIGRATION_FAILED';
      throw error;
    }
    working = upgraded;
    version = schemaVersionOf(working) || currentVersion;
    changed = true;
  }

  rejectFutureVersion(name, version, currentVersion);

  const value = buildCurrent(working, { normalizeOnly: true });
  return { value, changed, version: currentVersion };
}

function defineStore(name, spec) {
  return Object.freeze({
    name,
    currentVersion: spec.currentVersion,
    optionalMissing: spec.optionalMissing === true,
    unknownFieldPolicy: spec.unknownFieldPolicy || 'reject',
    lastGoodPolicy: spec.lastGoodPolicy || 'allow-on-primary-invalid',
    sagaSemantics: spec.sagaSemantics === true,
    missingValue: spec.missingValue,
    migrate(raw) {
      return spec.migrate(raw);
    },
    validateCurrent(value) {
      return spec.validate(value);
    },
    assertWritable(value) {
      if (!spec.validate(value)) {
        const error = new SchemaMigrationError(`${name} write rejected: current schema validation failed`, 'RUNTIME_STATE_WRITE_INVALID');
        throw error;
      }
      const version = schemaVersionOf(value);
      if (version !== 0 && version !== spec.currentVersion && !Array.isArray(value)) {
        const error = new SchemaMigrationError(`${name} write rejected: schemaVersion downgrade or mismatch`, 'RUNTIME_STATE_SCHEMA_DOWNGRADE');
        throw error;
      }
      return value;
    },
  });
}

function validateArrayEntries(label, value, predicate) {
  if (!Array.isArray(value)) return false;
  return value.every((entry, index) => predicate(entry, index));
}

function validateStringRecord(value, predicate = () => true) {
  if (!isPlainObject(value)) return false;
  return Object.entries(value).every(([key, entry]) => typeof key === 'string' && predicate(entry, key));
}

function validateSagaRecord(value) {
  return isPlainObject(value)
    && typeof value.id === 'string'
    && value.id.length > 0
    && (value.phase != null || value.status != null || value.recordVersion != null);
}

function validateSagaEnvelope(value) {
  return isPlainObject(value)
    && value.schemaVersion === 1
    && isPlainObject(value.sagas)
    && !Array.isArray(value.sagas)
    && Object.entries(value.sagas).every(([id, saga]) => saga == null || isPlainObject(saga));
}

function migrateSagaStore(name, raw, currentVersion) {
  const result = migrateEnvelope(
    name,
    raw,
    currentVersion,
    (source, { normalizeOnly } = {}) => {
      const sagas = readSagasField(name, source);
      if (!normalizeOnly) {
        return { schemaVersion: currentVersion, sagas: cloneJson(sagas) };
      }
      const normalized = { schemaVersion: currentVersion, sagas: {} };
      for (const [id, saga] of Object.entries(sagas)) {
        if (!isPlainObject(saga)) {
          invalidShapeError(name, `${name} saga ${id} is malformed`);
        }
        normalized.sagas[id] = cloneJson({ ...saga, id: saga.id || id });
      }
      return normalized;
    },
    [
      (legacy) => {
        if (!isPlainObject(legacy)) return null;
        if (!hasOwn(legacy, 'sagas')) return { schemaVersion: 1, sagas: {} };
        if (!isPlainObject(legacy.sagas) || Array.isArray(legacy.sagas)) {
          invalidShapeError(name, `${name}.sagas must be an object`);
        }
        return { schemaVersion: 1, sagas: legacy.sagas };
      },
    ],
  );

  if (result.changed) {
    for (const [id, before] of Object.entries(raw?.sagas || {})) {
      const after = result.value.sagas[id];
      if (!after) continue;
      const beforeTerminal = TERMINAL_SAGA_PHASES.has(String(before?.phase || before?.status || ''));
      const afterTerminal = TERMINAL_SAGA_PHASES.has(String(after?.phase || after?.status || ''));
      const beforeActive = before && !beforeTerminal;
      if (beforeActive && afterTerminal && !beforeTerminal) {
        const error = new Error(`${name} migration cannot release active saga ownership for ${id}`);
        error.code = 'RUNTIME_STATE_SAGA_SEMANTICS';
        throw error;
      }
      if (!before?.terminalAt && after?.terminalAt) {
        const error = new Error(`${name} migration cannot fabricate terminal proof for ${id}`);
        error.code = 'RUNTIME_STATE_SAGA_SEMANTICS';
        throw error;
      }
    }
  }

  return result;
}

function durableReceiptTxnId(entry) {
  if (!isPlainObject(entry)) return null;
  const txnId = entry.txnId;
  if (typeof txnId !== 'string' || !txnId.trim()) return null;
  return txnId;
}

function migrateLegacyReceiptsArray(raw) {
  if (!Array.isArray(raw)) return null;
  const byTxn = {};
  for (const entry of raw) {
    if (!isPlainObject(entry)) {
      const error = new Error('receipts legacy array entry must be an object');
      error.code = 'RUNTIME_STATE_MIGRATION_FAILED';
      throw error;
    }
    const txnId = durableReceiptTxnId(entry);
    if (!txnId) {
      const error = new Error('receipts legacy array is not migratable without durable txnId on every entry');
      error.code = 'RUNTIME_STATE_MIGRATION_FAILED';
      throw error;
    }
    if (!byTxn[txnId]) byTxn[txnId] = [];
    byTxn[txnId].push(cloneJson(entry));
  }
  return { value: { schemaVersion: 1, byTxn }, changed: true, version: 1 };
}

function migrateReceipts(raw) {
  if (Array.isArray(raw)) {
    return migrateLegacyReceiptsArray(raw);
  }
  return migrateEnvelope(
    'receipts',
    raw,
    1,
    (source) => {
      const byTxn = ownPlainObjectField('receipts', source, 'byTxn', {});
      const store = { schemaVersion: 1, byTxn };
      return preserveUnknownTopLevel(source, new Set(['schemaVersion', 'byTxn']), store);
    },
    [],
  );
}

function migrateGoals(raw) {
  if (raw == null) {
    invalidShapeError('goals', 'goals must be a JSON object or array');
  }
  if (Array.isArray(raw)) {
    return { value: cloneJson(raw), changed: false, version: 1 };
  }
  if (isPlainObject(raw) && Array.isArray(raw.goals)) {
    return { value: cloneJson(raw.goals), changed: true, version: 1 };
  }
  const error = new Error('goals legacy payload is not migratable');
  error.code = 'RUNTIME_STATE_MIGRATION_FAILED';
  throw error;
}

function migrateTruthSidecar(name, raw, currentVersion) {
  return migrateEnvelope(
    name,
    raw,
    currentVersion,
    (source) => {
      assertSafeTopLevelKeys(name, source);
      if (source?.bySlug != null && !isPlainObject(source.bySlug)) {
        throw new SchemaMigrationError('truth sidecar bySlug must be an object', 'RUNTIME_STATE_MIGRATION_FAILED');
      }
      const store = spreadOwnTopLevel(source);
      store.schemaVersion = currentVersion;
      if (!isPlainObject(store.bySlug)) {
        store.bySlug = {};
      } else {
        store.bySlug = cloneJson(store.bySlug);
      }
      if (store.source != null) store.source = String(store.source);
      if (store.generatedAt != null) store.generatedAt = String(store.generatedAt);
      if (store.manifest != null && isPlainObject(store.manifest)) {
        store.manifest = cloneJson(store.manifest);
      }
      return store;
    },
    [
      (legacy) => {
        if (schemaVersionOf(legacy) !== 1 || currentVersion !== 2) return null;
        assertSafeTopLevelKeys(name, legacy);
        return { ...spreadOwnTopLevel(legacy), schemaVersion: currentVersion };
      },
    ],
  );
}

const RUNTIME_STATE_SCHEMAS = Object.freeze({
  accountOverrides: defineStore('accountOverrides', {
    currentVersion: 2,
    unknownFieldPolicy: 'reject',
    missingValue: () => ({ schemaVersion: 2, accounts: {} }),
    migrate(raw) {
      const migrated = migrateAccountOverrides(raw);
      if (!migrated) {
        const error = new Error('accountOverrides legacy payload is not migratable');
        error.code = 'RUNTIME_STATE_MIGRATION_FAILED';
        throw error;
      }
      return { value: migrated, changed: schemaVersionOf(raw) !== 2, version: 2 };
    },
    validate(value) {
      return migrateAccountOverrides(value) !== null;
    },
  }),

  billsPaid: defineStore('billsPaid', {
    currentVersion: 1,
    missingValue: () => ({}),
    migrate(raw) {
      return migrateEnvelope('billsPaid', raw, 1, (source) => {
        requirePlainObjectRoot('billsPaid', source);
        return cloneJson(source);
      });
    },
    validate(value) {
      return isPlainObject(value);
    },
  }),

  budgetSettings: defineStore('budgetSettings', {
    currentVersion: 1,
    missingValue: () => ({}),
    migrate(raw) {
      return migrateEnvelope('budgetSettings', raw, 1, (source) => {
        requirePlainObjectRoot('budgetSettings', source);
        return cloneJson(source);
      });
    },
    validate(value) {
      return isPlainObject(value);
    },
  }),

  debtPlanner: defineStore('debtPlanner', {
    currentVersion: 1,
    missingValue: () => ({ debts: [] }),
    migrate(raw) {
      return migrateEnvelope('debtPlanner', raw, 1, (source) => ({
        debts: ownArrayField('debtPlanner', source, 'debts', []),
      }));
    },
    validate(value) {
      return isPlainObject(value) && Array.isArray(value.debts);
    },
  }),

  events: defineStore('events', {
    currentVersion: 1,
    missingValue: () => ({ events: [] }),
    migrate(raw) {
      return migrateEnvelope('events', raw, 1, (source) => ({
        events: ownArrayField('events', source, 'events', []),
      }), [
        (legacy) => (Array.isArray(legacy) ? { events: legacy } : null),
      ]);
    },
    validate(value) {
      return isPlainObject(value) && Array.isArray(value.events);
    },
  }),

  goals: defineStore('goals', {
    currentVersion: 1,
    missingValue: () => [],
    migrate(raw) {
      if (raw == null) {
        invalidShapeError('goals', 'goals must be a JSON object or array');
      }
      if (isPlainObject(raw) && Number.isInteger(raw.schemaVersion)) {
        rejectFutureVersion('goals', raw.schemaVersion, 1);
      }
      return migrateGoals(raw);
    },
    validate(value) {
      return Array.isArray(value);
    },
  }),

  investmentHoldings: defineStore('investmentHoldings', {
    currentVersion: 1,
    missingValue: () => ({ holdings: [] }),
    migrate(raw) {
      return migrateEnvelope('investmentHoldings', raw, 1, (source) => ({
        holdings: ownArrayField('investmentHoldings', source, 'holdings', []),
      }), [
        (legacy) => (Array.isArray(legacy) ? { holdings: legacy } : null),
      ]);
    },
    validate(value) {
      return isPlainObject(value) && Array.isArray(value.holdings);
    },
  }),

  manualAssets: defineStore('manualAssets', {
    currentVersion: 1,
    missingValue: () => ({ items: [] }),
    migrate(raw) {
      return migrateEnvelope('manualAssets', raw, 1, (source) => ({
        items: ownArrayField('manualAssets', source, 'items', []),
      }), [
        (legacy) => (Array.isArray(legacy) ? { items: legacy } : null),
      ]);
    },
    validate(value) {
      return isPlainObject(value) && Array.isArray(value.items);
    },
  }),

  operationJournal: defineStore('operationJournal', {
    currentVersion: 1,
    sagaSemantics: true,
    missingValue: () => ({ schemaVersion: 1, operations: {} }),
    migrate(raw) {
      const result = migrateEnvelope(
        'operationJournal',
        raw,
        1,
        (source) => ({
          schemaVersion: 1,
          operations: ownPlainObjectField('operationJournal', source, 'operations', {}),
        }),
      );
      if (!validOperationJournalState(result.value)) {
        const error = new Error('operationJournal payload is not migratable to a valid current shape');
        error.code = 'RUNTIME_STATE_MIGRATION_FAILED';
        throw error;
      }
      return result;
    },
    validate: validOperationJournalState,
  }),

  owesConfig: defineStore('owesConfig', {
    currentVersion: 1,
    optionalMissing: true,
    missingValue: () => null,
    migrate(raw) {
      if (raw == null) return { value: null, changed: false, version: 1 };
      return migrateEnvelope('owesConfig', raw, 1, (source) => cloneJson(source));
    },
    validate(value) {
      return value == null || isPlainObject(value);
    },
  }),

  owesTruth: defineStore('owesTruth', {
    currentVersion: 2,
    optionalMissing: true,
    unknownFieldPolicy: 'preserve-top-level',
    missingValue: () => null,
    migrate(raw) {
      if (raw == null) return { value: null, changed: false, version: 2 };
      return migrateTruthSidecar('owesTruth', raw, 2);
    },
    validate(value) {
      return value == null || (isPlainObject(value)
        && value.schemaVersion === 2
        && isPlainObject(value.bySlug));
    },
  }),

  personalConfig: defineStore('personalConfig', {
    currentVersion: 1,
    optionalMissing: true,
    missingValue: () => null,
    migrate(raw) {
      if (raw == null) return { value: null, changed: false, version: 1 };
      return migrateEnvelope('personalConfig', raw, 1, (source) => cloneJson(source));
    },
    validate(value) {
      return value == null || isPlainObject(value);
    },
  }),

  phantomLog: defineStore('phantomLog', {
    currentVersion: 1,
    missingValue: () => ({ deleted: [] }),
    migrate(raw) {
      return migrateEnvelope('phantomLog', raw, 1, (source) => ({
        deleted: ownArrayField('phantomLog', source, 'deleted', []),
      }));
    },
    validate(value) {
      return isPlainObject(value) && Array.isArray(value.deleted);
    },
  }),

  phantomSeen: defineStore('phantomSeen', {
    currentVersion: 1,
    missingValue: () => ({ seen: {} }),
    migrate(raw) {
      return migrateEnvelope('phantomSeen', raw, 1, (source) => ({
        seen: ownPlainObjectField('phantomSeen', source, 'seen', {}),
      }));
    },
    validate(value) {
      return isPlainObject(value) && isPlainObject(value.seen);
    },
  }),

  receipts: defineStore('receipts', {
    currentVersion: 1,
    unknownFieldPolicy: 'preserve-top-level',
    missingValue: () => ({ schemaVersion: 1, byTxn: {} }),
    migrate(raw) {
      if (raw == null) {
        invalidShapeError('receipts', 'receipts must be a JSON object or array');
      }
      return migrateReceipts(raw);
    },
    validate(value) {
      return isPlainObject(value)
        && value.schemaVersion === 1
        && isPlainObject(value.byTxn)
        && Object.values(value.byTxn).every(Array.isArray);
    },
  }),

  reimbursementLinks: defineStore('reimbursementLinks', {
    currentVersion: 1,
    unknownFieldPolicy: 'preserve-top-level',
    missingValue: () => ({ links: [] }),
    migrate(raw) {
      return migrateEnvelope('reimbursementLinks', raw, 1, (source) => {
        if (Object.prototype.hasOwnProperty.call(source, 'links') && !Array.isArray(source.links)) {
          throw new SchemaMigrationError('reimbursementLinks links must be an array', 'RUNTIME_STATE_INVALID_SHAPE');
        }
        const store = {
          links: Array.isArray(source?.links) ? cloneJson(source.links) : [],
        };
        return preserveUnknownTopLevel(source, new Set(['links']), store);
      });
    },
    validate(value) {
      return isPlainObject(value) && Array.isArray(value.links);
    },
  }),

  reimbursementSuggestions: defineStore('reimbursementSuggestions', {
    currentVersion: 1,
    unknownFieldPolicy: 'preserve-top-level',
    missingValue: () => ({ confirmed: {}, dismissed: [] }),
    migrate(raw) {
      return migrateEnvelope('reimbursementSuggestions', raw, 1, (source) => {
        const store = {
          confirmed: ownPlainObjectField('reimbursementSuggestions', source, 'confirmed', {}),
          dismissed: ownArrayField('reimbursementSuggestions', source, 'dismissed', []),
        };
        return preserveUnknownTopLevel(source, new Set(['confirmed', 'dismissed']), store);
      });
    },
    validate(value) {
      return isPlainObject(value)
        && isPlainObject(value.confirmed)
        && Array.isArray(value.dismissed);
    },
  }),

  reconciliation: defineStore('reconciliation', {
    currentVersion: 1,
    missingValue: () => ({ enabled: false, months: {} }),
    migrate(raw) {
      return migrateEnvelope('reconciliation', raw, 1, (source) => ({
        enabled: ownBooleanField('reconciliation', source, 'enabled', false),
        months: ownPlainObjectField('reconciliation', source, 'months', {}),
      }));
    },
    validate(value) {
      return isPlainObject(value)
        && typeof value.enabled === 'boolean'
        && isPlainObject(value.months);
    },
  }),

  recurringOverrides: defineStore('recurringOverrides', {
    currentVersion: 1,
    missingValue: () => ({}),
    migrate(raw) {
      return migrateEnvelope('recurringOverrides', raw, 1, (source) => {
        requirePlainObjectRoot('recurringOverrides', source);
        return cloneJson(source);
      });
    },
    validate(value) {
      return isPlainObject(value);
    },
  }),

  reviewState: defineStore('reviewState', {
    currentVersion: 1,
    missingValue: () => ({ schemaVersion: 1, dispositions: {} }),
    migrate(raw) {
      return migrateReviewState(raw);
    },
    validate(value) {
      return isPlainObject(value)
        && value.schemaVersion === 1
        && isPlainObject(value.dispositions);
    },
  }),

  rules: defineStore('rules', {
    currentVersion: 1,
    missingValue: () => ({ rules: [] }),
    migrate(raw) {
      return migrateEnvelope('rules', raw, 1, (source) => ({
        rules: ownArrayField('rules', source, 'rules', []),
      }), [
        (legacy) => (Array.isArray(legacy) ? { rules: legacy } : null),
      ]);
    },
    validate(value) {
      return isPlainObject(value) && Array.isArray(value.rules);
    },
  }),

  transactionDeletionSagas: defineStore('transactionDeletionSagas', {
    currentVersion: 1,
    sagaSemantics: true,
    missingValue: () => ({ schemaVersion: 1, sagas: {} }),
    migrate(raw) {
      return migrateSagaStore('transactionDeletionSagas', raw, 1);
    },
    validate: validateSagaEnvelope,
  }),

  bulkOperationSagas: defineStore('bulkOperationSagas', {
    currentVersion: 1,
    sagaSemantics: true,
    missingValue: () => ({ schemaVersion: 1, sagas: {} }),
    migrate(raw) {
      return migrateSagaStore('bulkOperationSagas', raw, 1);
    },
    validate: validateSagaEnvelope,
  }),

  splitwiseMirrorResolutions: defineStore('splitwiseMirrorResolutions', {
    currentVersion: 1,
    unknownFieldPolicy: 'preserve-top-level',
    missingValue: () => ({ schemaVersion: 1, resolutions: [] }),
    migrate(raw) {
      if (raw == null) {
        invalidShapeError('splitwiseMirrorResolutions', 'splitwiseMirrorResolutions must be a JSON object');
      }
      if (isPlainObject(raw) && Number.isInteger(raw.schemaVersion)) {
        rejectFutureVersion('splitwiseMirrorResolutions', raw.schemaVersion, 1);
      }
      try {
        const value = loadSplitwiseMirrorResolutions(raw);
        return {
          value,
          changed: JSON.stringify(value) !== JSON.stringify(raw),
          version: 1,
        };
      } catch (cause) {
        if (cause?.name === 'SplitwiseMirrorResolutionError') throw cause;
        const error = new Error('splitwiseMirrorResolutions legacy payload is not migratable');
        error.code = 'RUNTIME_STATE_MIGRATION_FAILED';
        error.cause = cause;
        throw error;
      }
    },
    validate(value) {
      try {
        loadSplitwiseMirrorResolutions(value);
        return true;
      } catch {
        return false;
      }
    },
  }),

  repaymentConfirmationSagas: defineStore('repaymentConfirmationSagas', {
    currentVersion: 1,
    sagaSemantics: true,
    missingValue: () => ({ schemaVersion: 1, sagas: {} }),
    migrate(raw) {
      return migrateSagaStore('repaymentConfirmationSagas', raw, 1);
    },
    validate: validateSagaEnvelope,
  }),

  transactionSagas: defineStore('transactionSagas', {
    currentVersion: 1,
    sagaSemantics: true,
    missingValue: () => ({ schemaVersion: 1, sagas: {} }),
    migrate(raw) {
      return migrateSagaStore('transactionSagas', raw, 1);
    },
    validate: validateSagaEnvelope,
  }),

  venmoTruth: defineStore('venmoTruth', {
    currentVersion: 2,
    optionalMissing: true,
    unknownFieldPolicy: 'preserve-top-level',
    missingValue: () => null,
    migrate(raw) {
      if (raw == null) return { value: null, changed: false, version: 2 };
      return migrateTruthSidecar('venmoTruth', raw, 2);
    },
    validate(value) {
      return value == null || (isPlainObject(value)
        && value.schemaVersion === 2
        && isPlainObject(value.bySlug));
    },
  }),

  passkeyCredentials: defineStore('passkeyCredentials', {
    currentVersion: 1,
    lastGoodPolicy: 'never',
    missingValue: () => [],
    migrate(raw) {
      if (raw == null) {
        invalidShapeError('passkeyCredentials', 'passkeyCredentials JSON null is invalid');
      }
      if (Array.isArray(raw)) {
        return { value: cloneJson(raw), changed: false, version: 1 };
      }
      if (isPlainObject(raw)) {
        if (Number.isInteger(raw.schemaVersion)) {
          rejectFutureVersion('passkeyCredentials', raw.schemaVersion, 1);
        }
        if (hasOwn(raw, 'credentials')) {
          if (!Array.isArray(raw.credentials)) {
            invalidShapeError('passkeyCredentials', 'passkeyCredentials.credentials must be an array');
          }
          return { value: cloneJson(raw.credentials), changed: true, version: 1 };
        }
      }
      invalidShapeError('passkeyCredentials', 'passkeyCredentials must be an array or { credentials: [...] } wrapper');
    },
    validate(value) {
      return validatePasskeyCredentials(value);
    },
  }),
});

function schemaForRegistryEntry(name) {
  const schema = RUNTIME_STATE_SCHEMAS[name];
  if (!schema) {
    const error = new Error(`No runtime schema registered for ${name}`);
    error.code = 'RUNTIME_STATE_UNKNOWN';
    throw error;
  }
  return schema;
}

const CALLER_INVARIANTS = Object.freeze({
  receipts: (value) => isPlainObject(value)
    && isPlainObject(value.byTxn)
    && Object.values(value.byTxn).every(Array.isArray),
  reimbursementLinks: (value) => isPlainObject(value) && Array.isArray(value.links),
  reimbursementSuggestions: (value) => isPlainObject(value)
    && isPlainObject(value.confirmed)
    && Array.isArray(value.dismissed),
  reconciliation: (value) => isPlainObject(value) && isPlainObject(value.months),
  phantomSeen: (value) => isPlainObject(value) && isPlainObject(value.seen),
  accountOverrides: (value) => migrateAccountOverrides(value) !== null,
});

function validateCallerInvariant(name, value) {
  const validator = CALLER_INVARIANTS[name];
  return validator ? validator(value) : true;
}

module.exports = {
  CALLER_INVARIANTS,
  RUNTIME_STATE_SCHEMAS,
  schemaForRegistryEntry,
  cloneJson,
  isPlainObject,
  validateCallerInvariant,
};
