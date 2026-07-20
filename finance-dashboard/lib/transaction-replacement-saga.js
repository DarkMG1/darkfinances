'use strict';

const crypto = require('crypto');
const { KnownPreApplyError } = require('./errors');
const { readJsonFile, writeJsonFile } = require('./json-store');

function runtimeStateStore() {
  return require('./runtime-state-store');
}

const RECORD_VERSION = 2;
const TERMINAL_LIMIT = 100;
const TERMINAL_PHASES = new Set(['completed', 'rolled_back']);
const ACCOUNT_RANGE_START = '1900-01-01';
const ACCOUNT_RANGE_END = '9999-12-31';

class SagaInterruption extends Error {
  constructor(message = 'simulated saga interruption') {
    super(message);
    this.name = 'SagaInterruption';
    this.sagaInterruption = true;
  }
}

class SagaOutcomeUnknownError extends Error {
  constructor(message = 'transaction replacement outcome is unresolved') {
    super(message);
    this.name = 'SagaOutcomeUnknownError';
    this.code = 'TRANSACTION_REPLACEMENT_OUTCOME_UNKNOWN';
  }
}

class TransactionReplacementInProgressError extends KnownPreApplyError {
  constructor() {
    super('A replacement for this transaction is already in progress', {
      code: 'TRANSACTION_REPLACEMENT_IN_PROGRESS',
      status: 409,
    });
    this.name = 'TransactionReplacementInProgressError';
  }
}

class TransactionImportedIdConflictError extends KnownPreApplyError {
  constructor() {
    super('Another live transaction already owns this imported identity', {
      code: 'TRANSACTION_IMPORTED_ID_CONFLICT',
      status: 409,
    });
    this.name = 'TransactionImportedIdConflictError';
  }
}

function addableSplitLeg(subtransaction, parentPayee, overrides = {}) {
  const merged = { ...subtransaction, ...overrides };
  const payload = {
    amount: merged.amount,
    category: merged.category || null,
    notes: merged.notes || undefined,
  };
  const legPayee = canonicalLegPayee(merged.payee, parentPayee);
  const normalizedParent = normalizedValue(parentPayee);
  if (legPayee != null && legPayee !== normalizedParent) {
    payload.payee = legPayee;
  }
  return payload;
}

function addableSubtransaction(subtransaction, parentPayee) {
  return addableSplitLeg(subtransaction, parentPayee);
}

function addableTransaction(transaction, overrides = {}) {
  const value = {
    date: transaction.date,
    amount: transaction.amount,
    payee: transaction.payee || undefined,
    notes: transaction.notes || undefined,
    cleared: transaction.cleared,
    imported_id: transaction.imported_id || undefined,
    imported_payee: transaction.imported_payee || undefined,
    category: transaction.category || undefined,
  };
  const sourceSubs = overrides.subtransactions !== undefined
    ? overrides.subtransactions
    : transaction.subtransactions;
  if (Array.isArray(sourceSubs) && sourceSubs.length) {
    delete value.category;
    value.subtransactions = sourceSubs.map((sub) => addableSplitLeg(sub, value.payee));
  }
  return { ...value, ...overrides, subtransactions: value.subtransactions };
}

function legShape(transaction, parentPayee) {
  return {
    amount: transaction?.amount,
    category: normalizedValue(transaction?.category),
    notes: normalizedValue(transaction?.notes),
    payee: canonicalLegPayee(transaction?.payee, parentPayee),
  };
}

function sameLegShape(left, right, parentPayee) {
  return JSON.stringify(legShape(left, parentPayee)) === JSON.stringify(legShape(right, parentPayee));
}

function canonicalLegShapeKey(shape) {
  return JSON.stringify(shape);
}

// Multiset contract: normalize each leg to a fixed record shape, then sort by stable
// serialization. Duplicate shapes remain separate entries; structured collisions are
// only possible when two legs normalize to identical records.
function canonicalLegMultiset(legs, parentPayee) {
  return (Array.isArray(legs) ? legs : [])
    .map((leg) => legShape(leg, parentPayee))
    .sort((left, right) => canonicalLegShapeKey(left).localeCompare(canonicalLegShapeKey(right)));
}

function deriveLegOwnership(original, replacement, requestedLegs) {
  const oldSubs = Array.isArray(original?.subtransactions) ? original.subtransactions : [];
  const newSubs = Array.isArray(replacement?.subtransactions) ? replacement.subtransactions : [];
  let ownership;
  if (Array.isArray(requestedLegs)) {
    if (requestedLegs.length !== newSubs.length) {
      throw new Error('replacement leg ownership does not match the intended legs');
    }
    ownership = requestedLegs.map((leg) => leg?.id == null ? null : String(leg.id));
  } else if (oldSubs.length === newSubs.length) {
    ownership = oldSubs.map((leg) => leg?.id == null ? null : String(leg.id));
  } else {
    ownership = newSubs.map(() => null);
  }

  const originalIds = new Set(oldSubs.map((leg) => String(leg.id)));
  const retained = new Set();
  for (const id of ownership) {
    if (id == null) continue;
    if (!originalIds.has(id) || retained.has(id)) {
      throw new Error('replacement retained-leg ownership is invalid');
    }
    retained.add(id);
  }
  return ownership;
}

function transactionReplacementMap(
  original,
  replacement,
  legOwnership = deriveLegOwnership(original, replacement),
  intendedReplacement = replacement,
) {
  const replacementParentId = String(replacement.id);
  const idMap = { [String(original.id)]: replacementParentId };
  const oldSubs = Array.isArray(original.subtransactions) ? original.subtransactions : [];
  const newSubs = Array.isArray(replacement.subtransactions) ? replacement.subtransactions : [];
  const intendedSubs = Array.isArray(intendedReplacement?.subtransactions)
    ? intendedReplacement.subtransactions
    : [];
  const parentPayee = intendedReplacement?.payee ?? replacement?.payee ?? original?.payee;
  if (newSubs.length !== intendedSubs.length || legOwnership.length !== intendedSubs.length) {
    throw new Error('replacement generated-leg identity is incomplete');
  }

  const retained = new Set();
  const originalIds = new Set(oldSubs.map((leg) => String(leg.id)));
  legOwnership.forEach((oldId, index) => {
    if (oldId == null) return;
    if (!originalIds.has(String(oldId)) || retained.has(String(oldId))) {
      throw new Error('replacement retained-leg ownership is invalid');
    }
    const matches = newSubs.filter((leg) => sameLegShape(leg, intendedSubs[index], parentPayee));
    if (matches.length !== 1 || !matches[0]?.id) {
      throw new Error('replacement retained-leg successor is absent or ambiguous');
    }
    retained.add(String(oldId));
    idMap[String(oldId)] = String(matches[0].id);
  });
  for (const old of oldSubs) {
    if (!retained.has(String(old.id))) idMap[String(old.id)] = replacementParentId;
  }
  return idMap;
}

