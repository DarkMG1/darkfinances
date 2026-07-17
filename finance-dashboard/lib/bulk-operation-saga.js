'use strict';

const crypto = require('crypto');
const { AppError, KnownPreApplyError } = require('./errors');
const { readJsonFile, writeJsonFile } = require('./json-store');
const {
  categoryIdentityMatches,
  categoryIntentMatches,
  canonicalRulesFingerprint,
} = require('./bulk-operation-fingerprint');
const {
  ACCOUNT_RANGE_END,
  ACCOUNT_RANGE_START,
  foreignAccountIds,
  locateItemTransactionEverywhere,
  planPhantomCleanup,
  planRulesApply,
  planRulesSave,
} = require('./bulk-operation-adapters');

const RECORD_VERSION = 1;
const TERMINAL_LIMIT = 100;
const TERMINAL_PHASES = new Set(['completed', 'unresolved']);

class BulkOperationOutcomeUnknownError extends Error {
  constructor(message = 'bulk operation outcome is unresolved') {
    super(message);
    this.name = 'BulkOperationOutcomeUnknownError';
    this.code = 'BULK_OPERATION_OUTCOME_UNKNOWN';
  }
}

class BulkOperationInProgressError extends KnownPreApplyError {
  constructor() {
    super('A bulk operation for this transaction is already in progress', {
      code: 'BULK_OPERATION_IN_PROGRESS',
      status: 409,
    });
    this.name = 'BulkOperationInProgressError';
  }
}

class BulkOperationStateError extends Error {
  constructor(message = 'bulk operation saga state is invalid') {
    super(message);
    this.name = 'BulkOperationStateError';
    this.code = 'BULK_OPERATION_STATE_INVALID';
  }
}

function sagasForOperationKey(state, operationKey) {
  if (!operationKey) return [];
  return Object.values(state.sagas || {}).filter((saga) => saga.operationKey === operationKey);
}

function idempotencyKeyReuseError() {
  return new AppError('Idempotency key was already used for a different request', {
    code: 'IDEMPOTENCY_KEY_REUSED',
    status: 409,
    expose: true,
  });
}

function normalizeJournalBinding(binding) {
  if (!binding?.fingerprint) return null;
  return {
    fingerprint: binding.fingerprint,
    fingerprintVersion: binding.fingerprintVersion,
    method: binding.method || null,
    route: binding.route || null,
  };
}

function journalBindingsMatch(saga, binding, kind) {
  const normalized = normalizeJournalBinding(binding);
  if (!normalized) return false;
  if (!saga?.operationJournalFingerprint) return false;
  if (saga.operationJournalFingerprint !== normalized.fingerprint) return false;
  if (saga.operationJournalFingerprintVersion !== normalized.fingerprintVersion) return false;
  if (saga.operationJournalMethod && normalized.method
    && saga.operationJournalMethod !== normalized.method) return false;
  if (saga.operationJournalRoute && normalized.route
    && saga.operationJournalRoute !== normalized.route) return false;
  if (kind && saga.kind && saga.kind !== kind) return false;
  return true;
}

function assertJournalBinding(saga, binding, kind) {
  const normalized = normalizeJournalBinding(binding);
  if (!normalized) return;
  if (!saga?.operationJournalFingerprint || !journalBindingsMatch(saga, normalized, kind)) {
    throw idempotencyKeyReuseError();
  }
}

function isTerminalSaga(saga) {
  return saga?.recordVersion === RECORD_VERSION && TERMINAL_PHASES.has(saga.phase);
}

function isRecordedDeletionSagaId(value) {
  return typeof value === 'string' && value.length > 0 && value !== 'pending';
}

function boundedError(error, stage) {
  const message = String(error?.message || error || 'unknown error')
    .replace(/\bbearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bauthorization(\s*[:=]\s*)\S+(?:\s+\S+)?/gi, 'Authorization$1[redacted]')
    .replace(/\b(password|secret|token)(\s*[:=]\s*)\S+/gi, '$1$2[redacted]')
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//[redacted]@')
    .replace(/\s+/g, ' ')
    .slice(0, 160);
  return {
    stage: String(stage || 'unknown').slice(0, 48),
    code: String(error?.code || error?.name || 'ERROR').slice(0, 48),
    message,
  };
}

function sameError(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

function phantomResourceReleased(saga) {
  return isTerminalSaga(saga) || saga.phase === 'sync_pending';
}

function sagaOwnedIds(saga) {
  const ids = new Set();
  for (const item of saga?.plan?.items || []) {
    if (!item.txnId) continue;
    const outcome = saga.itemOutcomes?.[String(item.globalIndex)];
    const settled = outcome?.status === 'completed' || outcome?.status === 'failed';
    if (saga.kind === 'phantom_cleanup' && ['phantom_seen', 'phantom_delete'].includes(item.itemType)) {
      if (!phantomResourceReleased(saga)) ids.add(String(item.txnId));
      continue;
    }
    if (settled) continue;
    ids.add(String(item.txnId));
  }
  return ids;
}

function candidateIds({ ids = [] } = {}) {
  return new Set((ids || []).filter((id) => id != null).map(String));
}

function bulkOperationId(operationKey, kind, paramsFingerprint) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ operationKey: operationKey || null, kind, paramsFingerprint }))
    .digest('hex')
    .slice(0, 32);
}

