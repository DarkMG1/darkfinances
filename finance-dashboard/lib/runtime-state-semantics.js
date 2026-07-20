'use strict';

const { validState, isCompleted, isKnownFailed } = require('./operation-journal');
const { loadSplitwiseMirrorResolutions } = require('./splitwise-mirror');

const TERMINAL_REPLACEMENT = new Set(['completed', 'rolled_back', 'legacy_unresolved', 'aborted']);
const TERMINAL_DELETION = new Set(['completed']);
const TERMINAL_REPAYMENT = new Set(['completed']);
const TERMINAL_REIMBURSEMENT_LINK = new Set(['completed']);
const TERMINAL_BULK = new Set(['completed', 'unresolved']);

const TERMINAL_PROOF_REQUIRED = Object.freeze({
  transactionSagas: new Set(['completed', 'rolled_back']),
  transactionDeletionSagas: new Set(['completed']),
  repaymentConfirmationSagas: new Set(['completed']),
  reimbursementLinkSagas: new Set(['completed']),
  bulkOperationSagas: new Set(['completed']),
});

const SAGA_OWNERSHIP_FAMILIES = new Set([
  'transactionSagas',
  'transactionDeletionSagas',
  'repaymentConfirmationSagas',
  'reimbursementLinkSagas',
  'bulkOperationSagas',
]);