function replacementCheckpointFromTransaction(saga, transaction) {
  const legOwnership = saga.legOwnership || deriveLegOwnership(
    saga.original,
    saga.replacement,
    saga.requestedLegs || undefined,
  );
  return {
    replacementIds: transactionIds(transaction),
    idMap: transactionReplacementMap(
      saga.original,
      transaction,
      legOwnership,
      saga.replacement,
    ),
  };
}

function retiredReplacementLegIds(saga, nextLegIds) {
  const next = new Set((nextLegIds || []).map(String));
  const retired = new Set((saga.retiredReplacementLegIds || []).map(String));
  for (const id of saga.replacementIds?.legIds || []) {
    if (!next.has(String(id))) retired.add(String(id));
  }
  return [...retired];
}

function rollbackReplacementMap(saga, restored) {
  const restoredOwnership = (saga.original.subtransactions || []).map((leg) => String(leg.id));
  const originalToRestored = transactionReplacementMap(
    saga.original,
    restored,
    restoredOwnership,
    saga.original,
  );
  if (!saga.replacementIds) return originalToRestored;
  if (!saga.idMap || typeof saga.idMap !== 'object') {
    throw new Error('rollback replacement mapping requires refreshed idMap');
  }
  const replacementParentId = String(saga.replacementIds.parentId);
  const replacementToRestored = {
    [replacementParentId]: String(restored.id),
  };
  for (const [originalId, replacementTarget] of Object.entries(saga.idMap)) {
    const restoredTarget = originalToRestored[String(originalId)];
    if (restoredTarget == null) {
      throw new Error('rollback replacement leg mapping is incomplete');
    }
    replacementToRestored[String(replacementTarget)] = String(restoredTarget);
  }
  const retainedReplacementLegIds = new Set(
    Object.values(saga.idMap)
      .map(String)
      .filter((id) => id !== replacementParentId),
  );
  for (const retainedReplacementLegId of retainedReplacementLegIds) {
    if (!(saga.replacementIds.legIds || []).map(String).includes(retainedReplacementLegId)) {
      throw new Error('rollback replacement checkpoint leg ids are stale');
    }
  }
  for (const replacementLegId of saga.replacementIds.legIds || []) {
    if (Object.prototype.hasOwnProperty.call(replacementToRestored, String(replacementLegId))) continue;
    replacementToRestored[String(replacementLegId)] = String(restored.id);
  }
  for (const replacementLegId of saga.retiredReplacementLegIds || []) {
    if (Object.prototype.hasOwnProperty.call(replacementToRestored, String(replacementLegId))) continue;
    replacementToRestored[String(replacementLegId)] = String(restored.id);
  }
  if (saga.replacementId && String(saga.replacementId) !== replacementParentId) {
    replacementToRestored[String(saga.replacementId)] = String(restored.id);
  }
  return mergeMaps(originalToRestored, replacementToRestored);
}

function normalizedTransferId(value) {
  if (value == null || value === false) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function legHasTransferIdentity(leg) {
  return !!(normalizedTransferId(leg?.transfer_id) || normalizedTransferId(leg?.transferred_id));
}

function assertReconstructableTransaction(transaction) {
  const hasTransfer = legHasTransferIdentity(transaction)
    || (transaction?.subtransactions || []).some(legHasTransferIdentity);
  if (hasTransfer) {
    const error = new Error('transfer transactions cannot be rebuilt');
    error.code = 'TRANSFER_RECONSTRUCTION_UNSUPPORTED';
    throw error;
  }
}

function assertIntegerTransaction(transaction, label) {
  if (!Number.isSafeInteger(transaction?.amount)) {
    throw new Error(`${label} parent amount must be integer cents`);
  }
  const legs = Array.isArray(transaction.subtransactions) ? transaction.subtransactions : [];
  if (!legs.length) return;
  let sum = 0;
  for (const leg of legs) {
    if (!Number.isSafeInteger(leg?.amount)) {
      throw new Error(`${label} leg amount must be integer cents`);
    }
    sum += leg.amount;
  }
  if (!Number.isSafeInteger(sum) || sum !== transaction.amount) {
    throw new Error(`${label} legs must conserve parent cents`);
  }
}

function normalizedValue(value) {
  return value == null || value === '' ? null : value;
}

function canonicalLegPayee(legPayee, parentPayee) {
  const normalizedLeg = normalizedValue(legPayee);
  if (normalizedLeg == null) return normalizedValue(parentPayee);
  return normalizedLeg;
}

const METADATA_CONVERGE_ATTEMPTS = 5;

function restorableImportedId(value) {
  return normalizedValue(value);
}

function metadataRestoreFields(row, intendedImportedId) {
  const payload = addableTransaction(row, {
    imported_id: restorableImportedId(intendedImportedId),
  });
  delete payload.subtransactions;
  return payload;
}

function transactionShape(transaction, importedId = transaction?.imported_id) {
  const legs = Array.isArray(transaction?.subtransactions) ? transaction.subtransactions : [];
  const parentPayee = normalizedValue(transaction?.payee);
  return {
    date: String(transaction?.date || ''),
    amount: transaction?.amount,
    payee: parentPayee,
    notes: normalizedValue(transaction?.notes),
    cleared: transaction?.cleared == null ? true : Boolean(transaction.cleared),
    imported_id: normalizedValue(importedId),
    imported_payee: normalizedValue(transaction?.imported_payee),
    category: legs.length ? null : normalizedValue(transaction?.category),
    legs: canonicalLegMultiset(legs, parentPayee),
  };
}

function transactionFingerprint(transaction) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(transactionShape(transaction)))
    .digest('hex');
}

function shapeMatches(actual, expected, importedId = expected?.imported_id) {
  return JSON.stringify(transactionShape(actual)) === JSON.stringify(transactionShape(expected, importedId));
}

function transactionIds(transaction) {
  if (!transaction?.id) throw new Error('replacement parent has no durable Actual id');
  const legIds = (transaction.subtransactions || []).map((leg) => {
    if (!leg?.id) throw new Error('replacement leg has no durable Actual id');
    return String(leg.id);
  });
  return { parentId: String(transaction.id), legIds };
}

function addTransactionIds(ids, transaction) {
  if (!transaction || typeof transaction !== 'object') return;
  if (transaction.id != null) ids.add(String(transaction.id));
  for (const leg of transaction.subtransactions || []) {
    if (leg?.id != null) ids.add(String(leg.id));
  }
}

function addCheckpointedIds(ids, value) {
  if (!value || typeof value !== 'object') return;
  if (value.parentId != null) ids.add(String(value.parentId));
  for (const id of value.legIds || []) {
    if (id != null) ids.add(String(id));
  }
}

function sagaOwnedIds(saga) {
  const ids = new Set();
  addTransactionIds(ids, saga?.original);
  addTransactionIds(ids, saga?.replacement);
  addTransactionIds(ids, saga?.restored);
  addCheckpointedIds(ids, saga?.replacementIds);
  addCheckpointedIds(ids, saga?.restoredIds);
  for (const id of [saga?.replacementId, saga?.recoveryTransactionId]) {
    if (id != null) ids.add(String(id));
  }
  for (const id of saga?.retiredReplacementLegIds || []) {
    if (id != null) ids.add(String(id));
  }
  for (const id of Object.values(saga?.idMap || {})) {
    if (id != null) ids.add(String(id));
  }
  return ids;
}