function summarizeAuditOutcome(saga) {
  const outcomes = Object.values(saga.itemOutcomes || {});
  const applied = outcomes.filter((entry) => entry.status === 'completed').length;
  const failed = outcomes.filter((entry) => entry.status === 'failed').length;
  const totalItems = saga.plan?.items?.length || 0;
  const itemsSettled = applied + failed;
  let status = 'completed';
  if (saga.phase === 'unresolved') status = 'unresolved';
  else if (!isTerminalSaga(saga)) status = 'in_progress';
  else if (itemsSettled < totalItems) status = 'in_progress';
  return {
    status,
    applied,
    failed,
    skipped: 0,
    failedItems: outcomes.filter((entry) => entry.status === 'failed'),
  };
}

function createBulkOperationSaga({
  sagaPath,
  readRules,
  writeRules,
  readPhantomSeen,
  writePhantomSeen,
  readPhantomLog,
  writePhantomLog,
  deleteTransaction,
  inspectDeletionState,
  recoverDeletionSagas,
  assertExternalAvailable,
  merchantCatalog,
  catalogTypeMatch,
  resolveCatalogCategory,
  buildCatInfo,
  settleUpPayee,
  reimbCat,
  incomeGroup,
  moneyMovementGroup,
  todayYMD,
  addDays,
  terminalLimit = TERMINAL_LIMIT,
}) {
  if (!sagaPath) throw new Error('bulk operation saga path required');

  function loadState() {
    const state = readJsonFile(sagaPath, { schemaVersion: 1, sagas: {} });
    if (!state
      || state.schemaVersion !== 1
      || !state.sagas
      || typeof state.sagas !== 'object'
      || Array.isArray(state.sagas)) {
      throw new Error('invalid bulk operation saga state');
    }
    return state;
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
    writeJsonFile(sagaPath, pruneState(state));
  }

  function writeSaga(saga) {
    const state = loadState();
    state.sagas[saga.id] = saga;
    writeState(state);
  }

  function findByOperationKey(operationKey) {
    if (!operationKey) return null;
    const matches = sagasForOperationKey(loadState(), operationKey);
    if (matches.length > 1) {
      throw new BulkOperationStateError(
        `duplicate bulk operation records share operation key ${operationKey}`,
      );
    }
    return matches[0] || null;
  }

  function assertJournalAdmission({ operationKey, journalBinding, kind }) {
    if (!operationKey) return;
    const normalized = normalizeJournalBinding(journalBinding);
    if (!normalized) return;
    const existing = findByOperationKey(operationKey);
    if (!existing) return;
    assertJournalBinding(existing, normalized, kind);
  }

  function proveTerminalJournalCompletion(operationKey, journalOperation) {
    if (!operationKey || !journalOperation?.fingerprint) return null;
    if (journalOperation.fingerprintVersion == null) return null;
    let state;
    try {
      state = loadState();
    } catch (_) {
      return null;
    }
    const matches = sagasForOperationKey(state, operationKey);
    if (matches.length !== 1) return null;
    const saga = matches[0];
    if (saga.phase !== 'completed') return null;
    const binding = {
      fingerprint: journalOperation.fingerprint,
      fingerprintVersion: journalOperation.fingerprintVersion,
      method: journalOperation.method || null,
      route: journalOperation.route || null,
    };
    if (!journalBindingsMatch(saga, binding, saga.kind)) return null;
    const result = buildResult(saga);
    if (!result?.ok || result.status !== 'completed' || result.needsSync) return null;
    return result;
  }

  function assertAvailable({ accountId, ids, exceptSagaId, allowDeletionDelegation } = {}) {
    const candidates = candidateIds({ ids });
    if (allowDeletionDelegation) {
      const delegating = loadState().sagas[allowDeletionDelegation.sagaId];
      if (isValidDeletionDelegation(delegating, allowDeletionDelegation)) {
        candidates.delete(String(allowDeletionDelegation.txnId));
      }
    }
    if (!candidates.size) return;

    for (const saga of Object.values(loadState().sagas)) {
      if (saga.id === exceptSagaId || isTerminalSaga(saga)) continue;
      const owned = sagaOwnedIds(saga);
      if ([...candidates].some((id) => owned.has(id))) {
        throw new BulkOperationInProgressError();
      }
    }
  }

  function assertDeletionDelegationAuthorized(delegation) {
    const saga = loadState().sagas[delegation?.sagaId];
    if (!isValidDeletionDelegation(saga, delegation)) {
      throw new BulkOperationInProgressError();
    }
    return saga;
  }

  function assertPlanAdmission(saga, plan) {
    const ids = [...new Set((plan?.items || []).map((item) => item.txnId).filter(Boolean).map(String))];
    assertAvailable({ ids, exceptSagaId: saga.id });
    if (assertExternalAvailable) {
      for (const item of plan.items || []) {
        if (!item.txnId) continue;
        assertExternalAvailable({ accountId: item.accountId, ids: [item.txnId] });
      }
    }
  }

  async function invokeFault(faultInjector, point, saga, itemIndex = null) {
    if (!faultInjector) return;
    await faultInjector(point, {
      sagaId: saga?.id || null,
      phase: saga?.phase || null,
      itemIndex,
    });
  }

  async function checkpoint(saga, patch, name, faultInjector, itemIndex = null) {
    await invokeFault(faultInjector, `before:${name}`, saga, itemIndex);
    const next = {
      ...saga,
      ...patch,
      recordVersion: RECORD_VERSION,
      updatedAt: new Date().toISOString(),
    };
    if (isTerminalSaga(next)) next.terminalAt ||= next.updatedAt;
    writeSaga(next);
    Object.assign(saga, next);
    await invokeFault(faultInjector, `after:${name}`, saga, itemIndex);
  }

  async function rememberError(saga, error, stage, faultInjector, itemIndex = null) {
    const next = boundedError(error, stage);
    if (sameError(saga.lastError, next)) return;
    await checkpoint(saga, { lastError: next }, 'saga-error-checkpoint', faultInjector, itemIndex);
  }

  async function unresolved(saga, message, faultInjector) {
    const error = new BulkOperationOutcomeUnknownError(message);
    await rememberError(saga, error, saga.phase, faultInjector);
    await checkpoint(saga, {
      phase: 'unresolved',
      auditOutcome: summarizeAuditOutcome(saga),
    }, 'saga-unresolved-checkpoint', faultInjector);
    throw error;
  }

  function outcomeUnknown(message, cause) {
    const error = new BulkOperationOutcomeUnknownError(message);
    if (cause) error.cause = cause;
    return error;
  }

  async function loadAccountRows(api) {
    let accounts;
    try {
      accounts = await api.getAccounts();
    } catch (error) {
      throw outcomeUnknown('unable to enumerate Actual accounts during bulk recovery', error);
    }
    if (!Array.isArray(accounts)) {
      throw outcomeUnknown('Actual account enumeration was invalid during bulk recovery');
    }
    const rowsByAccount = {};
    for (const account of accounts) {
      let rows;
      try {
        rows = await api.getTransactions(account.id, ACCOUNT_RANGE_START, ACCOUNT_RANGE_END);
      } catch (error) {
        throw outcomeUnknown(
          `unable to query Actual account ${account.id} during bulk recovery`,
          error,
        );
      }
      if (!Array.isArray(rows)) {
        throw outcomeUnknown(`Actual transaction query for account ${account.id} was invalid`);
      }
      rowsByAccount[String(account.id)] = rows;
    }
    return rowsByAccount;
  }

  function isValidDeletionDelegation(saga, delegation) {
    if (!saga?.activeDelegation || !delegation) return false;
    if (saga.phase !== 'items_pending') return false;
    const txnId = String(delegation.txnId || '');
    if (recordedDeletionSagaId(saga, txnId)) return false;
    if (activeDeletionSagaForTxn(txnId)) return false;
    const active = saga.activeDelegation;
    const item = (saga.plan?.items || []).find(
      (entry) => entry.globalIndex === delegation.itemIndex && entry.itemType === 'phantom_delete',
    );
    if (!item) return false;
    return saga.id === delegation.sagaId
      && active.itemIndex === delegation.itemIndex
      && active.token === delegation.token
      && String(active.txnId) === txnId
      && String(active.accountId) === String(delegation.accountId)
      && String(item.txnId) === txnId
      && String(item.accountId) === String(delegation.accountId)
      && String(saga.cursor?.itemIndex) === String(delegation.itemIndex);
  }

  function sagaRequiresActualSync(saga) {
    for (const item of saga.plan?.items || []) {
      const outcome = saga.itemOutcomes?.[String(item.globalIndex)];
      if (outcome?.status !== 'completed') continue;
      if (item.itemType === 'category_update' || item.itemType === 'phantom_delete') return true;
    }
    return false;
  }

  async function verifyPlannedAccountOpen(api, saga, item, faultInjector, context) {
    if (item.accountOpenAtPlan !== true || !item.accountId) return;
    let accounts;
    try {
      accounts = await api.getAccounts();
    } catch (error) {
      throw outcomeUnknown(`unable to enumerate Actual accounts during bulk ${context}`, error);
    }
    const account = (accounts || []).find(
      (entry) => String(entry.id) === String(item.accountId),
    );
    if (!account) {
      await unresolved(
        saga,
        `checkpointed account ${item.accountId} is absent from Actual account enumeration`,
        faultInjector,
      );
    }
    if (account.closed) {
      await unresolved(
        saga,
        `checkpointed account ${item.accountId} closed after bulk plan checkpoint`,
        faultInjector,
      );
    }
  }

  function activeDeletionSagaForTxn(txnId) {
    const state = inspectDeletionState();
    const matches = Object.values(state.sagas || {}).filter((entry) => {
      if (entry?.phase === 'completed') return false;
      return String(entry?.target?.parentId) === String(txnId);
    });
    return matches.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] || null;
  }

  function recordedDeletionSagaId(saga, txnId) {
    const recorded = saga.delegatedDeletionSagaIds?.[txnId];
    return isRecordedDeletionSagaId(recorded) ? recorded : null;
  }

  async function verifyCategoryItem(api, saga, item, rowsByAccount, faultInjector) {
    await verifyPlannedAccountOpen(api, saga, item, faultInjector, 'category verify');
    const foreign = foreignAccountIds(rowsByAccount, item);
    if (foreign.length) {
      await unresolved(
        saga,
        `checkpointed transaction ${item.txnId} found outside recorded account ${item.accountId}: ${foreign.sort().join(',')}`,
        faultInjector,
      );
    }
    const located = locateItemTransactionEverywhere(rowsByAccount, item);
    if (!located) {
      await unresolved(
        saga,
        `checkpointed transaction ${item.txnId} is absent from Actual account enumeration`,
        faultInjector,
      );
    }
    if (String(located.accountId) !== String(item.accountId)) {
      await unresolved(
        saga,
        `checkpointed transaction ${item.txnId} moved outside recorded account ${item.accountId}`,
        faultInjector,
      );
    }
    const transaction = located.transaction;
    if (categoryIntentMatches(transaction, item.intent)) {
      return { alreadyApplied: true, transaction };
    }
    if (!categoryIdentityMatches(transaction, item.identityFingerprint)) {
      await unresolved(
        saga,
        `checkpointed transaction ${item.txnId} identity changed incompatibly`,
        faultInjector,
      );
    }
    if (transaction.category && String(transaction.category) !== String(item.intent.categoryId)) {
      await unresolved(
        saga,
        `checkpointed transaction ${item.txnId} category diverged from bulk intent`,
        faultInjector,
      );
    }
    return { alreadyApplied: false, transaction };
  }

  async function applyCategoryItem(api, item, faultInjector) {
    await invokeFault(faultInjector, `before:item-${item.globalIndex}-effect`, null, item.globalIndex);
    await api.updateTransaction(item.txnId, { category: item.intent.categoryId });
    await invokeFault(faultInjector, `after:item-${item.globalIndex}-effect`, null, item.globalIndex);
  }

  async function applyPhantomSeenItem(item, nowIso, faultInjector) {
    await invokeFault(faultInjector, `before:item-${item.globalIndex}-phantom-seen-write`, null, item.globalIndex);
    const store = readPhantomSeen();
    const prev = store.seen[item.txnId];
    store.seen[item.txnId] = {
      firstSeen: item.intent.firstSeen || (prev && prev.firstSeen) || nowIso,
      lastSeen: item.intent.lastSeen || nowIso,
      amount: item.intent.amount,
      date: item.intent.date,
      payee: item.intent.payee,
    };
    writePhantomSeen(store);
    await invokeFault(faultInjector, `after:item-${item.globalIndex}-phantom-seen-write`, null, item.globalIndex);
  }

  async function removePhantomSeenKey(txnId, faultInjector, itemIndex) {
    await invokeFault(faultInjector, `before:item-${itemIndex}-phantom-seen-removal`, null, itemIndex);
    const store = readPhantomSeen();
    if (store.seen[txnId]) {
      delete store.seen[txnId];
      writePhantomSeen(store);
    }
    await invokeFault(faultInjector, `after:item-${itemIndex}-phantom-seen-removal`, null, itemIndex);
  }

  async function applyPhantomPruneItem(item, faultInjector) {
    await invokeFault(faultInjector, `before:item-${item.globalIndex}-phantom-prune-write`, null, item.globalIndex);
    const store = readPhantomSeen();
    if (store.seen[item.txnId]) {
      delete store.seen[item.txnId];
      writePhantomSeen(store);
    }
    await invokeFault(faultInjector, `after:item-${item.globalIndex}-phantom-prune-write`, null, item.globalIndex);
  }

  async function appendVerifiedPhantomLogEntry(saga, item, faultInjector) {
    await invokeFault(faultInjector, `before:item-${item.globalIndex}-phantom-log-write`, saga, item.globalIndex);
    const log = readPhantomLog();
    const key = `${item.txnId}:${saga.id}`;
    const existing = new Set((log.deleted || []).map((entry) => `${entry.id}:${entry.bulkId || ''}`));
    if (!existing.has(key)) {
      log.deleted.push({
        id: item.txnId,
        account: item.intent.accountName,
        payee: item.intent.payee,
        amount: item.intent.amount,
        date: item.intent.date,
        reason: item.intent.reason,
        at: saga.plan.params?.nowIso || new Date().toISOString(),
        dryRun: false,
        bulkId: saga.id,
      });
      if (log.deleted.length > 500) log.deleted = log.deleted.slice(-500);
      writePhantomLog(log);
    }
    await invokeFault(faultInjector, `after:item-${item.globalIndex}-phantom-log-write`, saga, item.globalIndex);
  }

  async function applyRulesSidecarItem(item, faultInjector) {
    await invokeFault(faultInjector, `before:item-${item.globalIndex}-rules-sidecar-write`, null, item.globalIndex);
    const store = readRules();
    writeRules({ ...store, rules: item.intent.rules });
    await invokeFault(faultInjector, `after:item-${item.globalIndex}-rules-sidecar-write`, null, item.globalIndex);
  }

  async function buildPlan(api, saga) {
    if (saga.kind === 'rules_apply') {
      const { rules } = readRules();
      return planRulesApply(api, {
        rules,
        merchantCatalog,
        catalogTypeMatch,
        resolveCatalogCategory,
        buildCatInfo,
        settleUpPayee,
        reimbCat,
        incomeGroup,
        moneyMovementGroup,
        today: todayYMD(),
        addDays,
        months: saga.params?.months,
      });
    }
    if (saga.kind === 'rules_save') {
      const { rules } = readRules();
      return planRulesSave(api, {
        rule: saga.params.rule,
        existingRules: rules,
        today: todayYMD(),
        addDays,
      });
    }
    if (saga.kind === 'phantom_cleanup') {
      return planPhantomCleanup(api, {
        ...saga.params,
        today: todayYMD(),
        addDays,
        readPhantomSeen,
      });
    }
    throw new Error(`unsupported bulk operation kind: ${saga.kind}`);
  }

  async function resolveDeletionDelegation(api, saga, item, rowsByAccount, faultInjector) {
    const txnId = String(item.txnId);
    let deletionSagaId = recordedDeletionSagaId(saga, txnId);
    let deletionSaga = deletionSagaId ? inspectDeletionState().sagas?.[deletionSagaId] : null;
    if (!deletionSaga) {
      deletionSaga = activeDeletionSagaForTxn(txnId);
      if (deletionSaga) {
        deletionSagaId = deletionSaga.id;
        saga.delegatedDeletionSagaIds = { ...(saga.delegatedDeletionSagaIds || {}), [txnId]: deletionSagaId };
        saga.activeDelegation = null;
        await checkpoint(
          saga,
          {
            delegatedDeletionSagaIds: saga.delegatedDeletionSagaIds,
            activeDelegation: null,
          },
          `item-${item.globalIndex}-delegation-recorded-checkpoint`,
          faultInjector,
          item.globalIndex,
        );
      }
    }
    if (!deletionSaga) {
      const located = locateItemTransactionEverywhere(rowsByAccount, item);
      if (!located) {
        await unresolved(
          saga,
          `phantom delete target ${txnId} is absent without a recorded deletion delegation`,
          faultInjector,
        );
      }
      if (!categoryIdentityMatches(located.transaction, item.identityFingerprint)) {
        await unresolved(saga, `phantom delete target ${txnId} identity changed incompatibly`, faultInjector);
      }
      const token = crypto.randomUUID();
      saga.activeDelegation = {
        itemIndex: item.globalIndex,
        txnId,
        token,
        accountId: String(item.accountId),
      };
      await checkpoint(
        saga,
        { activeDelegation: saga.activeDelegation, cursor: { itemIndex: item.globalIndex } },
        `item-${item.globalIndex}-delegation-handoff-checkpoint`,
        faultInjector,
        item.globalIndex,
      );
      const bulkDelegation = {
        sagaId: saga.id,
        itemIndex: item.globalIndex,
        token,
        txnId,
        accountId: String(item.accountId),
      };
      await deleteTransaction({
        id: item.txnId,
        accountId: item.accountId,
        date: item.date,
        allowImported: true,
        bulkDelegation,
        faultInjector,
      });
      deletionSaga = activeDeletionSagaForTxn(txnId);
      if (!deletionSaga) {
        throw outcomeUnknown(`phantom delete delegation missing for ${txnId}`);
      }
      saga.delegatedDeletionSagaIds = { ...(saga.delegatedDeletionSagaIds || {}), [txnId]: deletionSaga.id };
      saga.activeDelegation = null;
      await checkpoint(
        saga,
        {
          delegatedDeletionSagaIds: saga.delegatedDeletionSagaIds,
          activeDelegation: null,
        },
        `item-${item.globalIndex}-delegation-recorded-checkpoint`,
        faultInjector,
        item.globalIndex,
      );
      deletionSagaId = deletionSaga.id;
    }
    if (deletionSaga.phase !== 'completed') {
      await recoverDeletionSagas(api, { deferSync: true, faultInjector });
      deletionSaga = inspectDeletionState().sagas?.[deletionSagaId] || activeDeletionSagaForTxn(txnId);
    }
    if (!deletionSaga || !['completed', 'sync_pending'].includes(deletionSaga.phase)) {
      throw outcomeUnknown(`delegated deletion for ${txnId} remains nonterminal`);
    }
    return deletionSaga;
  }

  async function driveItem(api, saga, item, rowsByAccount, faultInjector) {
    const index = item.globalIndex;
    const outcome = saga.itemOutcomes?.[String(index)];
    if (outcome?.status === 'completed' || outcome?.status === 'failed') return;

    if (item.itemType === 'category_update') {
      await checkpoint(
        saga,
        { cursor: { itemIndex: index }, phase: 'items_pending' },
        `item-${index}-pending-checkpoint`,
        faultInjector,
        index,
      );
      if (assertExternalAvailable) {
        assertExternalAvailable({ accountId: item.accountId, ids: [item.txnId], exceptSagaId: saga.id });
      }
      const verification = await verifyCategoryItem(api, saga, item, rowsByAccount, faultInjector);
      if (!verification.alreadyApplied) {
        try {
          await applyCategoryItem(api, item, faultInjector);
        } catch (error) {
          await rememberError(saga, error, item.stageId, faultInjector, index);
          throw error;
        }
        await invokeFault(faultInjector, `before:item-${index}-verify-checkpoint`, saga, index);
        const rowsAfter = await loadAccountRows(api);
        const post = await verifyCategoryItem(api, saga, item, rowsAfter, faultInjector);
        if (!post.alreadyApplied) {
          throw outcomeUnknown(`category update for ${item.txnId} did not converge`);
        }
        await invokeFault(faultInjector, `after:item-${index}-verify-checkpoint`, saga, index);
      }
      saga.itemOutcomes = { ...saga.itemOutcomes, [String(index)]: { status: 'completed' } };
      saga.completedIndexes = [...new Set([...(saga.completedIndexes || []), index])].sort((a, b) => a - b);
      await checkpoint(
        saga,
        {
          itemOutcomes: saga.itemOutcomes,
          completedIndexes: saga.completedIndexes,
          auditOutcome: summarizeAuditOutcome(saga),
          lastError: null,
        },
        `item-${index}-applied-checkpoint`,
        faultInjector,
        index,
      );
      return;
    }

    if (item.itemType === 'phantom_seen') {
      await checkpoint(
        saga,
        { cursor: { itemIndex: index }, phase: 'items_pending' },
        `item-${index}-pending-checkpoint`,
        faultInjector,
        index,
      );
      await applyPhantomSeenItem(item, saga.plan.params?.nowIso, faultInjector);
      saga.itemOutcomes = { ...saga.itemOutcomes, [String(index)]: { status: 'completed' } };
      saga.completedIndexes = [...new Set([...(saga.completedIndexes || []), index])].sort((a, b) => a - b);
      await checkpoint(
        saga,
        { itemOutcomes: saga.itemOutcomes, completedIndexes: saga.completedIndexes },
        `item-${index}-applied-checkpoint`,
        faultInjector,
        index,
      );
      return;
    }

    if (item.itemType === 'phantom_delete') {
      await checkpoint(
        saga,
        { cursor: { itemIndex: index }, phase: 'items_pending' },
        `item-${index}-pending-checkpoint`,
        faultInjector,
        index,
      );
      await verifyPlannedAccountOpen(api, saga, item, faultInjector, 'phantom delete verify');
      await resolveDeletionDelegation(api, saga, item, rowsByAccount, faultInjector);
      const rowsAfter = await loadAccountRows(api);
      await invokeFault(faultInjector, `before:item-${index}-post-delete-verification`, saga, index);
      if (locateItemTransactionEverywhere(rowsAfter, item)) {
        await unresolved(saga, `phantom delete target ${item.txnId} still present after deletion saga`, faultInjector);
      }
      await invokeFault(faultInjector, `after:item-${index}-post-delete-verification`, saga, index);
      saga.itemOutcomes = { ...saga.itemOutcomes, [String(index)]: { status: 'completed' } };
      saga.completedIndexes = [...new Set([...(saga.completedIndexes || []), index])].sort((a, b) => a - b);
      await checkpoint(
        saga,
        { itemOutcomes: saga.itemOutcomes, completedIndexes: saga.completedIndexes },
        `item-${index}-applied-checkpoint`,
        faultInjector,
        index,
      );
      return;
    }

    if (item.itemType === 'phantom_prune') {
      await checkpoint(
        saga,
        { cursor: { itemIndex: index }, phase: 'items_pending' },
        `item-${index}-pending-checkpoint`,
        faultInjector,
        index,
      );
      const rowsFresh = await loadAccountRows(api);
      if (locateItemTransactionEverywhere(rowsFresh, item)) {
        await unresolved(saga, `phantom prune key ${item.txnId} still maps to a live transaction`, faultInjector);
      }
      await applyPhantomPruneItem(item, faultInjector);
      saga.itemOutcomes = { ...saga.itemOutcomes, [String(index)]: { status: 'completed' } };
      saga.completedIndexes = [...new Set([...(saga.completedIndexes || []), index])].sort((a, b) => a - b);
      await checkpoint(
        saga,
        { itemOutcomes: saga.itemOutcomes, completedIndexes: saga.completedIndexes },
        `item-${index}-applied-checkpoint`,
        faultInjector,
        index,
      );
      return;
    }

    if (item.itemType === 'rules_sidecar') {
      await checkpoint(
        saga,
        { cursor: { itemIndex: index }, phase: 'sidecars_pending' },
        `item-${index}-pending-checkpoint`,
        faultInjector,
        index,
      );
      const store = readRules();
      const intendedFingerprint = item.intent.rulesFingerprint
        || canonicalRulesFingerprint(item.intent.rules);
      const currentFingerprint = canonicalRulesFingerprint(store.rules || []);
      if (currentFingerprint === intendedFingerprint) {
        // sidecar already matches the checkpointed canonical intent
      } else if ((store.rules || []).some((entry) => entry.id === item.intent.ruleId)) {
        await unresolved(
          saga,
          `rules sidecar diverged for rule ${item.intent.ruleId}`,
          faultInjector,
        );
      } else {
        await applyRulesSidecarItem(item, faultInjector);
      }
      saga.itemOutcomes = { ...saga.itemOutcomes, [String(index)]: { status: 'completed' } };
      saga.completedIndexes = [...new Set([...(saga.completedIndexes || []), index])].sort((a, b) => a - b);
      await checkpoint(
        saga,
        { itemOutcomes: saga.itemOutcomes, completedIndexes: saga.completedIndexes },
        `item-${index}-applied-checkpoint`,
        faultInjector,
        index,
      );
    }
  }

  async function convergePhantomSidecars(saga, faultInjector) {
    for (const item of saga.plan.items) {
      if (item.itemType !== 'phantom_delete') continue;
      const outcome = saga.itemOutcomes?.[String(item.globalIndex)];
      if (outcome?.status !== 'completed') continue;
      await removePhantomSeenKey(item.txnId, faultInjector, item.globalIndex);
      await appendVerifiedPhantomLogEntry(saga, item, faultInjector);
    }
  }

  async function drive(api, saga, { faultInjector } = {}) {
    if (saga.phase === 'prepared') {
      const plan = await buildPlan(api, saga);
      await checkpoint(saga, { plan, phase: 'plan_checkpoint' }, 'plan-checkpoint', faultInjector);
      return drive(api, saga, { faultInjector });
    }

    if (saga.phase === 'plan_checkpoint') {
      assertPlanAdmission(saga, saga.plan);
      await checkpoint(saga, { phase: 'items_pending', cursor: { itemIndex: 0 } }, 'items-start-checkpoint', faultInjector);
      return drive(api, saga, { faultInjector });
    }

    if (saga.phase === 'items_pending') {
      let rowsByAccount = await loadAccountRows(api);
      const startIndex = saga.cursor?.itemIndex || 0;
      for (const item of saga.plan.items) {
        if (item.globalIndex < startIndex) continue;
        if (item.itemType === 'rules_sidecar') continue;
        await driveItem(api, saga, item, rowsByAccount, faultInjector);
        rowsByAccount = await loadAccountRows(api);
      }
      await checkpoint(saga, { phase: 'sidecars_pending' }, 'sidecars-pending-checkpoint', faultInjector);
      return drive(api, saga, { faultInjector });
    }

    if (saga.phase === 'sidecars_pending') {
      let rowsByAccount = await loadAccountRows(api);
      for (const item of saga.plan.items) {
        if (item.itemType === 'rules_sidecar') {
          await driveItem(api, saga, item, rowsByAccount, faultInjector);
        }
      }
      if (saga.kind === 'phantom_cleanup') {
        await convergePhantomSidecars(saga, faultInjector);
      }
      await checkpoint(saga, { phase: 'sync_pending' }, 'sync-pending-checkpoint', faultInjector);
      return { needsSync: true };
    }

    if (saga.phase === 'sync_pending') {
      return { needsSync: true };
    }

    if (saga.phase === 'completed' || saga.phase === 'unresolved') {
      return buildResult(saga);
    }

    throw new Error(`unsupported bulk operation saga phase: ${saga.phase}`);
  }

  function verifiedPhantomDeletes(saga) {
    return (saga.plan?.items || [])
      .filter((item) => item.itemType === 'phantom_delete'
        && saga.itemOutcomes?.[String(item.globalIndex)]?.status === 'completed')
      .map((item) => ({
        id: item.txnId,
        account: item.intent.accountName,
        payee: item.intent.payee,
        amount: item.intent.amount,
        date: item.intent.date,
        reason: item.intent.reason,
        at: saga.plan.params?.nowIso,
        dryRun: false,
      }));
  }

  function buildResult(saga) {
    const auditOutcome = summarizeAuditOutcome(saga);
    saga.auditOutcome = auditOutcome;
    const ok = saga.phase === 'completed' && auditOutcome.failed === 0;
    const needsSync = saga.phase === 'sync_pending';
    const base = { ok, status: auditOutcome.status, needsSync, auditOutcome };
    if (saga.kind === 'rules_apply') {
      return {
        ...base,
        applied: auditOutcome.applied,
        failed: auditOutcome.failed,
        skipped: auditOutcome.skipped,
        settleUpsMoved: saga.plan.items.filter((item) => item.stageId === 'settle-ups'
          && saga.itemOutcomes?.[String(item.globalIndex)]?.status === 'completed').length,
        failures: auditOutcome.failedItems,
      };
    }
    if (saga.kind === 'rules_save') {
      const categoryApplied = saga.plan.items.filter(
        (item) => item.itemType === 'category_update'
          && saga.itemOutcomes?.[String(item.globalIndex)]?.status === 'completed',
      ).length;
      return {
        ...base,
        id: saga.params?.rule?.id,
        applied: categoryApplied,
        failed: auditOutcome.failed,
        skipped: auditOutcome.skipped,
        failures: auditOutcome.failedItems,
      };
    }
    if (saga.kind === 'phantom_cleanup') {
      const deleted = verifiedPhantomDeletes(saga);
      return {
        ...base,
        dryRun: false,
        deletedCount: deleted.length,
        deleted,
        flaggedAged: saga.plan?.flaggedAged || [],
        watching: Object.keys(readPhantomSeen().seen || {}).length,
      };
    }
    return base;
  }

  async function terminalizeOnly(api, sagas, faultInjector) {
    let firstError = null;
    for (const saga of sagas) {
      if (saga.phase !== 'sync_pending') continue;
      try {
        const syncedAt = new Date().toISOString();
        await checkpoint(saga, {
          phase: 'completed',
          syncedAt,
          auditOutcome: summarizeAuditOutcome({ ...saga, phase: 'completed' }),
          lastError: null,
        }, 'saga-terminal-write', faultInjector);
      } catch (error) {
        if (!isTerminalSaga(saga)) {
          try { await rememberError(saga, error, saga.phase, faultInjector); } catch (_) {}
        }
        firstError ||= error;
      }
    }
    if (firstError) throw firstError;
  }

  async function finishSync(api, sagas, faultInjector, { skipSync = false } = {}) {
    const pending = sagas.filter((saga) => saga.phase === 'sync_pending');
    if (!pending.length) return;
    if (!skipSync && pending.some(sagaRequiresActualSync)) {
      await invokeFault(faultInjector, 'before:sync', pending[0]);
      await api.sync();
      await invokeFault(faultInjector, 'after:sync', pending[0]);
    }
    await terminalizeOnly(api, pending, faultInjector);
  }

  async function run(api, {
    kind,
    operationKey = null,
    journalBinding = null,
    params = {},
    faultInjector,
    deferSync = false,
  }) {
    const paramsFingerprint = crypto.createHash('sha256')
      .update(JSON.stringify({ kind, params }))
      .digest('hex');
    const id = bulkOperationId(operationKey, kind, paramsFingerprint);
    const existing = findByOperationKey(operationKey) || loadState().sagas[id];
    if (existing) {
      assertJournalBinding(existing, journalBinding, kind);
      if (isTerminalSaga(existing)) return buildResult(existing);
      try {
        const result = await drive(api, existing, { faultInjector });
        if (result?.needsSync && !deferSync) {
          await finishSync(api, [existing], faultInjector);
        }
        return buildResult(existing);
      } catch (error) {
        try { await rememberError(existing, error, existing.phase, faultInjector); } catch (_) {}
        throw error;
      }
    }

    const now = new Date().toISOString();
    const normalizedBinding = normalizeJournalBinding(journalBinding);
    const saga = {
      id,
      recordVersion: RECORD_VERSION,
      kind,
      operationKey,
      params,
      paramsFingerprint,
      operationJournalFingerprint: normalizedBinding?.fingerprint ?? null,
      operationJournalFingerprintVersion: normalizedBinding?.fingerprintVersion ?? null,
      operationJournalMethod: normalizedBinding?.method ?? null,
      operationJournalRoute: normalizedBinding?.route ?? null,
      phase: 'prepared',
      cursor: { itemIndex: 0 },
      completedIndexes: [],
      itemOutcomes: {},
      delegatedDeletionSagaIds: {},
      activeDelegation: null,
      auditOutcome: { status: 'started', applied: 0, failed: 0, skipped: 0, failedItems: [] },
      createdAt: now,
      updatedAt: now,
    };
    await invokeFault(faultInjector, 'before:initial-saga-write', saga);
    writeSaga(saga);
    await invokeFault(faultInjector, 'after:initial-saga-write', saga);

    try {
      const result = await drive(api, saga, { faultInjector });
      if (result?.needsSync && !deferSync) {
        await finishSync(api, [saga], faultInjector);
      }
      return buildResult(saga);
    } catch (error) {
      try { await rememberError(saga, error, saga.phase, faultInjector); } catch (_) {}
      throw error;
    }
  }

  async function recover(api, { faultInjector, deferSync = false } = {}) {
    const active = Object.values(loadState().sagas).filter((saga) => !isTerminalSaga(saga));
    const syncPending = [];
    const errors = [];
    for (const saga of active) {
      try {
        const result = await drive(api, saga, { faultInjector });
        if (result?.needsSync) syncPending.push(saga);
      } catch (error) {
        try { await rememberError(saga, error, saga.phase, faultInjector); } catch (_) {}
        errors.push({ sagaId: saga.id, error });
      }
    }
    if (deferSync) return { needsSync: syncPending.length > 0, errors };
    let syncError = null;
    try {
      await finishSync(api, syncPending, faultInjector);
    } catch (error) {
      syncError = error;
    }
    if (syncError) throw syncError;
    if (errors.length) throw errors[0].error;
    return { needsSync: syncPending.length > 0, errors };
  }

  async function markSynced(api, { faultInjector } = {}) {
    const syncPending = Object.values(loadState().sagas).filter((saga) => saga.phase === 'sync_pending');
    await finishSync(api, syncPending, faultInjector, { skipSync: true });
  }

  function resultForOperationKey(operationKey) {
    if (!operationKey) return null;
    let state;
    try {
      state = loadState();
    } catch (_) {
      return null;
    }
    const matches = sagasForOperationKey(state, operationKey);
    if (matches.length !== 1) return null;
    return buildResult(matches[0]);
  }

  function inspectState() {
    return loadState();
  }

  return {
    assertAvailable,
    assertDeletionDelegationAuthorized,
    assertJournalAdmission,
    inspectState,
    markSynced,
    proveTerminalJournalCompletion,
    recover,
    resultForOperationKey,
    run,
  };
}

module.exports = {
  BulkOperationInProgressError,
  BulkOperationOutcomeUnknownError,
  BulkOperationStateError,
  bulkOperationId,
  createBulkOperationSaga,
  idempotencyKeyReuseError,
  isTerminalSaga,
  isRecordedDeletionSagaId,
  journalBindingsMatch,
  sagasForOperationKey,
};
