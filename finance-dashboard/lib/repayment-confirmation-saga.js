'use strict';

const crypto = require('crypto');
const { KnownPreApplyError } = require('./errors');
const {
  assertJournalBinding,
  idempotencyKeyReuseError,
  journalBindingsMatch,
  normalizeJournalBinding,
} = require('./operation-journal-proof');
const { readJsonFile, writeJsonFile } = require('./json-store');

function runtimeStateStore() {
  return require('./runtime-state-store');
}
const {
  applyAllocationLink,
  applyConfirmationRecord,
  confirmationConverged,
  linksConverged,
  validateAllocationPlan,
} = require('./repayment-confirmation-sidecars');
const { locateExactTransactionId } = require('./repayment-transaction-locator');

const RECORD_VERSION = 1;
const TERMINAL_LIMIT = 100;
const TERMINAL_PHASES = new Set(['completed']);
const ACCOUNT_RANGE_START = '1900-01-01';
const ACCOUNT_RANGE_END = '9999-12-31';

class RepaymentConfirmationOutcomeUnknownError extends Error {
  constructor(message = 'repayment confirmation outcome is unresolved') {
    super(message);
    this.name = 'RepaymentConfirmationOutcomeUnknownError';
    this.code = 'REPAYMENT_CONFIRMATION_OUTCOME_UNKNOWN';
  }
}

class RepaymentConfirmationInProgressError extends KnownPreApplyError {
  constructor() {
    super('A repayment confirmation for this transaction is already in progress', {
      code: 'REPAYMENT_CONFIRMATION_IN_PROGRESS',
      status: 409,
    });
    this.name = 'RepaymentConfirmationInProgressError';
  }
}

function normalized(value) {
  return value == null || value === '' ? null : value;
}

function canonicalInflowSnapshot(transaction) {
  return {
    id: String(transaction?.id || ''),
    date: String(transaction?.date || ''),
    amountCents: transaction?.amount,
    category: normalized(transaction?.category),
    notes: normalized(transaction?.notes),
    payee: normalized(transaction?.payee),
    transfer_id: normalized(transaction?.transfer_id),
    imported_id: normalized(transaction?.imported_id),
    parent_id: normalized(transaction?.parent_id),
    is_parent: Boolean(transaction?.is_parent),
    subtransactions: Array.isArray(transaction?.subtransactions)
      ? transaction.subtransactions.length
      : 0,
  };
}

function canonicalExpenseSnapshot(transaction) {
  const snapshot = canonicalInflowSnapshot(transaction);
  if (!Number.isSafeInteger(snapshot.amountCents) || snapshot.amountCents >= 0) {
    throw new Error('expense snapshot amount must be negative integer cents');
  }
  return snapshot;
}

function inflowFingerprint(transaction) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalInflowSnapshot(transaction)))
    .digest('hex');
}

function expenseFingerprint(transaction) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalExpenseSnapshot(transaction)))
    .digest('hex');
}

function rowById(rows, id) {
  return rows.find((row) => String(row?.id) === String(id)) || null;
}

function isTerminalSaga(saga) {
  return saga?.recordVersion === RECORD_VERSION && TERMINAL_PHASES.has(saga.phase);
}

function accountMatches(saga, accountId) {
  return saga?.accountId == null || String(saga.accountId) === String(accountId);
}

function sagaOwnedIds(saga) {
  const ids = new Set([saga?.inflow?.id, ...(saga?.allocations || []).map((a) => a.expenseId)]
    .filter((id) => id != null)
    .map(String));
  return ids;
}

function endpointAccounts(saga) {
  const map = { [String(saga.inflow.id)]: String(saga.accountId) };
  for (const allocation of saga.allocations || []) {
    map[String(allocation.expenseId)] = String(allocation.expenseAccountId || saga.accountId);
  }
  return map;
}

function candidateIds({ ids = [] } = {}) {
  return new Set((ids || []).filter((id) => id != null).map(String));
}

