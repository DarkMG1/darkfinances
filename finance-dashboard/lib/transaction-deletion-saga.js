'use strict';

const crypto = require('crypto');
const { KnownPreApplyError } = require('./errors');
const { readJsonFile, writeJsonFile } = require('./json-store');
const { normalizeDeletionTargetEvidence } = require('./transaction-deletion-references');

function runtimeStateStore() {
  return require('./runtime-state-store');
}

const RECORD_VERSION = 1;
const TERMINAL_LIMIT = 100;
const TERMINAL_PHASES = new Set(['completed']);
const ACCOUNT_RANGE_START = '1900-01-01';
const ACCOUNT_RANGE_END = '9999-12-31';

class DeletionSagaOutcomeUnknownError extends Error {
  constructor(message = 'transaction deletion outcome is unresolved') {
    super(message);
    this.name = 'DeletionSagaOutcomeUnknownError';
    this.code = 'TRANSACTION_DELETION_OUTCOME_UNKNOWN';
  }
}

class TransactionDeletionInProgressError extends KnownPreApplyError {
  constructor() {
    super('A deletion for this transaction is already in progress', {
      code: 'TRANSACTION_DELETION_IN_PROGRESS',
      status: 409,
    });
    this.name = 'TransactionDeletionInProgressError';
  }
}

function normalized(value) {
  return value == null || value === '' ? null : value;
}

function canonicalLeg(leg) {
  return {
    id: String(leg?.id || ''),
    parent_id: normalized(leg?.parent_id),
    date: String(leg?.date || ''),
    amount: leg?.amount,
    category: normalized(leg?.category),
    notes: normalized(leg?.notes),
    payee: normalized(leg?.payee),
    transfer_id: normalized(leg?.transfer_id),
    imported_id: normalized(leg?.imported_id),
  };
}

function canonicalTransactionSnapshot(transaction) {
  return {
    id: String(transaction?.id || ''),
    parent_id: normalized(transaction?.parent_id),
    date: String(transaction?.date || ''),
    amount: transaction?.amount,
    category: normalized(transaction?.category),
    notes: normalized(transaction?.notes),
    payee: normalized(transaction?.payee),
    cleared: transaction?.cleared == null ? true : Boolean(transaction.cleared),
    imported_id: normalized(transaction?.imported_id),
    imported_payee: normalized(transaction?.imported_payee),
    transfer_id: normalized(transaction?.transfer_id),
    is_parent: Boolean(transaction?.is_parent),
    subtransactions: (transaction?.subtransactions || []).map(canonicalLeg),
  };
}

function transactionDeletionFingerprint(transaction) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalTransactionSnapshot(transaction)))
    .digest('hex');
}

function deletionTarget(transaction) {
  const snapshot = canonicalTransactionSnapshot(transaction);
  if (!snapshot.id) throw new Error('transaction deletion parent id required');
  if (!snapshot.date) throw new Error('transaction deletion date required');
  if (!Number.isSafeInteger(snapshot.amount)) {
    throw new Error('transaction deletion parent amount must be integer cents');
  }
  const legIds = snapshot.subtransactions.map((leg) => {
    if (!leg.id) throw new Error('transaction deletion leg id required');
    if (!Number.isSafeInteger(leg.amount)) {
      throw new Error('transaction deletion leg amount must be integer cents');
    }
    return leg.id;
  });
  if (new Set([snapshot.id, ...legIds]).size !== legIds.length + 1) {
    throw new Error('transaction deletion ids must be unique');
  }
  return {
    parentId: snapshot.id,
    legIds,
    ids: [snapshot.id, ...legIds],
    snapshot,
    fingerprint: transactionDeletionFingerprint(transaction),
  };
}

function targetMatches(transaction, target) {
  if (!transaction || String(transaction.id) !== String(target.parentId)) return false;
  return transactionDeletionFingerprint(transaction) === target.fingerprint;
}

function rowById(rows, id) {
  return rows.find((row) => String(row?.id) === String(id)) || null;
}