function presentTransactionIds(rows, targetIds) {
  const targets = new Set([...targetIds].map(String));
  const present = new Set();
  for (const row of rows) {
    if (targets.has(String(row?.id))) present.add(String(row.id));
    for (const leg of row?.subtransactions || []) {
      if (targets.has(String(leg?.id))) present.add(String(leg.id));
    }
  }
  return present;
}

function isTerminalSaga(saga) {
  return saga?.recordVersion === RECORD_VERSION && TERMINAL_PHASES.has(saga.phase);
}

function blocksReplacement(saga) {
  return !isTerminalSaga(saga);
}

function accountMatches(saga, accountId) {
  return saga?.accountId == null || String(saga.accountId) === String(accountId);
}

function candidateTransactionIds({ ids = [], original } = {}) {
  const result = new Set((ids || []).filter((id) => id != null).map(String));
  addTransactionIds(result, original);
  return result;
}

function importedIdentityConflict(rows, importedId, excludedIds = []) {
  const identity = normalizedValue(importedId);
  if (identity == null) return false;
  const excluded = new Set(excludedIds.filter((id) => id != null).map(String));
  return rows.some((row) => (
    normalizedValue(row?.imported_id) === identity
    && !excluded.has(String(row?.id))
  ));
}

function legacyStatus(phase) {
  if (phase === 'completed') return 'completed';
  if (phase === 'rolled_back') return 'recovered';
  // Old code treats "aborted" as terminal and therefore cannot run its unsafe
  // date/amount recovery over a v2 nonterminal record after binary rollback.
  return 'aborted';
}

function migrateLegacySaga(value, id) {
  if (value?.recordVersion === RECORD_VERSION) return { saga: value, changed: false };
  const saga = {
    ...(value && typeof value === 'object' ? value : {}),
    id: String(value?.id || id),
    recordVersion: RECORD_VERSION,
    legacyStatus: String(value?.status || 'unknown'),
    phase: 'legacy_unresolved',
    status: 'aborted',
    updatedAt: value?.updatedAt || value?.startedAt || new Date(0).toISOString(),
  };
  if (value?.replacementId && ['completed', 'replacement-added'].includes(value?.status)) {
    saga.phase = 'legacy_reconcile_forward';
  } else if (value?.recoveryTransactionId && value?.status === 'recovered') {
    saga.phase = 'legacy_reconcile_rollback';
  }
  return { saga, changed: true };
}

function boundedError(error, stage) {
  const raw = String(error?.message || error || 'unknown error')
    .replace(/\bbearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bauthorization(\s*[:=]\s*)\S+(?:\s+\S+)?/gi, 'Authorization$1[redacted]')
    .replace(/\b(password|secret|token)(\s*[:=]\s*)\S+/gi, '$1$2[redacted]')
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//[redacted]@')
    .replace(/\s+/g, ' ')
    .slice(0, 160);
  return {
    stage: String(stage || 'unknown').slice(0, 48),
    code: String(error?.code || error?.name || 'ERROR').slice(0, 48),
    message: raw,
  };
}