function presentIds(rows, targetIds) {
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

function sagasForOperationKey(state, operationKey) {
  if (!operationKey) return [];
  return Object.values(state.sagas || {}).filter(
    (saga) => saga.operationIdentity === operationKey || saga.id === operationKey,
  );
}

function terminalSagaCorrupted(saga) {
  if (!isTerminalSaga(saga)) return true;
  if (!saga.terminalAt) return true;
  if (!saga.inflow?.id) return true;
  if (!saga.auditOutcome || saga.auditOutcome.outcome !== 'confirmed') return true;
  return false;
}

function bindJournalFields(saga, journalBinding) {
  const normalized = normalizeJournalBinding(journalBinding);
  if (!normalized) return saga;
  return {
    ...saga,
    operationJournalFingerprint: normalized.fingerprint,
    operationJournalFingerprintVersion: normalized.fingerprintVersion,
    operationJournalMethod: normalized.method,
    operationJournalRoute: normalized.route,
  };
}

function terminalReplay(saga) {
  return {
    ok: true,
    categorized: true,
    linked: saga.allocations.length,
    inflowId: saga.inflow.id,
  };
}

function createRepaymentConfirmationSaga({
  sagaPath,
  readLinks,
  writeLinks,
  readSuggestions,
  writeSuggestions,
  assertExternalAvailable,
  terminalLimit = TERMINAL_LIMIT,
}) {
  if (!sagaPath) throw new Error('repayment confirmation saga path required');

  function loadState() {
    const state = runtimeStateStore().readRuntimeState('repaymentConfirmationSagas', { file: sagaPath }).value;
    if (!state
      || state.schemaVersion !== 1
      || !state.sagas
      || typeof state.sagas !== 'object'
      || Array.isArray(state.sagas)) {
      throw new Error('invalid repayment confirmation saga state');
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
    runtimeStateStore().writeRuntimeState('repaymentConfirmationSagas', pruneState(state), { file: sagaPath });
  }

  function writeSaga(saga) {
    const state = loadState();
    state.sagas[saga.id] = saga;
    writeState(state);
  }

  function assertAvailable({ accountId, ids } = {}) {
    const candidates = candidateIds({ ids });
    if (!candidates.size) return;
    const conflict = Object.values(loadState().sagas).some((saga) => {
      if (isTerminalSaga(saga) || (accountId && !accountMatches(saga, accountId))) return false;
      const owned = sagaOwnedIds(saga);
      return [...candidates].some((id) => owned.has(id));
    });
    if (conflict) throw new RepaymentConfirmationInProgressError();
  }

  function assertJournalAdmission({ operationKey, journalBinding }) {
    if (!operationKey || !journalBinding?.fingerprint) return;
    const normalized = normalizeJournalBinding(journalBinding);
    if (!normalized) return;
    const matches = sagasForOperationKey(loadState(), operationKey);
    if (matches.length > 1) throw idempotencyKeyReuseError();
    const existing = matches[0];
    if (!existing || isTerminalSaga(existing)) return;
    assertJournalBinding(existing, normalized, { expectedMethod: 'POST' });
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
    if (!isTerminalSaga(saga) || terminalSagaCorrupted(saga)) return null;
    const binding = normalizeJournalBinding(journalOperation);
    if (!journalBindingsMatch(saga, binding, { expectedMethod: 'POST' })) return null;
    const result = terminalReplay(saga);
    if (!result?.ok) return null;
    return result;
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
    const error = new RepaymentConfirmationOutcomeUnknownError(message);
    await rememberError(saga, error, saga.phase, faultInjector);
    throw error;
  }

  function outcomeUnknown(message, cause) {
    const error = new RepaymentConfirmationOutcomeUnknownError(message);
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
          throw outcomeUnknown('unable to enumerate Actual accounts during repayment recovery', error);
        }
        if (!Array.isArray(accounts)) {
          throw outcomeUnknown('Actual account enumeration was invalid during repayment recovery');
        }
        const accountIds = accounts.map((account) => String(account?.id || '')).sort();
        if (accountIds.some((id) => !id) || new Set(accountIds).size !== accountIds.length) {
          throw outcomeUnknown('Actual account enumeration was invalid during repayment recovery');
        }
        if (!accountIds.includes(String(saga.accountId))) {
          throw outcomeUnknown('repayment admission account is absent from Actual account enumeration');
        }

        const targetIds = [...sagaOwnedIds(saga)];
        const accountsById = endpointAccounts(saga);
        const rowsByAccount = {};
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
              `unable to query Actual account ${accountId} during repayment recovery`,
              error,
            );
          }
          if (!Array.isArray(rows)) {
            throw outcomeUnknown(
              `Actual transaction query for account ${accountId} was invalid during repayment recovery`,
            );
          }
          rowsByAccount[accountId] = rows;
          for (const id of presentIds(rows, targetIds)) {
            if (accountsById[id] !== accountId) foreignIds.add(id);
          }
        }
        if (foreignIds.size) {
          throw outcomeUnknown(
            `checkpointed transaction ids found outside their recorded accounts: ${[...foreignIds].sort().join(',')}`,
          );
        }
        return rowsByAccount;
      },
    );
  }