function presentTargetIds(rows, targetIds) {
  const targets = new Set(targetIds.map(String));
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

function accountMatches(saga, accountId) {
  return saga?.accountId == null || String(saga.accountId) === String(accountId);
}

function sagaOwnedIds(saga) {
  return new Set([
    ...(saga?.target?.ids || []),
    saga?.target?.parentId,
    ...(saga?.target?.legIds || []),
  ].filter((id) => id != null).map(String));
}

function candidateIds({ ids = [], transaction } = {}) {
  const result = new Set((ids || []).filter((id) => id != null).map(String));
  if (transaction) {
    const target = deletionTarget(transaction);
    for (const id of target.ids) result.add(id);
  }
  return result;
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

function resolveReferenceTargetEvidence(planOrEvidence) {
  if (planOrEvidence?.snapshot || planOrEvidence?.transactions) return planOrEvidence;
  if (planOrEvidence?.targetEvidence) return planOrEvidence.targetEvidence;
  if (Array.isArray(planOrEvidence)) {
    return { transactions: planOrEvidence.map((id) => ({ id: String(id) })) };
  }
  if (planOrEvidence?.targetIds?.length) {
    return { transactions: planOrEvidence.targetIds.map((id) => ({ id: String(id) })) };
  }
  throw new Error('transaction deletion target evidence required');
}

function createTransactionDeletionSaga({
  sagaPath,
  planReferences,
  applyReferenceStep,
  referencesConverged,
  referenceSteps,
  receiptFileState,
  unlinkReceiptFile,
  assertExternalAvailable,
  terminalLimit = TERMINAL_LIMIT,
}) {
  if (!sagaPath) throw new Error('transaction deletion saga path required');
  if (!Array.isArray(referenceSteps) || !referenceSteps.length) {
    throw new Error('transaction deletion reference steps required');
  }

  function loadState() {
    const state = runtimeStateStore().readRuntimeState('transactionDeletionSagas', { file: sagaPath }).value;
    if (!state
      || state.schemaVersion !== 1
      || !state.sagas
      || typeof state.sagas !== 'object'
      || Array.isArray(state.sagas)) {
      throw new Error('invalid transaction deletion saga state');
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
    runtimeStateStore().writeRuntimeState('transactionDeletionSagas', pruneState(state), { file: sagaPath });
  }

  function writeSaga(saga) {
    const state = loadState();
    state.sagas[saga.id] = saga;
    writeState(state);
  }

  function assertAvailable({ accountId, ids, transaction } = {}) {
    const candidates = candidateIds({ ids, transaction });
    if (!candidates.size) return;
    const conflict = Object.values(loadState().sagas).some((saga) => {
      if (isTerminalSaga(saga) || (accountId && !accountMatches(saga, accountId))) return false;
      const owned = sagaOwnedIds(saga);
      return [...candidates].some((id) => owned.has(id));
    });
    if (conflict) throw new TransactionDeletionInProgressError();
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
    next.status = isTerminalSaga(next) ? 'completed' : 'started';
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

  async function unresolved(saga, message, faultInjector) {
    const error = new DeletionSagaOutcomeUnknownError(message);
    await rememberError(saga, error, saga.phase, faultInjector);
    throw error;
  }

  function outcomeUnknown(message, cause) {
    const error = new DeletionSagaOutcomeUnknownError(message);
    if (cause) error.cause = cause;
    return error;
  }

  async function exactRows(api, saga, boundaryName, faultInjector) {
    return boundary(
      faultInjector,
      boundaryName,
      saga,
      async () => {
        let accounts;
        try {
          accounts = await api.getAccounts();
        } catch (error) {
          throw outcomeUnknown('unable to enumerate Actual accounts during deletion recovery', error);
        }
        if (!Array.isArray(accounts)) {
          throw outcomeUnknown('Actual account enumeration was invalid during deletion recovery');
        }
        const accountIds = accounts.map((account) => String(account?.id || '')).sort();
        if (accountIds.some((id) => !id) || new Set(accountIds).size !== accountIds.length) {
          throw outcomeUnknown('Actual account enumeration was invalid during deletion recovery');
        }
        if (!accountIds.includes(String(saga.accountId))) {
          throw outcomeUnknown('deletion admission account is absent from Actual account enumeration');
        }

        const targetIds = [...sagaOwnedIds(saga)];
        let intendedRows = null;
        const foreignIds = new Set();
        for (const accountId of accountIds) {
          let rows;
          try {
            rows = await api.getTransactions(
              accountId,
              ACCOUNT_RANGE_START,
              ACCOUNT_RANGE_END,
            );
          } catch (error) {
            throw outcomeUnknown(
              `unable to query Actual account ${accountId} during deletion recovery`,
              error,
            );
          }
          if (!Array.isArray(rows)) {
            throw outcomeUnknown(
              `Actual transaction query for account ${accountId} was invalid during deletion recovery`,
            );
          }
          if (accountId === String(saga.accountId)) {
            intendedRows = rows;
          } else {
            for (const id of presentTargetIds(rows, targetIds)) foreignIds.add(id);
          }
        }
        if (foreignIds.size) {
          throw outcomeUnknown(
            `checkpointed transaction ids found outside deletion account: ${[...foreignIds].sort().join(',')}`,
          );
        }
        return intendedRows;
      },
    );
  }

  async function assertTargetAbsent(api, saga, boundaryName, faultInjector) {
    const rows = await exactRows(api, saga, boundaryName, faultInjector);
    const present = presentTargetIds(rows, saga.target.ids);
    if (present.size) {
      await unresolved(
        saga,
        `checkpointed transaction ids remain present: ${[...present].sort().join(',')}`,
        faultInjector,
      );
    }
    return rows;
  }

  function referencePlan(targetEvidence, previous = null) {
    const evidence = resolveReferenceTargetEvidence(targetEvidence);
    const planned = planReferences(evidence);
    const receiptFiles = [...new Set([
      ...(previous?.receiptFiles || []),
      ...(planned.receiptFilesToDelete || []),
    ])].sort();
    const expanded = normalizeDeletionTargetEvidence(evidence);
    return {
      version: 2,
      targetEvidence: evidence,
      targetIds: expanded.targets.map(String),
      steps: [...referenceSteps],
      completedSteps: [...(previous?.completedSteps || [])],
      stats: planned.stats,
      receiptFiles,
    };
  }

  async function applyReferences(api, saga, faultInjector) {
    const plan = saga.referencePlan;
    if (!plan || !Array.isArray(plan.completedSteps)) {
      throw new Error('transaction deletion reference plan is missing');
    }
    for (const step of referenceSteps) {
      if (plan.completedSteps.includes(step)) continue;
      await assertTargetAbsent(
        api,
        saga,
        `pre-reference-${step}-verification`,
        faultInjector,
      );
      await checkpoint(
        saga,
        { referenceStep: step },
        `reference-${step}-pending-checkpoint`,
        faultInjector,
      );
      await boundary(faultInjector, `reference-${step}-write`, saga, async () => {
        applyReferenceStep(step, resolveReferenceTargetEvidence(plan), plan);
      });
      const completedSteps = [...plan.completedSteps, step];
      plan.completedSteps = completedSteps;
      await checkpoint(saga, {
        referencePlan: plan,
        referenceStep: null,
      }, `reference-${step}-checkpoint`, faultInjector);
    }
    if (!referencesConverged(resolveReferenceTargetEvidence(plan), plan)) {
      throw new Error('transaction deletion references did not converge');
    }
    await checkpoint(
      saga,
      { phase: 'references_deleted', referenceStep: null, lastError: null },
      'references-deleted-checkpoint',
      faultInjector,
    );
  }

  async function receiptCleanupConverged(saga) {
    for (const file of saga.referencePlan?.receiptFiles || []) {
      const state = receiptFileState(file);
      if (state.exists && !state.referenced) return false;
    }
    return true;
  }

  async function cleanupReceiptFiles(saga, faultInjector) {
    const cleanup = saga.receiptCleanup || {
      files: [...(saga.referencePlan?.receiptFiles || [])],
      completed: [],
      preserved: [],
      pendingFile: null,
    };
    for (let index = 0; index < cleanup.files.length; index += 1) {
      const file = cleanup.files[index];
      if (cleanup.completed.includes(file)) continue;
      await checkpoint(saga, {
        receiptCleanup: { ...cleanup, pendingFile: file },
      }, `receipt-${index}-pending-checkpoint`, faultInjector);
      const state = receiptFileState(file);
      if (state.exists && !state.referenced) {
        await boundary(
          faultInjector,
          `receipt-${index}-unlink`,
          saga,
          () => unlinkReceiptFile(file),
        );
      }
      const after = receiptFileState(file);
      if (after.exists && !after.referenced) {
        throw new Error(`receipt cleanup did not remove ${file}`);
      }
      if (after.referenced && !cleanup.preserved.includes(file)) cleanup.preserved.push(file);
      cleanup.completed.push(file);
      cleanup.pendingFile = null;
      await checkpoint(saga, {
        receiptCleanup: cleanup,
      }, `receipt-${index}-checkpoint`, faultInjector);
    }

    if (!await receiptCleanupConverged(saga)) {
      throw new Error('transaction deletion receipt cleanup did not converge');
    }
    const completedAt = new Date().toISOString();
    await checkpoint(saga, {
      phase: 'completed',
      receiptCleanup: cleanup,
      lastError: null,
      auditOutcome: {
        outcome: 'deleted',
        parentId: saga.target.parentId,
        legIds: [...saga.target.legIds],
        references: saga.referencePlan.stats,
        receiptFiles: [...cleanup.files],
        preservedSharedReceiptFiles: [...cleanup.preserved],
        syncedAt: saga.syncedAt,
        completedAt,
      },
    }, 'saga-terminal-write', faultInjector);
    return {
      ok: true,
      deleted: saga.target.parentId,
      references: saga.referencePlan.stats,
    };
  }

  async function drive(api, saga, { faultInjector } = {}) {
    for (;;) {
      if (saga.phase === 'prepared') {
        await checkpoint(
          saga,
          { phase: 'delete_pending' },
          'delete-intent-checkpoint',
          faultInjector,
        );
        continue;
      }

      if (saga.phase === 'delete_pending') {
        let rows = await exactRows(api, saga, 'delete-revalidation', faultInjector);
        const parent = rowById(rows, saga.target.parentId);
        const present = presentTargetIds(rows, saga.target.ids);
        if (parent) {
          if (!targetMatches(parent, saga.target)) {
            await unresolved(saga, 'transaction financial shape changed after delete admission', faultInjector);
          }
          await boundary(
            faultInjector,
            'actual-deletion',
            saga,
            () => api.deleteTransaction(saga.target.parentId),
          );
        } else if (present.size) {
          await unresolved(saga, 'parent is absent while a checkpointed leg remains', faultInjector);
        }
        rows = await exactRows(api, saga, 'delete-verification', faultInjector);
        const remainingParent = rowById(rows, saga.target.parentId);
        if (remainingParent) {
          if (!targetMatches(remainingParent, saga.target)) {
            await unresolved(saga, 'transaction changed while deletion outcome was unknown', faultInjector);
          }
          throw new Error('Actual deletion could not be verified');
        }
        const remaining = presentTargetIds(rows, saga.target.ids);
        if (remaining.size) {
          await unresolved(saga, 'a checkpointed transaction leg remains after parent deletion', faultInjector);
        }
        await checkpoint(
          saga,
          { phase: 'actual_deleted', lastError: null },
          'actual-deleted-checkpoint',
          faultInjector,
        );
        continue;
      }

      if (saga.phase === 'actual_deleted') {
        await assertTargetAbsent(api, saga, 'post-delete-verification', faultInjector);
        const plan = referencePlan({ snapshot: saga.target.snapshot }, saga.referencePlan);
        await checkpoint(saga, {
          phase: 'references_pending',
          referencePlan: plan,
          referenceStep: null,
        }, 'reference-plan-checkpoint', faultInjector);
        continue;
      }

      if (saga.phase === 'references_pending') {
        await applyReferences(api, saga, faultInjector);
        continue;
      }

      if (saga.phase === 'references_deleted') {
        await assertTargetAbsent(api, saga, 'pre-sync-verification', faultInjector);
        if (!referencesConverged(resolveReferenceTargetEvidence(saga.referencePlan), saga.referencePlan)) {
          throw new Error('transaction deletion references changed before sync');
        }
        await checkpoint(
          saga,
          { phase: 'sync_pending' },
          'sync-pending-checkpoint',
          faultInjector,
        );
        return { needsSync: true };
      }

      if (saga.phase === 'sync_pending') {
        await assertTargetAbsent(api, saga, 'sync-pending-verification', faultInjector);
        return { needsSync: true };
      }
      if (saga.phase === 'receipt_cleanup_pending') {
        await assertTargetAbsent(api, saga, 'receipt-cleanup-verification', faultInjector);
        return cleanupReceiptFiles(saga, faultInjector);
      }
      if (saga.phase === 'completed') {
        return {
          ok: true,
          deleted: saga.target.parentId,
          references: saga.referencePlan?.stats,
        };
      }
      throw new Error(`unsupported transaction deletion saga phase: ${saga.phase}`);
    }
  }

  async function terminalizeSynced(api, sagas, faultInjector) {
    let firstError = null;
    for (const saga of sagas) {
      try {
        await assertTargetAbsent(api, saga, 'post-sync-verification', faultInjector);
        if (!referencesConverged(resolveReferenceTargetEvidence(saga.referencePlan), saga.referencePlan)) {
          await unresolved(saga, 'transaction deletion references changed before receipt cleanup', faultInjector);
        }
        const syncedAt = new Date().toISOString();
        await checkpoint(saga, {
          phase: 'receipt_cleanup_pending',
          syncedAt,
          receiptCleanup: saga.receiptCleanup || {
            files: [...(saga.referencePlan?.receiptFiles || [])],
            completed: [],
            preserved: [],
            pendingFile: null,
          },
        }, 'receipt-cleanup-checkpoint', faultInjector);
        await cleanupReceiptFiles(saga, faultInjector);
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

  async function remove(api, {
    accountId,
    date,
    transaction,
    faultInjector,
    bulkDelegation = null,
  }) {
    if (!accountId || !date) throw new Error('accountId and date required');
    const target = deletionTarget(transaction);
    if (String(target.snapshot.date) !== String(date)) {
      throw new Error('transaction deletion date does not match the canonical row');
    }
    assertAvailable({ accountId, transaction });
    if (assertExternalAvailable) {
      assertExternalAvailable({ accountId, original: transaction, bulkDelegation });
    }
    const plan = referencePlan({ snapshot: target.snapshot });
    const now = new Date().toISOString();
    const saga = {
      id: `delete_${crypto.randomUUID()}`,
      recordVersion: RECORD_VERSION,
      status: 'started',
      phase: 'prepared',
      accountId: String(accountId),
      date: String(date),
      target,
      referencePlan: plan,
      startedAt: now,
      updatedAt: now,
    };
    await invokeFault(faultInjector, 'before:initial-saga-write', saga);
    writeSaga(saga);
    await invokeFault(faultInjector, 'after:initial-saga-write', saga);

    try {
      const result = await drive(api, saga, { faultInjector });
      if (!result.needsSync) return result;
      return {
        ok: true,
        deleted: saga.target.parentId,
        references: saga.referencePlan.stats,
      };
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
      let result;
      try {
        result = await drive(api, saga, { faultInjector });
      } catch (error) {
        try { await rememberError(saga, error, saga.phase, faultInjector); } catch (_) {}
        errors.push({ sagaId: saga.id, error });
        continue;
      }
      if (result?.needsSync) syncPending.push(saga);
    }
    if (deferSync) {
      return {
        needsSync: syncPending.length > 0,
        errors,
      };
    }
    let syncError = null;
    try {
      await finishSync(api, syncPending, faultInjector);
    } catch (error) {
      syncError = error;
    }
    if (syncError) throw syncError;
    if (errors.length) throw errors[0].error;
    return {
      needsSync: syncPending.length > 0,
      errors,
    };
  }

  async function markSynced(api, { faultInjector } = {}) {
    const syncPending = Object.values(loadState().sagas)
      .filter((saga) => saga.phase === 'sync_pending');
    await terminalizeSynced(api, syncPending, faultInjector);
  }

  function inspectState() {
    return loadState();
  }

  return {
    assertAvailable,
    inspectState,
    markSynced,
    recover,
    remove,
  };
}

module.exports = {
  RECORD_VERSION,
  DeletionSagaOutcomeUnknownError,
  TransactionDeletionInProgressError,
  canonicalTransactionSnapshot,
  createTransactionDeletionSaga,
  transactionDeletionFingerprint,
};