function sameError(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

function mergeMaps(...maps) {
  return Object.assign({}, ...maps.filter(Boolean));
}

function createTransactionReplacementSaga({
  sagaPath,
  preflightReferences,
  planReferences,
  applyReferenceStep,
  referencesConverged,
  referenceSteps,
  assertExternalAvailable,
  recoveryOwnershipGuard,
  terminalLimit = TERMINAL_LIMIT,
}) {
  if (!sagaPath) throw new Error('transaction saga path required');

  function loadState() {
    const raw = runtimeStateStore().readRuntimeState('transactionSagas', { file: sagaPath }).value;
    if (!raw || raw.schemaVersion !== 1 || !raw.sagas || typeof raw.sagas !== 'object' || Array.isArray(raw.sagas)) {
      throw new Error('invalid transaction saga state');
    }
    let changed = false;
    const sagas = {};
    for (const [id, value] of Object.entries(raw.sagas)) {
      const migrated = migrateLegacySaga(value, id);
      sagas[id] = migrated.saga;
      changed ||= migrated.changed;
    }
    return { state: { ...raw, schemaVersion: 1, sagas }, changed };
  }

  function pruneState(state) {
    const values = Object.values(state.sagas);
    const active = values.filter((saga) => !isTerminalSaga(saga));
    const terminal = values
      .filter(isTerminalSaga)
      .sort((left, right) => {
        const byTime = String(right.terminalAt || right.updatedAt || '')
          .localeCompare(String(left.terminalAt || left.updatedAt || ''));
        return byTime || String(left.id).localeCompare(String(right.id));
      })
      .slice(0, terminalLimit);
    state.sagas = Object.fromEntries([...active, ...terminal].map((saga) => [saga.id, saga]));
    return state;
  }

  function writeState(state) {
    runtimeStateStore().writeRuntimeState('transactionSagas', pruneState(state), { file: sagaPath });
  }

  function writeSaga(saga) {
    const { state } = loadState();
    state.sagas[saga.id] = saga;
    writeState(state);
  }

  function assertAvailable({ accountId, ids, original } = {}) {
    const candidates = candidateTransactionIds({ ids, original });
    if (!candidates.size) return;
    const { state } = loadState();
    const conflict = Object.values(state.sagas).some((saga) => {
      if (!blocksReplacement(saga) || (accountId && !accountMatches(saga, accountId))) return false;
      const owned = sagaOwnedIds(saga);
      return [...candidates].some((id) => owned.has(id));
    });
    if (conflict) throw new TransactionReplacementInProgressError();
  }

  async function invokeFault(faultInjector, point, saga) {
    if (!faultInjector) return;
    await faultInjector(point, { sagaId: saga?.id || null, phase: saga?.phase || null });
  }

  async function boundary(faultInjector, name, saga, action) {
    await invokeFault(faultInjector, `before:${name}`, saga);
    const result = await action();
    await invokeFault(faultInjector, `after:${name}`, saga);
    return result;
  }

  async function checkpoint(saga, patch, name, faultInjector) {
    await invokeFault(faultInjector, `before:${name}`, saga);
    const next = {
      ...saga,
      ...patch,
      recordVersion: RECORD_VERSION,
      updatedAt: new Date().toISOString(),
    };
    next.status = legacyStatus(next.phase);
    if (isTerminalSaga(next)) next.terminalAt ||= next.updatedAt;
    writeSaga(next);
    Object.assign(saga, next);
    await invokeFault(faultInjector, `after:${name}`, saga);
  }

  async function rememberError(saga, error, stage, faultInjector) {
    const next = boundedError(error, stage);
    if (sameError(saga.lastError, next)) return;
    await checkpoint(saga, { lastError: next }, 'saga-error-checkpoint', faultInjector);
  }

  async function unresolved(saga, reason, faultInjector) {
    const error = new SagaOutcomeUnknownError(reason);
    await rememberError(saga, error, saga.phase, faultInjector);
    return { unresolved: true, error };
  }

  function outcomeUnknown(message, cause) {
    const error = new SagaOutcomeUnknownError(message);
    if (cause) error.cause = cause;
    return error;
  }

  async function transactionsForAccount(api, accountId) {
    return api.getTransactions(accountId, ACCOUNT_RANGE_START, ACCOUNT_RANGE_END);
  }

  async function transactionsFor(api, saga) {
    let accounts;
    try {
      accounts = await api.getAccounts();
    } catch (error) {
      throw outcomeUnknown('unable to enumerate Actual accounts during replacement recovery', error);
    }
    if (!Array.isArray(accounts)) {
      throw outcomeUnknown('Actual account enumeration was invalid during replacement recovery');
    }
    const accountIds = accounts.map((account) => String(account?.id || '')).sort();
    if (accountIds.some((id) => !id) || new Set(accountIds).size !== accountIds.length) {
      throw outcomeUnknown('Actual account enumeration was invalid during replacement recovery');
    }
    if (!accountIds.includes(String(saga.accountId))) {
      throw outcomeUnknown('replacement admission account is absent from Actual account enumeration');
    }

    const ownedIds = sagaOwnedIds(saga);
    const temporaryIdentities = new Set([
      normalizedValue(saga.identity?.value),
      normalizedValue(saga.restoreIdentity?.value),
    ].filter(Boolean).map(String));
    let intendedRows = null;
    const foreignIds = new Set();
    let foreignTemporaryIdentity = false;
    for (const accountId of accountIds) {
      let rows;
      try {
        rows = await transactionsForAccount(api, accountId);
      } catch (error) {
        throw outcomeUnknown(
          `unable to query Actual account ${accountId} during replacement recovery`,
          error,
        );
      }
      if (!Array.isArray(rows)) {
        throw outcomeUnknown(
          `Actual transaction query for account ${accountId} was invalid during replacement recovery`,
        );
      }
      if (accountId === String(saga.accountId)) {
        intendedRows = rows;
        continue;
      }
      for (const id of presentTransactionIds(rows, ownedIds)) foreignIds.add(id);
      if (rows.some((row) => temporaryIdentities.has(String(normalizedValue(row?.imported_id))))) {
        foreignTemporaryIdentity = true;
      }
    }
    if (foreignIds.size) {
      throw outcomeUnknown(
        `saga-owned transaction ids found outside replacement account: ${[...foreignIds].sort().join(',')}`,
      );
    }
    if (foreignTemporaryIdentity) {
      throw outcomeUnknown('temporary replacement identity found outside replacement account');
    }
    return intendedRows;
  }

  async function assertImportedIdentityAvailable(api, { accountId, original }) {
    const rows = await transactionsForAccount(api, accountId);
    if (importedIdentityConflict(rows, original?.imported_id, [original?.id])) {
      throw new TransactionImportedIdConflictError();
    }
  }

  function rowsByIdentity(rows, identity) {
    return rows.filter((row) => String(row.imported_id || '') === String(identity || ''));
  }

  function rowById(rows, id) {
    return rows.find((row) => String(row.id) === String(id)) || null;
  }

  function replacementAddPayload(saga) {
    return addableTransaction(saga.replacement, { imported_id: saga.identity.value });
  }

  function restorationAddPayload(saga) {
    return addableTransaction(saga.original, { imported_id: saga.restoreIdentity.value });
  }

  function replacementMapFor(saga, transaction) {
    return transactionReplacementMap(
      saga.original,
      transaction,
      saga.legOwnership || deriveLegOwnership(
        saga.original,
        saga.replacement,
        saga.requestedLegs || undefined,
      ),
      saga.replacement,
    );
  }

  function rollbackMapFor(saga, restored) {
    return rollbackReplacementMap(saga, restored);
  }

  async function ensureLiveReplacementCheckpoint(api, saga, faultInjector, checkpointName) {
    const rows = await transactionsFor(api, saga);
    const added = rowById(rows, saga.replacementIds?.parentId);
    if (!added || !shapeMatches(added, saga.replacement)) {
      return unresolved(saga, 'replacement row is absent or changed', faultInjector);
    }
    const liveLegIds = (added.subtransactions || []).map((leg) => String(leg.id));
    const checkpointLegIds = (saga.replacementIds?.legIds || []).map(String);
    const sortedLive = [...liveLegIds].sort();
    const sortedCheckpoint = [...checkpointLegIds].sort();
    if (JSON.stringify(sortedLive) === JSON.stringify(sortedCheckpoint)) {
      return { transaction: added };
    }
    let refreshed;
    try {
      refreshed = replacementCheckpointFromTransaction(saga, added);
    } catch (error) {
      return unresolved(saga, error.message, faultInjector);
    }
    await checkpoint(saga, {
      replacementId: refreshed.replacementIds.parentId,
      replacementIds: refreshed.replacementIds,
      idMap: refreshed.idMap,
      retiredReplacementLegIds: retiredReplacementLegIds(saga, refreshed.replacementIds.legIds),
    }, checkpointName, faultInjector);
    return { transaction: added };
  }

  async function prepareReferenceMigration(saga, direction, idMap, phase, faultInjector) {
    const plan = planReferences(idMap);
    await checkpoint(saga, {
      phase,
      referenceMigration: {
        direction,
        idMap,
        stats: plan.stats,
        completed: [],
      },
      referenceStep: null,
    }, 'reference-plan-checkpoint', faultInjector);
  }

  async function migrateReferences(api, saga, direction, donePhase, faultInjector) {
    const migration = saga.referenceMigration;
    if (!migration || migration.direction !== direction) {
      throw new Error(`missing ${direction} reference migration plan`);
    }
    for (const step of referenceSteps) {
      if (migration.completed.includes(step)) continue;
      await transactionsFor(api, saga);
      await checkpoint(saga, { referenceStep: step }, `reference-${step}-pending-checkpoint`, faultInjector);
      await boundary(faultInjector, `reference-${step}-write`, saga, async () => {
        applyReferenceStep(step, migration.idMap, migration);
      });
      migration.completed.push(step);
      await checkpoint(saga, {
        referenceMigration: migration,
        referenceStep: null,
      }, `reference-${step}-checkpoint`, faultInjector);
    }
    if (!referencesConverged(migration.idMap, migration)) {
      throw new Error(`${direction} transaction references did not converge`);
    }
    await checkpoint(saga, { phase: donePhase, referenceStep: null }, 'references-migrated-checkpoint', faultInjector);
  }

  async function restoreImportedMetadataAndConverge(api, saga, faultInjector, {
    boundaryPrefix,
    parentId,
    temporaryIdentity,
    intendedId,
    expected,
    absentReason,
    conflictReason,
    ambiguousReason,
    convergeReason,
  }) {
    let rows = await transactionsFor(api, saga);
    let row = rowById(rows, parentId);
    if (!row) return unresolved(saga, absentReason, faultInjector);
    if (importedIdentityConflict(rows, intendedId, [row.id])) {
      return unresolved(saga, conflictReason, faultInjector);
    }

    const currentImported = normalizedValue(row.imported_id);
    if (currentImported === temporaryIdentity) {
      await boundary(faultInjector, `${boundaryPrefix}-restore`, saga, () => api.updateTransaction(
        row.id,
        metadataRestoreFields(row, intendedId),
      ));
    } else if (currentImported !== intendedId) {
      return unresolved(saga, ambiguousReason, faultInjector);
    }

    for (let attempt = 0; attempt < METADATA_CONVERGE_ATTEMPTS; attempt += 1) {
      rows = await boundary(faultInjector, `${boundaryPrefix}-reconcile`, saga, async () => {
        if (typeof api.sync === 'function') await api.sync();
        return transactionsFor(api, saga);
      });
      row = rowById(rows, parentId);
      if (row
        && !importedIdentityConflict(rows, intendedId, [row.id])
        && shapeMatches(row, expected)) {
        return { row };
      }
    }

    row = rowById(rows, parentId);
    if (!row
      || importedIdentityConflict(rows, intendedId, [row.id])
      || !shapeMatches(row, expected)) {
      return unresolved(saga, convergeReason, faultInjector);
    }
    return { row };
  }

  async function reconcileReplacementIdentity(api, saga, faultInjector) {
    const matches = await boundary(faultInjector, 'replacement-reconcile', saga, async () => {
      const rows = await transactionsFor(api, saga);
      return rowsByIdentity(rows, saga.identity.value);
    });
    if (matches.length !== 1) {
      return unresolved(
        saga,
        matches.length ? 'replacement identity is ambiguous' : 'replacement identity is absent',
        faultInjector,
      );
    }
    const added = matches[0];
    if (!shapeMatches(added, saga.replacement, saga.identity.value)) {
      return unresolved(saga, 'replacement identity content does not match intent', faultInjector);
    }
    const ids = transactionIds(added);
    let idMap;
    try {
      idMap = replacementMapFor(saga, added);
    } catch (error) {
      return unresolved(saga, error.message, faultInjector);
    }
    await checkpoint(saga, {
      phase: 'replacement_identified',
      replacementId: ids.parentId,
      replacementIds: ids,
      idMap,
      lastError: null,
    }, 'replacement-id-checkpoint', faultInjector);
    return { transaction: added };
  }

  async function driveForward(api, saga, { faultInjector, recovery }) {
    for (;;) {
      if (saga.phase === 'prepared') {
        await checkpoint(saga, { phase: 'delete_pending' }, 'original-delete-checkpoint', faultInjector);
        continue;
      }

      if (saga.phase === 'delete_pending') {
        let rows = await transactionsFor(api, saga);
        if (importedIdentityConflict(rows, saga.original.imported_id, [saga.original.id])) {
          return unresolved(saga, 'original imported identity is owned by another live transaction', faultInjector);
        }
        const matches = rowsByIdentity(rows, saga.identity.value);
        if (matches.length > 1) return unresolved(saga, 'replacement identity is ambiguous', faultInjector);
        const original = rowById(rows, saga.original.id);
        if (original) {
          await boundary(faultInjector, 'original-deletion', saga, () => api.deleteTransaction(original.id));
          rows = await transactionsFor(api, saga);
          if (rowById(rows, saga.original.id)) {
            return unresolved(saga, 'original deletion could not be verified', faultInjector);
          }
        }
        await checkpoint(saga, { phase: 'original_deleted' }, 'original-deleted-checkpoint', faultInjector);
        continue;
      }

      if (saga.phase === 'original_deleted') {
        const rows = await transactionsFor(api, saga);
        if (rowById(rows, saga.original.id)) {
          await checkpoint(saga, { phase: 'delete_pending' }, 'original-delete-checkpoint', faultInjector);
          continue;
        }
        await checkpoint(saga, { phase: 'replacement_add_pending' }, 'replacement-add-checkpoint', faultInjector);
        continue;
      }

      if (saga.phase === 'replacement_add_pending') {
        let rows = await transactionsFor(api, saga);
        if (rowById(rows, saga.original.id)) {
          await checkpoint(saga, { phase: 'delete_pending' }, 'original-delete-checkpoint', faultInjector);
          continue;
        }
        let matches = rowsByIdentity(rows, saga.identity.value);
        if (matches.length > 1) return unresolved(saga, 'replacement identity is ambiguous', faultInjector);
        if (matches.length === 0) {
          await boundary(faultInjector, 'replacement-add', saga, () => api.addTransactions(
            saga.accountId,
            [replacementAddPayload(saga)],
            { learnCategories: false, runTransfers: false },
          ));
        }
        const reconciled = await reconcileReplacementIdentity(api, saga, faultInjector);
        if (reconciled.unresolved) return reconciled;
        continue;
      }

      if (saga.phase === 'replacement_identified') {
        const rows = await transactionsFor(api, saga);
        const added = rowById(rows, saga.replacementIds?.parentId);
        if (!added) return unresolved(saga, 'checkpointed replacement id is absent', faultInjector);
        const importedId = normalizedValue(added.imported_id);
        const intendedId = normalizedValue(saga.replacement.imported_id);
        if (importedId !== saga.identity.value && importedId !== intendedId) {
          return unresolved(saga, 'checkpointed replacement identity changed unexpectedly', faultInjector);
        }
        await checkpoint(saga, { phase: 'replacement_metadata_pending' }, 'replacement-metadata-checkpoint', faultInjector);
        continue;
      }

      if (saga.phase === 'replacement_metadata_pending') {
        const intendedId = normalizedValue(saga.replacement.imported_id);
        const converged = await restoreImportedMetadataAndConverge(api, saga, faultInjector, {
          boundaryPrefix: 'replacement-metadata',
          parentId: saga.replacementIds?.parentId,
          temporaryIdentity: saga.identity.value,
          intendedId,
          expected: saga.replacement,
          absentReason: 'checkpointed replacement id is absent',
          conflictReason: 'replacement imported identity is owned by another live transaction',
          ambiguousReason: 'replacement import metadata is ambiguous',
          convergeReason: 'replacement metadata or financial shape did not converge',
        });
        if (converged.unresolved) return converged;
        const convergedRow = converged.row;
        let refreshedIds;
        let refreshedIdMap;
        try {
          refreshedIds = transactionIds(convergedRow);
          refreshedIdMap = replacementMapFor(saga, convergedRow);
        } catch (error) {
          return unresolved(saga, error.message, faultInjector);
        }
        await checkpoint(saga, {
          phase: 'replacement_ready',
          replacementId: refreshedIds.parentId,
          replacementIds: refreshedIds,
          idMap: refreshedIdMap,
          retiredReplacementLegIds: retiredReplacementLegIds(saga, refreshedIds.legIds),
          lastError: null,
        }, 'replacement-ready-checkpoint', faultInjector);
        continue;
      }

      if (saga.phase === 'replacement_ready') {
        const rows = await transactionsFor(api, saga);
        const added = rowById(rows, saga.replacementIds?.parentId);
        if (!added || !shapeMatches(added, saga.replacement)) {
          return unresolved(saga, 'replacement row is absent or changed', faultInjector);
        }
        let refreshedIds;
        let refreshedIdMap;
        try {
          refreshedIds = transactionIds(added);
          refreshedIdMap = replacementMapFor(saga, added);
        } catch (error) {
          return unresolved(saga, error.message, faultInjector);
        }
        if (JSON.stringify(refreshedIds.legIds) !== JSON.stringify(saga.replacementIds?.legIds || [])
          || JSON.stringify(refreshedIdMap) !== JSON.stringify(saga.idMap || {})) {
          await checkpoint(saga, {
            replacementId: refreshedIds.parentId,
            replacementIds: refreshedIds,
            idMap: refreshedIdMap,
            retiredReplacementLegIds: retiredReplacementLegIds(saga, refreshedIds.legIds),
          }, 'replacement-pre-reference-id-checkpoint', faultInjector);
        }
        if (!saga.referenceMigration || saga.referenceMigration.direction !== 'forward') {
          await prepareReferenceMigration(
            saga,
            'forward',
            saga.idMap || replacementMapFor(saga, added),
            'references_pending',
            faultInjector,
          );
        } else {
          await checkpoint(saga, { phase: 'references_pending' }, 'reference-plan-checkpoint', faultInjector);
        }
        continue;
      }

      if (saga.phase === 'references_pending') {
        await migrateReferences(api, saga, 'forward', 'references_migrated', faultInjector);
        continue;
      }

      if (saga.phase === 'references_migrated') {
        const live = await ensureLiveReplacementCheckpoint(
          api,
          saga,
          faultInjector,
          'replacement-return-id-checkpoint',
        );
        if (live.unresolved) return live;
        const added = live.transaction;
        const rows = await transactionsFor(api, saga);
        if (!added
          || rowById(rows, saga.original.id)
          || importedIdentityConflict(rows, saga.replacement.imported_id, [added.id])
          || !shapeMatches(added, saga.replacement)) {
          return unresolved(saga, 'replacement final-state verification failed', faultInjector);
        }
        if (!referencesConverged(saga.referenceMigration.idMap, saga.referenceMigration)) {
          return unresolved(saga, 'replacement references are inconsistent', faultInjector);
        }
        if (recovery) {
          await checkpoint(saga, { phase: 'sync_pending' }, 'sync-pending-checkpoint', faultInjector);
          return {
            needsSync: true,
            transaction: added,
            idMap: saga.idMap,
            references: saga.referenceMigration.stats,
          };
        }
        await checkpoint(saga, { phase: 'completed', lastError: null }, 'saga-terminal-write', faultInjector);
        return {
          transaction: added,
          idMap: saga.idMap,
          references: saga.referenceMigration.stats,
        };
      }

      if (saga.phase === 'sync_pending') {
        await transactionsFor(api, saga);
        return { needsSync: true };
      }
      if (saga.phase === 'completed') {
        const live = await ensureLiveReplacementCheckpoint(
          api,
          saga,
          faultInjector,
          'replacement-completed-id-checkpoint',
        );
        if (live.unresolved) return live;
        return {
          transaction: live.transaction,
          idMap: saga.idMap,
          references: saga.referenceMigration?.stats,
        };
      }
      throw new Error(`unsupported replacement saga phase: ${saga.phase}`);
    }
  }

  async function driveRollback(api, saga, { faultInjector }) {
    for (;;) {
      if (saga.phase === 'rollback_requested') {
        await checkpoint(saga, { phase: 'rollback_delete_pending' }, 'rollback-delete-checkpoint', faultInjector);
        continue;
      }

      if (saga.phase === 'rollback_delete_pending') {
        let rows = await transactionsFor(api, saga);
        const replacement = rowById(rows, saga.replacementIds?.parentId);
        if (replacement) {
          await boundary(faultInjector, 'rollback-deletion', saga, () => api.deleteTransaction(replacement.id));
          rows = await transactionsFor(api, saga);
          if (rowById(rows, replacement.id)) {
            return unresolved(saga, 'rollback deletion could not be verified', faultInjector);
          }
        }
        await checkpoint(saga, { phase: 'rollback_deleted' }, 'rollback-deleted-checkpoint', faultInjector);
        continue;
      }

      if (saga.phase === 'rollback_deleted') {
        const rows = await transactionsFor(api, saga);
        const existing = rowById(rows, saga.original.id);
        if (existing) {
          if (!shapeMatches(existing, saga.original)) {
            return unresolved(saga, 'original id exists with unexpected content', faultInjector);
          }
          const ids = transactionIds(existing);
          await checkpoint(saga, {
            phase: 'restored_identified',
            recoveryTransactionId: ids.parentId,
            restoredIds: ids,
            rollbackIdMap: rollbackMapFor(saga, existing),
          }, 'restored-id-checkpoint', faultInjector);
          continue;
        }
        await checkpoint(saga, { phase: 'restore_add_pending' }, 'original-restore-checkpoint', faultInjector);
        continue;
      }

      if (saga.phase === 'restore_add_pending') {
        let rows = await transactionsFor(api, saga);
        let matches = rowsByIdentity(rows, saga.restoreIdentity.value);
        if (matches.length > 1) return unresolved(saga, 'restoration identity is ambiguous', faultInjector);
        if (matches.length === 0) {
          await boundary(faultInjector, 'original-restoration', saga, () => api.addTransactions(
            saga.accountId,
            [restorationAddPayload(saga)],
            { learnCategories: false, runTransfers: false },
          ));
        }
        matches = await boundary(faultInjector, 'restored-reconcile', saga, async () => {
          rows = await transactionsFor(api, saga);
          return rowsByIdentity(rows, saga.restoreIdentity.value);
        });
        if (matches.length !== 1) {
          return unresolved(
            saga,
            matches.length ? 'restoration identity is ambiguous' : 'restoration identity is absent',
            faultInjector,
          );
        }
        const restored = matches[0];
        if (!shapeMatches(restored, saga.original, saga.restoreIdentity.value)) {
          return unresolved(saga, 'restored identity content does not match original', faultInjector);
        }
        const ids = transactionIds(restored);
        await checkpoint(saga, {
          phase: 'restored_identified',
          recoveryTransactionId: ids.parentId,
          restoredIds: ids,
          rollbackIdMap: rollbackMapFor(saga, restored),
          lastError: null,
        }, 'restored-id-checkpoint', faultInjector);
        continue;
      }

      if (saga.phase === 'restored_identified') {
        await checkpoint(saga, { phase: 'restore_metadata_pending' }, 'restored-metadata-checkpoint', faultInjector);
        continue;
      }

      if (saga.phase === 'restore_metadata_pending') {
        const intendedId = normalizedValue(saga.original.imported_id);
        const converged = await restoreImportedMetadataAndConverge(api, saga, faultInjector, {
          boundaryPrefix: 'restored-metadata',
          parentId: saga.restoredIds?.parentId,
          temporaryIdentity: saga.restoreIdentity.value,
          intendedId,
          expected: saga.original,
          absentReason: 'checkpointed restored id is absent',
          conflictReason: 'restored imported identity is owned by another live transaction',
          ambiguousReason: 'restored import metadata is ambiguous',
          convergeReason: 'restored transaction did not converge',
        });
        if (converged.unresolved) return converged;
        let refreshedRestoredIds;
        try {
          refreshedRestoredIds = transactionIds(converged.row);
        } catch (error) {
          return unresolved(saga, error.message, faultInjector);
        }
        await checkpoint(saga, {
          phase: 'restored_ready',
          restoredIds: refreshedRestoredIds,
          recoveryTransactionId: refreshedRestoredIds.parentId,
          rollbackIdMap: rollbackMapFor(saga, converged.row),
          lastError: null,
        }, 'restored-ready-checkpoint', faultInjector);
        continue;
      }

      if (saga.phase === 'restored_ready') {
        await transactionsFor(api, saga);
        if (!saga.referenceMigration || saga.referenceMigration.direction !== 'rollback') {
          await prepareReferenceMigration(
            saga,
            'rollback',
            saga.rollbackIdMap,
            'rollback_references_pending',
            faultInjector,
          );
        } else {
          await checkpoint(saga, { phase: 'rollback_references_pending' }, 'reference-plan-checkpoint', faultInjector);
        }
        continue;
      }

      if (saga.phase === 'rollback_references_pending') {
        await migrateReferences(api, saga, 'rollback', 'rollback_references_migrated', faultInjector);
        continue;
      }

      if (saga.phase === 'rollback_references_migrated') {
        const rows = await transactionsFor(api, saga);
        const restored = rowById(rows, saga.restoredIds?.parentId);
        const replacement = rowById(rows, saga.replacementIds?.parentId);
        if (!restored
          || replacement
          || importedIdentityConflict(rows, saga.original.imported_id, [restored.id])
          || !shapeMatches(restored, saga.original)) {
          return unresolved(saga, 'rollback final-state verification failed', faultInjector);
        }
        if (!referencesConverged(saga.referenceMigration.idMap, saga.referenceMigration)) {
          return unresolved(saga, 'rollback references are inconsistent', faultInjector);
        }
        await checkpoint(saga, { phase: 'rollback_sync_pending' }, 'sync-pending-checkpoint', faultInjector);
        return { needsSync: true };
      }

      if (saga.phase === 'rollback_sync_pending') {
        await transactionsFor(api, saga);
        return { needsSync: true };
      }
      if (saga.phase === 'rolled_back') return { rolledBack: true };
      throw new Error(`unsupported rollback saga phase: ${saga.phase}`);
    }
  }

  async function terminalizeSynced(api, sagas, faultInjector) {
    let firstError = null;
    for (const saga of sagas) {
      try {
        const rows = await transactionsFor(api, saga);
        if (saga.phase === 'sync_pending') {
          const replacement = rowById(rows, saga.replacementIds?.parentId);
          if (!replacement
            || rowById(rows, saga.original.id)
            || importedIdentityConflict(rows, saga.replacement.imported_id, [replacement.id])
            || !shapeMatches(replacement, saga.replacement)) {
            const error = new Error('replacement changed before terminal checkpoint');
            await rememberError(saga, error, 'sync_pending', faultInjector);
            firstError ||= error;
            continue;
          }
          if (!referencesConverged(saga.referenceMigration.idMap, saga.referenceMigration)) {
            const error = new Error('replacement references changed before terminal checkpoint');
            await rememberError(saga, error, 'sync_pending', faultInjector);
            firstError ||= error;
            continue;
          }
          await checkpoint(saga, { phase: 'completed', lastError: null }, 'saga-terminal-write', faultInjector);
        } else if (saga.phase === 'rollback_sync_pending') {
          const restored = rowById(rows, saga.restoredIds?.parentId);
          if (!restored
            || rowById(rows, saga.replacementIds?.parentId)
            || importedIdentityConflict(rows, saga.original.imported_id, [restored.id])
            || !shapeMatches(restored, saga.original)) {
            const error = new Error('rollback changed before terminal checkpoint');
            await rememberError(saga, error, 'rollback_sync_pending', faultInjector);
            firstError ||= error;
            continue;
          }
          if (!referencesConverged(saga.referenceMigration.idMap, saga.referenceMigration)) {
            const error = new Error('rollback references changed before terminal checkpoint');
            await rememberError(saga, error, 'rollback_sync_pending', faultInjector);
            firstError ||= error;
            continue;
          }
          await checkpoint(saga, { phase: 'rolled_back', lastError: null }, 'saga-terminal-write', faultInjector);
        }
      } catch (error) {
        if (!isTerminalSaga(saga)) {
          try { await rememberError(saga, error, saga.phase, faultInjector); } catch (_) {}
        }
        firstError ||= error;
      }
    }
    if (firstError) throw firstError;
  }

  async function finishSync(api, sagas, faultInjector) {
    if (!sagas.length) return;
    await boundary(faultInjector, 'sync', sagas[0], () => api.sync());
    await terminalizeSynced(api, sagas, faultInjector);
  }

  function canRollback(saga) {
    return [
      'replacement_identified',
      'replacement_metadata_pending',
      'replacement_ready',
      'references_pending',
      'references_migrated',
    ].includes(saga.phase);
  }

  async function replace(api, {
    accountId,
    original,
    replacement,
    requestedLegs,
    faultInjector,
  }) {
    assertReconstructableTransaction(original);
    assertReconstructableTransaction(replacement);
    assertIntegerTransaction(replacement, 'replacement');
    if (String(original.date) !== String(replacement.date) || original.amount !== replacement.amount) {
      throw new Error('replacement must preserve parent date and amount');
    }
    const legOwnership = deriveLegOwnership(original, replacement, requestedLegs);
    assertAvailable({ accountId, original });
    if (assertExternalAvailable) assertExternalAvailable({ accountId, original });
    await assertImportedIdentityAvailable(api, { accountId, original });
    preflightReferences();
    const identity = `df-replace:${crypto.randomUUID()}`;
    const restoreIdentity = `df-restore:${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const saga = {
      id: `replace_${crypto.randomUUID()}`,
      recordVersion: RECORD_VERSION,
      status: 'aborted',
      phase: 'prepared',
      accountId: String(accountId),
      original: structuredClone(original),
      replacement: structuredClone(replacement),
      requestedLegs: requestedLegs ? structuredClone(requestedLegs) : null,
      legOwnership,
      identity: { field: 'imported_id', value: identity },
      restoreIdentity: { field: 'imported_id', value: restoreIdentity },
      originalFingerprint: transactionFingerprint(original),
      replacementFingerprint: transactionFingerprint(replacement),
      startedAt: now,
      updatedAt: now,
    };
    await invokeFault(faultInjector, 'before:initial-saga-write', saga);
    writeSaga(saga);
    await invokeFault(faultInjector, 'after:initial-saga-write', saga);

    try {
      const result = await driveForward(api, saga, { faultInjector, recovery: true });
      if (result.unresolved) throw result.error;
      return result;
    } catch (error) {
      if (error?.sagaInterruption || !canRollback(saga)) {
        try { await rememberError(saga, error, saga.phase, faultInjector); } catch (_) {}
        throw error;
      }
      try {
        await checkpoint(saga, {
          phase: 'rollback_requested',
          failure: boundedError(error, saga.phase),
        }, 'rollback-start-checkpoint', faultInjector);
        const rollback = await driveRollback(api, saga, { faultInjector });
        if (rollback.unresolved) throw rollback.error;
        await finishSync(api, [saga], faultInjector);
        error.recoveryTransactionId = saga.restoredIds?.parentId || null;
      } catch (recoveryError) {
        error.recoveryError = recoveryError;
        try { await rememberError(saga, recoveryError, saga.phase, faultInjector); } catch (_) {}
      }
      throw error;
    }
  }

  async function reconcileLegacyForward(api, saga, faultInjector) {
    const rows = await transactionsFor(api, saga);
    const replacement = rowById(rows, saga.replacementId);
    if (!replacement || !shapeMatches(replacement, saga.replacement)) {
      return unresolved(saga, 'legacy replacement lacks verifiable durable identity', faultInjector);
    }
    const original = rowById(rows, saga.original.id);
    if (original && importedIdentityConflict(rows, saga.original.imported_id, [original.id])) {
      return unresolved(saga, 'legacy original imported identity has another live owner', faultInjector);
    }
    if (!original && importedIdentityConflict(rows, saga.replacement.imported_id, [replacement.id])) {
      return unresolved(saga, 'legacy replacement imported identity has another live owner', faultInjector);
    }
    if (original && String(original.id) !== String(replacement.id)) {
      await checkpoint(saga, { legacyDeletePending: true }, 'original-delete-checkpoint', faultInjector);
      await boundary(faultInjector, 'original-deletion', saga, () => api.deleteTransaction(original.id));
      const after = await transactionsFor(api, saga);
      if (rowById(after, original.id)) {
        return unresolved(saga, 'legacy original deletion could not be verified', faultInjector);
      }
    }
    const ids = transactionIds(replacement);
    await checkpoint(saga, {
      phase: 'replacement_ready',
      replacementIds: ids,
      replacementId: ids.parentId,
      idMap: replacementMapFor(saga, replacement),
      lastError: null,
    }, 'replacement-id-checkpoint', faultInjector);
    return driveForward(api, saga, { faultInjector, recovery: true });
  }

  async function reconcileLegacyRollback(api, saga, faultInjector) {
    const rows = await transactionsFor(api, saga);
    const restored = rowById(rows, saga.recoveryTransactionId);
    if (!restored || !shapeMatches(restored, saga.original)) {
      return unresolved(saga, 'legacy rollback lacks verifiable durable identity', faultInjector);
    }
    if (importedIdentityConflict(rows, saga.original.imported_id, [restored.id])) {
      return unresolved(saga, 'legacy restored imported identity has another live owner', faultInjector);
    }
    const duplicateOriginal = rowById(rows, saga.original.id);
    if (duplicateOriginal && String(duplicateOriginal.id) !== String(restored.id)) {
      return unresolved(saga, 'legacy rollback has multiple saga-owned originals', faultInjector);
    }
    const ids = transactionIds(restored);
    const rollbackIdMap = rollbackMapFor(saga, restored);
    if (saga.replacementId) rollbackIdMap[String(saga.replacementId)] = ids.parentId;
    await checkpoint(saga, {
      phase: 'restored_ready',
      restoredIds: ids,
      recoveryTransactionId: ids.parentId,
      rollbackIdMap,
      lastError: null,
    }, 'restored-id-checkpoint', faultInjector);
    return driveRollback(api, saga, { faultInjector });
  }

  async function recover(api, { faultInjector, deferSync = false } = {}) {
    const loaded = loadState();
    if (loaded.changed) writeState(loaded.state);
    const active = Object.values(loaded.state.sagas).filter((saga) => !isTerminalSaga(saga));
    const syncPending = [];
    const errors = [];
    let firstThrownError = null;
    for (const saga of active) {
      let result;
      if (saga.phase === 'legacy_unresolved') continue;
      if (recoveryOwnershipGuard?.(saga)) continue;
      try {
        if (saga.phase === 'legacy_reconcile_forward') {
          result = await reconcileLegacyForward(api, saga, faultInjector);
        } else if (saga.phase === 'legacy_reconcile_rollback') {
          result = await reconcileLegacyRollback(api, saga, faultInjector);
        } else if (saga.phase.startsWith('rollback_')
          || ['restored_identified', 'restore_add_pending', 'restore_metadata_pending', 'restored_ready'].includes(saga.phase)) {
          result = await driveRollback(api, saga, { faultInjector });
        } else {
          result = await driveForward(api, saga, { faultInjector, recovery: true });
        }
      } catch (error) {
        try { await rememberError(saga, error, saga.phase, faultInjector); } catch (_) {}
        errors.push({ sagaId: saga.id, error });
        firstThrownError ||= error;
        continue;
      }
      if (result?.unresolved) errors.push({ sagaId: saga.id, error: result.error });
      if (result?.needsSync) syncPending.push(saga);
    }
    if (deferSync) {
      return {
        needsSync: syncPending.length > 0,
        errors,
      };
    }
    await finishSync(api, syncPending, faultInjector);
    if (firstThrownError) throw firstThrownError;
    return {
      needsSync: syncPending.length > 0,
      errors,
    };
  }

  async function markSynced(api, { faultInjector } = {}) {
    const loaded = loadState();
    if (loaded.changed) writeState(loaded.state);
    const syncPending = Object.values(loaded.state.sagas)
      .filter((saga) => ['sync_pending', 'rollback_sync_pending'].includes(saga.phase));
    await terminalizeSynced(api, syncPending, faultInjector);
  }

  function inspectState() {
    return loadState().state;
  }

  return {
    assertAvailable,
    assertImportedIdentityAvailable,
    inspectState,
    markSynced,
    recover,
    replace,
  };
}

module.exports = {
  RECORD_VERSION,
  SagaInterruption,
  SagaOutcomeUnknownError,
  TransactionImportedIdConflictError,
  TransactionReplacementInProgressError,
  addableSplitLeg,
  addableTransaction,
  assertReconstructableTransaction,
  canonicalLegMultiset,
  createTransactionReplacementSaga,
  rollbackReplacementMap,
  replacementCheckpointFromTransaction,
  shapeMatches,
  transactionFingerprint,
  transactionReplacementMap,
  transactionShape,
};