function inflowStructureMatches(transaction, saga, { allowCategoryChange = false } = {}) {
  const snapshot = canonicalInflowSnapshot(transaction);
  const expected = saga.inflow;
  if (String(snapshot.id) !== String(expected.id)) return false;
  if (String(snapshot.date) !== String(expected.date)) return false;
  if (snapshot.amountCents !== expected.amountCents) return false;
  if (normalized(snapshot.payee) !== normalized(expected.payee)) return false;
  if (normalized(snapshot.notes) !== normalized(expected.notes)) return false;
  if (normalized(snapshot.transfer_id) !== normalized(expected.transfer_id)) return false;
  if (!allowCategoryChange && normalized(snapshot.category) !== normalized(expected.category)) return false;
  return true;
}

function categoryApplied(inflow, reimbCategoryId) {
  return String(inflow?.category || '') === String(reimbCategoryId);
}

function inflowMatches(transaction, saga, { afterCategoryUpdate = false } = {}) {
  if (!transaction || String(transaction.id) !== String(saga.inflow.id)) return false;
  const postCategoryPhases = new Set([
    'category_applied',
    'links_pending',
    'links_applied',
    'confirmation_pending',
    'confirmation_applied',
    'sync_pending',
    'completed',
  ]);
  if (postCategoryPhases.has(saga.phase) || afterCategoryUpdate) {
    if (!inflowStructureMatches(transaction, saga, { allowCategoryChange: true })) return false;
    if (afterCategoryUpdate || postCategoryPhases.has(saga.phase)) {
      return categoryApplied(transaction, saga.reimbCategoryId);
    }
    return true;
  }
  return inflowFingerprint(transaction) === saga.inflow.fingerprint;
}

  function expenseMatches(transaction, allocation, { parent = null, isLeg = false } = {}) {
    if (!transaction || String(transaction.id) !== String(allocation.expenseId)) return false;
    if (allocation.parentId != null) {
      if (!isLeg || String(parent?.id || '') !== String(allocation.parentId)) return false;
    } else if (isLeg) {
      return false;
    }
    return expenseFingerprint(transaction) === allocation.fingerprint;
  }

  async function verifyInflow(api, saga, boundaryName, faultInjector, options = {}) {
    const rowsByAccount = await exactRows(api, saga, boundaryName, faultInjector);
    const rows = rowsByAccount[String(saga.accountId)] || [];
    const inflow = rowById(rows, saga.inflow.id);
    if (!inflow) {
      await unresolved(saga, 'checkpointed inflow is absent from the recorded account', faultInjector);
    }
    if (inflow.parent_id || (inflow.is_parent && (inflow.subtransactions || []).length)) {
      await unresolved(saga, 'checkpointed inflow is not a simple transaction', faultInjector);
    }
    const matchOptions = { ...options };
    if (saga.phase === 'category_pending' && categoryApplied(inflow, saga.reimbCategoryId)) {
      matchOptions.afterCategoryUpdate = true;
    }
    if (!inflowMatches(inflow, saga, matchOptions)) {
      await unresolved(saga, 'inflow financial shape changed after repayment admission', faultInjector);
    }
    return { rowsByAccount, inflow };
  }

  async function verifyExpenses(api, saga, boundaryName, faultInjector) {
    const { rowsByAccount } = await verifyInflow(api, saga, boundaryName, faultInjector);
    for (const allocation of saga.allocations || []) {
      const accountId = String(allocation.expenseAccountId || saga.accountId);
      const rows = rowsByAccount[accountId] || [];
      const located = locateExactTransactionId(rows, allocation.expenseId);
      if (!located) {
        await unresolved(
          saga,
          `checkpointed expense ${allocation.expenseId} is absent from the recorded account`,
          faultInjector,
        );
      }
      if (!expenseMatches(located.transaction, allocation, {
        parent: located.parent,
        isLeg: located.isLeg,
      })) {
        await unresolved(
          saga,
          `expense ${allocation.expenseId} financial shape changed after repayment admission`,
          faultInjector,
        );
      }
    }
    return rowsByAccount;
  }


  async function applyLinks(saga, faultInjector) {
    const linksStore = readLinks();
    const plan = saga.linkPlan;
    for (let index = 0; index < (plan.allocations || []).length; index += 1) {
      if (plan.completedIndexes.includes(index)) continue;
      const allocation = plan.allocations[index];
      await checkpoint(
        saga,
        { linkPlan: { ...plan, pendingIndex: index } },
        `link-${index}-pending-checkpoint`,
        faultInjector,
      );
      await boundary(faultInjector, `link-${index}-write`, saga, async () => {
        applyAllocationLink(linksStore, {
          inflowSnapshot: saga.inflow,
          expenseSnapshot: allocation.expenseSnapshot,
          amountCents: allocation.amountCents,
          person: saga.person,
          inflowPayeeName: saga.inflow.payeeName || '',
          expensePayeeName: allocation.expensePayeeName || '',
        });
        writeLinks(linksStore);
      });
      plan.completedIndexes = [...plan.completedIndexes, index].sort((a, b) => a - b);
      plan.pendingIndex = null;
      await checkpoint(
        saga,
        { linkPlan: plan },
        `link-${index}-checkpoint`,
        faultInjector,
      );
    }
    if (!linksConverged(plan, linksStore, {
      inflowSnapshot: saga.inflow,
      person: saga.person,
    })) {
      throw new Error('repayment reimbursement links did not converge');
    }
    await checkpoint(
      saga,
      { phase: 'links_applied', linkPlan: plan, lastError: null },
      'links-applied-checkpoint',
      faultInjector,
    );
  }

  async function writeConfirmationAudit(saga, faultInjector) {
    const store = readSuggestions();
    await boundary(faultInjector, 'confirmation-write', saga, async () => {
      applyConfirmationRecord(store, {
        suggestionId: saga.suggestionId,
        inflowId: saga.inflow.id,
        allocationCount: saga.allocations.length,
        confirmedAt: saga.startedAt,
      });
      writeSuggestions(store);
    });
    if (!confirmationConverged({
      suggestionId: saga.suggestionId,
      inflowId: saga.inflow.id,
      allocationCount: saga.allocations.length,
      store: readSuggestions(),
    })) {
      throw new Error('repayment confirmation audit did not converge');
    }
    await checkpoint(
      saga,
      { phase: 'confirmation_applied', lastError: null },
      'confirmation-checkpoint',
      faultInjector,
    );
  }

  async function applyConfirmation(saga, faultInjector) {
    await checkpoint(saga, { phase: 'confirmation_pending' }, 'confirmation-pending-checkpoint', faultInjector);
    await writeConfirmationAudit(saga, faultInjector);
  }

  async function terminalizeSynced(api, sagas, faultInjector) {
    let firstError = null;
    for (const saga of sagas) {
      try {
        await verifyExpenses(api, saga, 'post-sync-verification', faultInjector);
        const syncedAt = new Date().toISOString();
        await checkpoint(saga, {
          phase: 'completed',
          syncedAt,
          lastError: null,
          auditOutcome: {
            outcome: 'confirmed',
            suggestionId: saga.suggestionId,
            inflowId: saga.inflow.id,
            reimbCategoryId: saga.reimbCategoryId,
            allocationCount: saga.allocations.length,
            totalAllocatedCents: saga.totalAllocatedCents,
            syncedAt,
            completedAt: syncedAt,
          },
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

  async function drive(api, saga, { faultInjector } = {}) {
    for (;;) {
      if (saga.phase === 'prepared') {
        await checkpoint(
          saga,
          { phase: 'category_pending' },
          'category-intent-checkpoint',
          faultInjector,
        );
        continue;
      }

      if (saga.phase === 'category_pending') {
        const { inflow } = await verifyInflow(api, saga, 'inflow-revalidation', faultInjector);
        if (categoryApplied(inflow, saga.reimbCategoryId)) {
          await checkpoint(
            saga,
            { phase: 'category_applied', lastError: null },
            'category-applied-checkpoint',
            faultInjector,
          );
          continue;
        }
        if (inflowFingerprint(inflow) !== saga.inflow.fingerprint) {
          await unresolved(saga, 'inflow financial shape changed after repayment admission', faultInjector);
        }
        await boundary(faultInjector, 'category-update', saga, async () => {
          await api.updateTransaction(saga.inflow.id, { category: saga.reimbCategoryId });
        });
        const verified = await verifyInflow(
          api,
          saga,
          'category-verification',
          faultInjector,
          { afterCategoryUpdate: true },
        );
        if (!categoryApplied(verified.inflow, saga.reimbCategoryId)) {
          throw new Error('repayment category update could not be verified');
        }
        await checkpoint(
          saga,
          { phase: 'category_applied', lastError: null },
          'category-applied-checkpoint',
          faultInjector,
        );
        continue;
      }

      if (saga.phase === 'category_applied') {
        await verifyExpenses(api, saga, 'pre-links-verification', faultInjector);
        const plan = saga.linkPlan || {
          allocations: saga.allocations,
          completedIndexes: [],
          pendingIndex: null,
        };
        await checkpoint(
          saga,
          { phase: 'links_pending', linkPlan: plan },
          'links-pending-checkpoint',
          faultInjector,
        );
        continue;
      }

      if (saga.phase === 'links_pending') {
        await verifyExpenses(api, saga, 'links-revalidation', faultInjector);
        await applyLinks(saga, faultInjector);
        continue;
      }

      if (saga.phase === 'confirmation_pending') {
        await verifyExpenses(api, saga, 'confirmation-revalidation', faultInjector);
        await writeConfirmationAudit(saga, faultInjector);
        continue;
      }

      if (saga.phase === 'links_applied') {
        await verifyExpenses(api, saga, 'pre-confirmation-verification', faultInjector);
        const store = readSuggestions();
        if (confirmationConverged({
          suggestionId: saga.suggestionId,
          inflowId: saga.inflow.id,
          allocationCount: saga.allocations.length,
          store,
        })) {
          await checkpoint(
            saga,
            { phase: 'confirmation_applied', lastError: null },
            'confirmation-checkpoint',
            faultInjector,
          );
          continue;
        }
        await applyConfirmation(saga, faultInjector);
        continue;
      }

      if (saga.phase === 'confirmation_applied') {
        await verifyExpenses(api, saga, 'pre-sync-verification', faultInjector);
        const linksStore = readLinks();
        if (!linksConverged(saga.linkPlan, linksStore, { inflowSnapshot: saga.inflow, person: saga.person })) {
          throw new Error('repayment links changed before sync');
        }
        const suggestStore = readSuggestions();
        if (!confirmationConverged({
          suggestionId: saga.suggestionId,
          inflowId: saga.inflow.id,
          allocationCount: saga.allocations.length,
          store: suggestStore,
        })) {
          throw new Error('repayment confirmation audit changed before sync');
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
        await verifyExpenses(api, saga, 'sync-pending-verification', faultInjector);
        return { needsSync: true };
      }

      if (saga.phase === 'completed') {
        return {
          ok: true,
          categorized: true,
          linked: saga.allocations.length,
          inflowId: saga.inflow.id,
        };
      }

      throw new Error(`unsupported repayment confirmation saga phase: ${saga.phase}`);
    }
  }

  async function finishSync(api, sagas, faultInjector) {
    if (!sagas.length) return;
    await boundary(faultInjector, 'sync', sagas[0], () => api.sync());
    await terminalizeSynced(api, sagas, faultInjector);
  }

  async function confirm(api, {
    accountId,
    suggestionId,
    operationIdentity,
    journalBinding,
    reimbCategoryId,
    person,
    inflowTransaction,
    expenseTransactions,
    allocations,
    existingLinks,
    faultInjector,
  }) {
    if (!accountId || !suggestionId || !reimbCategoryId || !inflowTransaction) {
      throw new Error('repayment confirmation admission inputs required');
    }
    assertAvailable({ accountId, ids: [inflowTransaction.id, ...allocations.map((a) => a.expenseId)] });
    if (assertExternalAvailable) {
      assertExternalAvailable({
        accountId,
        ids: [inflowTransaction.id, ...allocations.map((a) => a.expenseId)],
      });
    }

    if (operationIdentity) {
      assertJournalAdmission({ operationKey: operationIdentity, journalBinding });
      const existingTerminal = Object.values(loadState().sagas).find(
        (saga) => isTerminalSaga(saga)
          && saga.operationIdentity === operationIdentity
          && String(saga.suggestionId) === String(suggestionId),
      );
      if (existingTerminal) {
        return { ...terminalReplay(existingTerminal), idempotent: true };
      }
      const existingActive = sagasForOperationKey(loadState(), operationIdentity)[0];
      if (existingActive && !isTerminalSaga(existingActive)) {
        const result = await drive(api, existingActive, { faultInjector });
        if (!result.needsSync) return result;
        return {
          ok: true,
          categorized: true,
          linked: existingActive.allocations.length,
          inflowId: existingActive.inflow.id,
        };
      }
    }

    const inflowSnapshot = canonicalInflowSnapshot(inflowTransaction);
    if (!inflowSnapshot.id || !inflowSnapshot.date) {
      throw new Error('repayment inflow id and date required');
    }
    if (!Number.isSafeInteger(inflowSnapshot.amountCents) || inflowSnapshot.amountCents <= 0) {
      throw new Error('repayment inflow amount must be positive integer cents');
    }
    if (inflowSnapshot.parent_id || (inflowSnapshot.is_parent && inflowSnapshot.subtransactions)) {
      throw new Error('repayment inflow must be a simple transaction');
    }

    const normalizedAllocations = allocations.map((allocation) => {
      const expenseTx = expenseTransactions[String(allocation.expenseId)];
      if (!expenseTx) throw new Error(`expense ${allocation.expenseId} not resolved`);
      const expenseSnapshot = canonicalExpenseSnapshot(expenseTx);
      const parentId = allocation.parentId != null
        ? String(allocation.parentId)
        : (expenseTx.parentId != null ? String(expenseTx.parentId) : null);
      return {
        expenseId: String(allocation.expenseId),
        amountCents: allocation.amountCents,
        expenseAccountId: String(allocation.expenseAccountId || accountId),
        parentId,
        fingerprint: expenseFingerprint(expenseTx),
        expenseSnapshot,
        expensePayeeName: allocation.expensePayeeName || '',
      };
    });

    const planSummary = validateAllocationPlan({
      inflowAmountCents: inflowSnapshot.amountCents,
      allocations: normalizedAllocations,
      existingLinks: existingLinks || [],
      inflowId: inflowSnapshot.id,
    });

    const now = new Date().toISOString();
    const saga = bindJournalFields({
      id: operationIdentity || `repay_${crypto.randomUUID()}`,
      recordVersion: RECORD_VERSION,
      status: 'started',
      phase: 'prepared',
      suggestionId: String(suggestionId),
      operationIdentity: operationIdentity || null,
      accountId: String(accountId),
      date: String(inflowSnapshot.date),
      reimbCategoryId: String(reimbCategoryId),
      person: person || null,
      inflow: {
        ...inflowSnapshot,
        fingerprint: inflowFingerprint(inflowTransaction),
        payeeName: inflowTransaction.payeeName || '',
      },
      allocations: normalizedAllocations,
      totalAllocatedCents: planSummary.totalAllocatedCents,
      linkPlan: {
        allocations: normalizedAllocations,
        completedIndexes: [],
        pendingIndex: null,
      },
      startedAt: now,
      updatedAt: now,
    }, journalBinding);

    await invokeFault(faultInjector, 'before:initial-saga-write', saga);
    writeSaga(saga);
    await invokeFault(faultInjector, 'after:initial-saga-write', saga);

    try {
      const result = await drive(api, saga, { faultInjector });
      if (!result.needsSync) return result;
      return {
        ok: true,
        categorized: true,
        linked: saga.allocations.length,
        inflowId: saga.inflow.id,
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
    assertJournalAdmission,
    confirm,
    inspectState,
    markSynced,
    proveTerminalJournalCompletion,
    recover,
  };
}

module.exports = {
  RECORD_VERSION,
  RepaymentConfirmationInProgressError,
  RepaymentConfirmationOutcomeUnknownError,
  canonicalExpenseSnapshot,
  canonicalInflowSnapshot,
  createRepaymentConfirmationSaga,
  expenseFingerprint,
  inflowFingerprint,
};