const SEMANTIC_STORES = new Set([
  'operationJournal',
  ...SAGA_OWNERSHIP_FAMILIES,
  'splitwiseMirrorResolutions',
]);

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a non-empty string`);
}

function isTerminalOperation(operation) {
  return isCompleted(operation) || isKnownFailed(operation);
}

function sagaHasIdentity(saga) {
  return isObject(saga)
    && typeof saga.id === 'string'
    && saga.id.length > 0
    && typeof saga.phase === 'string'
    && saga.phase.length > 0
    && typeof saga.updatedAt === 'string'
    && saga.updatedAt.length > 0;
}

function validateReplacementSagaRecord(saga, label, { mode, isNew } = {}) {
  validateSagaIdentity(saga, label);
  if (saga.recordVersion !== 2) return;
  if (mode === 'write' && isNew && (saga.original?.id == null || String(saga.original.id) === '')) {
    throw new Error(`${label} requires original.id on write`);
  }
  if (mode === 'write' && TERMINAL_PROOF_REQUIRED.transactionSagas.has(saga.phase) && !saga.terminalAt) {
    throw new Error(`${label} terminal evidence requires terminalAt`);
  }
  if (saga.original?.id != null) requireString(String(saga.original.id), `${label}.original.id`);
}

function validateDeletionSagaRecord(saga, label, { mode, isNew } = {}) {
  validateSagaIdentity(saga, label);
  if (saga.recordVersion !== 1) return;
  if (mode === 'write' && isNew) {
    const parentId = saga.target?.parentId ?? saga.transaction?.id;
    if (parentId == null || String(parentId) === '') {
      throw new Error(`${label} requires target.parentId on write`);
    }
  }
  if (mode === 'write' && TERMINAL_PROOF_REQUIRED.transactionDeletionSagas.has(saga.phase) && !saga.terminalAt) {
    throw new Error(`${label} terminal evidence requires terminalAt`);
  }
  if (saga.transaction?.id != null) requireString(String(saga.transaction.id), `${label}.transaction.id`);
}

function validateRepaymentSagaRecord(saga, label, { mode, isNew } = {}) {
  validateSagaIdentity(saga, label);
  if (saga.recordVersion !== 1) return;
  if (mode === 'write' && isNew && (saga.inflow?.id == null || String(saga.inflow.id) === '')) {
    throw new Error(`${label} requires inflow.id on write`);
  }
  if (mode === 'write' && TERMINAL_PROOF_REQUIRED.repaymentConfirmationSagas.has(saga.phase) && !saga.terminalAt) {
    throw new Error(`${label} terminal evidence requires terminalAt`);
  }
  if (saga.inflow?.id != null) requireString(String(saga.inflow.id), `${label}.inflow.id`);
}

function validateReimbursementLinkSagaRecord(saga, label, { mode, isNew } = {}) {
  validateSagaIdentity(saga, label);
  if (saga.recordVersion !== 1) return;
  if (mode === 'write' && isNew) {
    if (saga.inflowId == null || String(saga.inflowId) === '') {
      throw new Error(`${label} requires inflowId on write`);
    }
    if (saga.expenseId == null || String(saga.expenseId) === '') {
      throw new Error(`${label} requires expenseId on write`);
    }
  }
  if (mode === 'write' && TERMINAL_PROOF_REQUIRED.reimbursementLinkSagas.has(saga.phase) && !saga.terminalAt) {
    throw new Error(`${label} terminal evidence requires terminalAt`);
  }
  if (saga.inflowId != null) requireString(String(saga.inflowId), `${label}.inflowId`);
  if (saga.expenseId != null) requireString(String(saga.expenseId), `${label}.expenseId`);
}

function validateBulkSagaRecord(saga, label, { mode, isNew } = {}) {
  validateSagaIdentity(saga, label);
  if (saga.recordVersion !== 1) return;
  if (mode === 'write' && isNew) {
    requireString(saga.kind, `${label}.kind`);
  } else if (saga.kind != null) {
    requireString(saga.kind, `${label}.kind`);
  }
  if (mode === 'write' && TERMINAL_PROOF_REQUIRED.bulkOperationSagas.has(saga.phase) && !saga.terminalAt) {
    throw new Error(`${label} terminal evidence requires terminalAt`);
  }
}

function validateSagaIdentity(saga, label) {
  if (!isObject(saga)) throw new Error(`${label} must be an object`);
  requireString(saga.id, `${label}.id`);
  requireString(saga.phase, `${label}.phase`);
  requireString(saga.updatedAt, `${label}.updatedAt`);
}

function validateSagaCollection(name, value, validateRecord, { mode, previous } = {}) {
  if (!isObject(value?.sagas)) throw new Error(`${name} sagas must be an object`);
  const prevById = mode === 'write' ? sagaIndexById(previous) : new Map();
  for (const [id, saga] of Object.entries(value.sagas)) {
    if (!isObject(saga)) throw new Error(`${name}.sagas.${id} must be an object`);
    if (mode === 'write') {
      if (typeof saga.id !== 'string' || !saga.id) {
        throw new Error(`${name}.sagas.${id} requires durable id on write`);
      }
      const isNew = !prevById.has(String(saga.id));
      if (!sagaHasIdentity(saga)) {
        if (isNew) {
          throw new Error(`${name} cannot write incomplete new saga ${saga.id}`);
        }
        continue;
      }
      validateRecord(saga, `${name}.sagas.${id}`, { mode, isNew });
      continue;
    }
    if (!sagaHasIdentity(saga)) continue;
    validateRecord(saga, `${name}.sagas.${id}`, { mode });
  }
}

const SEMANTIC_VALIDATORS = Object.freeze({
  operationJournal(value, { mode, previous } = {}) {
    if (!validState(value)) {
      throw new Error('operation journal semantic validation failed');
    }
    if (mode === 'write') {
      validateJournalWriteStrict(value, previous);
    }
  },
  transactionSagas(value, options) {
    validateSagaCollection('transactionSagas', value, validateReplacementSagaRecord, options);
  },
  transactionDeletionSagas(value, options) {
    validateSagaCollection('transactionDeletionSagas', value, validateDeletionSagaRecord, options);
  },
  repaymentConfirmationSagas(value, options) {
    validateSagaCollection('repaymentConfirmationSagas', value, validateRepaymentSagaRecord, options);
  },
  reimbursementLinkSagas(value, options) {
    validateSagaCollection('reimbursementLinkSagas', value, validateReimbursementLinkSagaRecord, options);
  },
  bulkOperationSagas(value, options) {
    validateSagaCollection('bulkOperationSagas', value, validateBulkSagaRecord, options);
  },
  splitwiseMirrorResolutions(value, { mode }) {
    if (mode === 'read') {
      if (!isObject(value) || !Array.isArray(value.resolutions)) return;
      for (const resolution of value.resolutions) {
        if (!isObject(resolution)) throw new Error('splitwiseMirrorResolutions resolution must be an object');
      }
      return;
    }
    loadSplitwiseMirrorResolutions(value);
  },
});

function semanticValidator(name) {
  return SEMANTIC_VALIDATORS[name] || null;
}

function operationHasWriteIdentity(key, operation) {
  return isObject(operation)
    && operation.recordVersion === 2
    && operation.key === key
    && typeof operation.fingerprint === 'string'
    && operation.fingerprint.length > 0
    && operation.fingerprintVersion === 2
    && typeof operation.method === 'string'
    && typeof operation.route === 'string'
    && typeof operation.phase === 'string'
    && typeof operation.status === 'string'
    && typeof operation.startedAt === 'string'
    && operation.startedAt.length > 0
    && typeof operation.updatedAt === 'string'
    && operation.updatedAt.length > 0;
}

function validateJournalWriteStrict(value, previous) {
  const prevOps = previous?.operations || {};
  for (const [key, operation] of Object.entries(value.operations || {})) {
    if (!isObject(operation)) throw new Error(`operationJournal.operations.${key} must be an object`);
    if (operation.key != null && String(operation.key) !== String(key)) {
      throw new Error(`operationJournal.operations.${key} key mismatch`);
    }
    if (Object.prototype.hasOwnProperty.call(prevOps, key)) continue;
    if (!operationHasWriteIdentity(key, operation)) {
      throw new Error(`operationJournal cannot write incomplete new operation ${key}`);
    }
  }
}

function validateStrictWrite(name, value, previous) {
  const validator = semanticValidator(name);
  if (!validator) return value;
  validator(value, { mode: 'write', previous });
  return value;
}

function validateSemantic(name, value, { mode = 'write', previous } = {}) {
  const validator = semanticValidator(name);
  if (validator) validator(value, { mode, previous });
  return value;
}

function isTerminalSagaForFamily(family, saga) {
  switch (family) {
    case 'transactionSagas':
      return saga?.recordVersion === 2 && TERMINAL_REPLACEMENT.has(String(saga.phase || ''));
    case 'transactionDeletionSagas':
      return saga?.recordVersion === 1 && TERMINAL_DELETION.has(String(saga.phase || ''));
    case 'repaymentConfirmationSagas':
      return saga?.recordVersion === 1 && TERMINAL_REPAYMENT.has(String(saga.phase || ''));
    case 'reimbursementLinkSagas':
      return saga?.recordVersion === 1 && TERMINAL_REIMBURSEMENT_LINK.has(String(saga.phase || ''));
    case 'bulkOperationSagas':
      return saga?.recordVersion === 1 && TERMINAL_BULK.has(String(saga.phase || ''));
    default:
      return false;
  }
}

function ownedIdsForFamily(family, saga) {
  const ids = new Set();
  if (!saga) return ids;
  switch (family) {
    case 'transactionSagas':
      if (saga.original?.id != null) ids.add(String(saga.original.id));
      for (const leg of saga.original?.subtransactions || []) {
        if (leg?.id != null) ids.add(String(leg.id));
      }
      for (const leg of saga.replacement?.subtransactions || []) {
        if (leg?.id != null) ids.add(String(leg.id));
      }
      if (saga.replacement?.id != null) ids.add(String(saga.replacement.id));
      if (saga.replacementId != null) ids.add(String(saga.replacementId));
      if (saga.recoveryTransactionId != null) ids.add(String(saga.recoveryTransactionId));
      for (const id of saga.replacementIds?.legIds || []) {
        if (id != null) ids.add(String(id));
      }
      if (saga.replacementIds?.parentId != null) ids.add(String(saga.replacementIds.parentId));
      for (const id of saga.retiredReplacementLegIds || []) {
        if (id != null) ids.add(String(id));
      }
      for (const id of Object.values(saga.idMap || {})) {
        if (id != null) ids.add(String(id));
      }
      for (const id of saga.restoredIds?.legIds || []) {
        if (id != null) ids.add(String(id));
      }
      if (saga.restoredIds?.parentId != null) ids.add(String(saga.restoredIds.parentId));
      break;
    case 'transactionDeletionSagas':
      if (saga.target?.parentId != null) ids.add(String(saga.target.parentId));
      for (const id of saga.target?.legIds || saga.target?.ids || []) {
        if (id != null) ids.add(String(id));
      }
      if (saga.transaction?.id != null) ids.add(String(saga.transaction.id));
      for (const leg of saga.transaction?.subtransactions || []) {
        if (leg?.id != null) ids.add(String(leg.id));
      }
      break;
    case 'repaymentConfirmationSagas':
      if (saga.inflow?.id != null) ids.add(String(saga.inflow.id));
      for (const allocation of saga.allocations || []) {
        if (allocation?.expenseId != null) ids.add(String(allocation.expenseId));
      }
      break;
    case 'reimbursementLinkSagas':
      if (saga.inflowId != null) ids.add(String(saga.inflowId));
      if (saga.expenseId != null) ids.add(String(saga.expenseId));
      break;
    case 'bulkOperationSagas':
      for (const item of saga.items || []) {
        for (const id of item?.txnIds || []) ids.add(String(id));
        for (const id of item?.sourceIds || []) ids.add(String(id));
      }
      if (saga.operationJournalFingerprint != null) ids.add(String(saga.operationJournalFingerprint));
      break;
    default:
      break;
  }
  return ids;
}

function sagaIndexById(store) {
  const byId = new Map();
  for (const saga of Object.values(store?.sagas || {})) {
    if (!saga?.id) continue;
    byId.set(String(saga.id), saga);
  }
  return byId;
}

function normalizeSagaTerminalEvidence(name, value) {
  if (!SAGA_OWNERSHIP_FAMILIES.has(name) || !isObject(value?.sagas)) return value;
  for (const saga of Object.values(value.sagas)) {
    if (!saga || !isTerminalSagaForFamily(name, saga)) continue;
    if (!saga.terminalAt && saga.updatedAt) saga.terminalAt = saga.updatedAt;
  }
  return value;
}

function assertOwnershipNotWeakened(name, previous, next) {
  if (!previous || !next || !SAGA_OWNERSHIP_FAMILIES.has(name)) return;
  const prevById = sagaIndexById(previous);
  const nextById = sagaIndexById(next);
  for (const [id, prevSaga] of prevById) {
    const nextSaga = nextById.get(id);
    if (!nextSaga) {
      if (!isTerminalSagaForFamily(name, prevSaga)) {
        throw new Error(`${name} cannot drop a nonterminal saga ${id}`);
      }
      continue;
    }
    if (isTerminalSagaForFamily(name, prevSaga)) {
      if (!isTerminalSagaForFamily(name, nextSaga)) {
        throw new Error(`${name} cannot reopen terminal saga ${id}`);
      }
      if (String(nextSaga.phase) !== String(prevSaga.phase)) {
        throw new Error(`${name} cannot change terminal phase for saga ${id}`);
      }
      if (prevSaga.terminalAt && !nextSaga.terminalAt) {
        throw new Error(`${name} cannot remove terminal evidence for saga ${id}`);
      }
    }
    const prevOwned = ownedIdsForFamily(name, prevSaga);
    const nextOwned = ownedIdsForFamily(name, nextSaga);
    for (const ownedId of prevOwned) {
      if (!nextOwned.has(ownedId)) {
        throw new Error(`${name} cannot weaken ownership for saga ${id} id ${ownedId}`);
      }
    }
    if (name === 'bulkOperationSagas'
      || name === 'reimbursementLinkSagas'
      || name === 'repaymentConfirmationSagas') {
      if (prevSaga.operationJournalFingerprint != null
        && nextSaga.operationJournalFingerprint !== prevSaga.operationJournalFingerprint) {
        throw new Error(`${name} cannot weaken journal delegation evidence for saga ${id}`);
      }
      if (prevSaga.operationJournalFingerprintVersion != null
        && nextSaga.operationJournalFingerprintVersion !== prevSaga.operationJournalFingerprintVersion) {
        throw new Error(`${name} cannot weaken journal delegation evidence for saga ${id}`);
      }
    }
  }
}

function assertJournalNotWeakened(previous, next) {
  if (!previous?.operations || !next?.operations) return;
  for (const [key, prevOp] of Object.entries(previous.operations)) {
    const nextOp = next.operations[key];
    if (!nextOp) {
      if (!isTerminalOperation(prevOp)) {
        throw new Error(`operationJournal cannot drop a nonterminal operation ${key}`);
      }
      continue;
    }
    if (prevOp.fingerprint != null && nextOp.fingerprint !== prevOp.fingerprint) {
      throw new Error(`operationJournal cannot change fingerprint for operation ${key}`);
    }
    if (prevOp.fingerprintVersion != null && nextOp.fingerprintVersion !== prevOp.fingerprintVersion) {
      throw new Error(`operationJournal cannot change fingerprint version for operation ${key}`);
    }
    if (isTerminalOperation(prevOp)) {
      if (!isTerminalOperation(nextOp)) {
        throw new Error(`operationJournal cannot reopen terminal operation ${key}`);
      }
      if (prevOp.completedAt && !nextOp.completedAt) {
        throw new Error(`operationJournal cannot remove terminal proof for operation ${key}`);
      }
      if (Object.prototype.hasOwnProperty.call(prevOp, 'result')
        && !Object.prototype.hasOwnProperty.call(nextOp, 'result')) {
        throw new Error(`operationJournal cannot remove terminal result for operation ${key}`);
      }
      if (prevOp.status === 'failed' && nextOp.status !== 'failed') {
        throw new Error(`operationJournal cannot change terminal failed status for operation ${key}`);
      }
      if (prevOp.status === 'completed' && nextOp.status !== 'completed') {
        throw new Error(`operationJournal cannot change terminal completed status for operation ${key}`);
      }
    }
  }
}

function assertWriteGuards(name, previous, next) {
  if (name === 'operationJournal') {
    assertJournalNotWeakened(previous, next);
    return;
  }
  assertOwnershipNotWeakened(name, previous, next);
}

module.exports = {
  SEMANTIC_STORES,
  SEMANTIC_VALIDATORS,
  assertJournalNotWeakened,
  assertOwnershipNotWeakened,
  assertWriteGuards,
  isTerminalSagaForFamily,
  normalizeSagaTerminalEvidence,
  operationHasWriteIdentity,
  ownedIdsForFamily,
  semanticValidator,
  validateJournalWriteStrict,
  validateSemantic,
  validateStrictWrite,
};
