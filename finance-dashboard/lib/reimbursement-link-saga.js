'use strict';

const crypto = require('crypto');
const { KnownPreApplyError } = require('./errors');
const {
  assertJournalBinding,
  idempotencyKeyReuseError,
  journalBindingsMatch,
  normalizeJournalBinding,
} = require('./operation-journal-proof');
const {
  applyLinkRecord,
  buildExplicitLinkRecord,
  linkPairKey,
  linkRecordConverged,
  linkVersion,
  removeLinkRecord,
  sameTransactionId,
} = require('./reimbursement-allocation');

function runtimeStateStore() {
  return require('./runtime-state-store');
}

const RECORD_VERSION = 1;
const TERMINAL_LIMIT = 100;
const TERMINAL_PHASES = new Set(['completed']);

class ReimbursementLinkInProgressError extends KnownPreApplyError {
  constructor() {
    super('A reimbursement link mutation for these transactions is already in progress', {
      code: 'REIMBURSEMENT_LINK_IN_PROGRESS',
      status: 409,
    });
    this.name = 'ReimbursementLinkInProgressError';
  }
}

function isTerminalSaga(saga) {
  return saga?.recordVersion === RECORD_VERSION && TERMINAL_PHASES.has(saga.phase);
}

function sagaOwnedIds(saga) {
  return new Set([
    saga?.inflowId,
    saga?.expenseId,
  ].filter(Boolean).map(String));
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
  if (saga.action === 'link') {
    return !saga.inflowId || !saga.expenseId || saga.resultVersion == null;
  }
  if (saga.action === 'unlink') {
    return !saga.inflowId || !saga.expenseId || saga.removed == null;
  }
  return true;
}

function expectedMethodForAction(action) {
  if (action === 'link') return 'POST';
  if (action === 'unlink') return 'DELETE';
  return null;
}

function createReimbursementLinkSaga({
  sagaPath,
  readLinks,
  writeLinks,
  assertExternalAvailable,
  revalidateLinkApply,
  revalidateUnlinkApply,
  resolveReimbCategoryId,
  resolvePayeeNames,
  terminalLimit = TERMINAL_LIMIT,
}) {
  if (!sagaPath) throw new Error('reimbursement link saga path required');

  function loadState() {
    const state = runtimeStateStore().readRuntimeState('reimbursementLinkSagas', { file: sagaPath }).value;
    if (!state
      || state.schemaVersion !== 1
      || !state.sagas
      || typeof state.sagas !== 'object'
      || Array.isArray(state.sagas)) {
      throw new Error('invalid reimbursement link saga state');
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
    runtimeStateStore().writeRuntimeState('reimbursementLinkSagas', pruneState(state), { file: sagaPath });
  }

  function writeSaga(saga) {
    const state = loadState();
    state.sagas[saga.id] = saga;
    writeState(state);
  }

  function activeOwnedIds() {
    const ids = new Set();
    for (const saga of Object.values(loadState().sagas || {})) {
      if (isTerminalSaga(saga)) continue;
      for (const id of sagaOwnedIds(saga)) ids.add(id);
    }
    return ids;
  }

  function assertAvailable({ accountId, ids } = {}) {
    const candidates = new Set((ids || []).filter((id) => id != null).map(String));
    if (!candidates.size) return;
    const conflict = Object.values(loadState().sagas).some((saga) => {
      if (isTerminalSaga(saga)) return false;
      const owned = sagaOwnedIds(saga);
      return [...candidates].some((id) => owned.has(id));
    });
    if (conflict) throw new ReimbursementLinkInProgressError();
  }

  function assertJournalAdmission({ operationKey, journalBinding, action }) {
    if (!operationKey || !journalBinding?.fingerprint) return;
    const normalized = normalizeJournalBinding(journalBinding);
    if (!normalized) return;
    const matches = sagasForOperationKey(loadState(), operationKey);
    if (matches.length > 1) throw idempotencyKeyReuseError();
    const existing = matches[0];
    if (!existing || isTerminalSaga(existing)) return;
    assertJournalBinding(existing, normalized, {
      expectedMethod: expectedMethodForAction(action),
    });
    if (action && existing.action && existing.action !== action) {
      throw idempotencyKeyReuseError();
    }
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
    if (!journalBindingsMatch(saga, binding, {
      expectedMethod: expectedMethodForAction(saga.action),
    })) return null;
    const result = terminalReplay(saga);
    if (!result?.ok) return null;
    return result;
  }

  async function invokeFault(faultInjector, point, saga) {
    if (!faultInjector) return;
    await faultInjector(point, { sagaId: saga?.id || null, phase: saga?.phase || null });
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

  function terminalReplay(saga) {
    if (saga.action === 'unlink') {
      return { ok: true, removed: saga.removed ?? 0, idempotent: saga.idempotent === true };
    }
    return {
      ok: true,
      inflowId: saga.inflowId,
      expenseId: saga.expenseId,
      allocationCents: saga.allocationCents,
      linkKey: saga.linkKey,
      version: saga.resultVersion ?? saga.version ?? null,
      idempotent: saga.idempotent === true,
    };
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

  async function applyPreparedLink(api, saga, { faultInjector } = {}) {
    const reimbCategoryId = await resolveReimbCategoryId(api);
    const payeeNames = await resolvePayeeNames(api);
    const store = readLinks();
    const admission = await revalidateLinkApply(api, saga, {
      existingLinks: store.links,
      reimbCategoryId,
      payeeNames,
    });
    const { record } = buildExplicitLinkRecord({
      inflowLive: admission.inflowLive,
      expenseLive: admission.expenseLive,
      allocationCents: admission.allocationCents,
      person: admission.person,
      existingLink: admission.existingLink,
      expectedVersion: admission.expectedVersion,
    });
    await checkpoint(saga, { phase: 'links-pending', pendingRecord: record }, 'links-pending-checkpoint', faultInjector);
    applyLinkRecord(store, record);
    await invokeFault(faultInjector, 'before:links-write', saga);
    writeLinks(store);
    await invokeFault(faultInjector, 'after:links-write', saga);
    const converged = linkRecordConverged(readLinks(), record);
    if (!converged) throw new Error('reimbursement link sidecar did not converge');
    await checkpoint(saga, {
      phase: 'completed',
      pendingRecord: null,
      resultVersion: record.version,
    }, 'saga-terminal-write', faultInjector);
    return {
      ok: true,
      inflowId: saga.inflowId,
      expenseId: saga.expenseId,
      allocationCents: saga.allocationCents,
      linkKey: saga.linkKey,
      version: record.version,
      idempotent: saga.idempotent === true,
    };
  }

  async function applyPreparedUnlink(api, saga, { faultInjector } = {}) {
    await checkpoint(saga, { phase: 'links-pending' }, 'links-pending-checkpoint', faultInjector);
    const payeeNames = await resolvePayeeNames(api);
    const store = readLinks();
    const existing = await revalidateUnlinkApply(api, saga, {
      existingLinks: store.links,
      payeeNames,
    });
    if (!existing) {
      await checkpoint(saga, { phase: 'completed', removed: 0 }, 'saga-terminal-write', faultInjector);
      return { ok: true, removed: 0, idempotent: saga.idempotent === true };
    }
    if (saga.expectedVersion != null && linkVersion(existing) !== Number(saga.expectedVersion)) {
      const { ReimbursementLinkStaleError } = require('./reimbursement-allocation');
      throw new ReimbursementLinkStaleError();
    }
    const removed = removeLinkRecord(store, { inflowId: saga.inflowId, expenseId: saga.expenseId });
    await invokeFault(faultInjector, 'before:links-write', saga);
    if (removed > 0) writeLinks(store);
    await invokeFault(faultInjector, 'after:links-write', saga);
    await checkpoint(saga, { phase: 'completed', removed }, 'saga-terminal-write', faultInjector);
    return { ok: true, removed, idempotent: saga.idempotent === true };
  }

  async function drive(api, saga, { faultInjector } = {}) {
    assertExternalAvailable?.({
      accountId: saga.accountId,
      ids: [saga.inflowId, saga.expenseId],
    });
    if (isTerminalSaga(saga)) return terminalReplay(saga);
    if (saga.action === 'unlink') return applyPreparedUnlink(api, saga, { faultInjector });
    return applyPreparedLink(api, saga, { faultInjector });
  }

  async function link(api, admission, { operationIdentity, journalBinding, faultInjector } = {}) {
    assertExternalAvailable?.({
      accountId: admission.inflowLive.accountId,
      ids: [admission.inflowLive.id, admission.expenseLive.id],
    });
    const inflowId = String(admission.inflowLive.id);
    const expenseId = String(admission.expenseLive.id);
    if (operationIdentity) {
      assertJournalAdmission({ operationKey: operationIdentity, journalBinding, action: 'link' });
      const existingTerminal = Object.values(loadState().sagas).find(
        (saga) => isTerminalSaga(saga)
          && saga.operationIdentity === operationIdentity
          && saga.action === 'link'
          && sameTransactionId(saga.inflowId, inflowId)
          && sameTransactionId(saga.expenseId, expenseId),
      );
      if (existingTerminal) {
        return {
          ...terminalReplay(existingTerminal),
          idempotent: true,
        };
      }
      const existingActive = sagasForOperationKey(loadState(), operationIdentity)[0];
      if (existingActive && !isTerminalSaga(existingActive)) {
        return drive(api, existingActive, { faultInjector });
      }
    }

    const store = readLinks();
    const existingLink = store.links.find(
      (link) => sameTransactionId(link?.inflow?.id, inflowId)
        && sameTransactionId(link?.expense?.id, expenseId),
    );
    const built = buildExplicitLinkRecord({
      inflowLive: admission.inflowLive,
      expenseLive: admission.expenseLive,
      allocationCents: admission.allocationCents,
      person: admission.person,
      existingLink,
      expectedVersion: admission.expectedVersion,
    });
    if (built.idempotent) {
      return {
        ok: true,
        inflowId,
        expenseId,
        allocationCents: admission.allocationCents,
        linkKey: linkPairKey(inflowId, expenseId),
        version: linkVersion(existingLink),
        idempotent: true,
      };
    }

    const now = new Date().toISOString();
    const saga = bindJournalFields({
      id: operationIdentity || `reimb_link_${crypto.randomUUID()}`,
      recordVersion: RECORD_VERSION,
      status: 'started',
      phase: 'prepared',
      action: 'link',
      operationIdentity: operationIdentity || null,
      accountId: String(admission.inflowLive.accountId),
      inflowId,
      expenseId,
      linkKey: linkPairKey(inflowId, expenseId),
      allocationCents: admission.allocationCents,
      person: admission.person || null,
      expectedVersion: admission.expectedVersion ?? null,
      inflowLive: admission.inflowLive,
      expenseLive: admission.expenseLive,
      allowSamePairResolution: admission.allowSamePairResolution === true,
      idempotent: false,
      startedAt: now,
      updatedAt: now,
    }, journalBinding);
    await invokeFault(faultInjector, 'before:initial-saga-write', saga);
    writeSaga(saga);
    await invokeFault(faultInjector, 'after:initial-saga-write', saga);
    return drive(api, saga, { faultInjector });
  }

  async function unlink(api, {
    inflowId,
    expenseId,
    accountId,
    expectedVersion,
    operationIdentity,
    journalBinding,
    faultInjector,
  } = {}) {
    assertExternalAvailable?.({ accountId, ids: [inflowId, expenseId] });
    const store = readLinks();
    const existing = store.links.find(
      (link) => sameTransactionId(link?.inflow?.id, inflowId)
        && sameTransactionId(link?.expense?.id, expenseId),
    );
    if (!existing) return { ok: true, removed: 0, idempotent: true };

    if (operationIdentity) {
      assertJournalAdmission({ operationKey: operationIdentity, journalBinding, action: 'unlink' });
      const existingTerminal = Object.values(loadState().sagas).find(
        (saga) => isTerminalSaga(saga)
          && saga.operationIdentity === operationIdentity
          && saga.action === 'unlink'
          && sameTransactionId(saga.inflowId, inflowId)
          && sameTransactionId(saga.expenseId, expenseId),
      );
      if (existingTerminal) {
        return { ...terminalReplay(existingTerminal), idempotent: true };
      }
      const existingActive = sagasForOperationKey(loadState(), operationIdentity)[0];
      if (existingActive && !isTerminalSaga(existingActive)) {
        return drive(api, existingActive, { faultInjector });
      }
    }

    const now = new Date().toISOString();
    const saga = bindJournalFields({
      id: operationIdentity || `reimb_unlink_${crypto.randomUUID()}`,
      recordVersion: RECORD_VERSION,
      status: 'started',
      phase: 'prepared',
      action: 'unlink',
      operationIdentity: operationIdentity || null,
      accountId: accountId || existing.inflow?.accountId || null,
      inflowId: String(inflowId),
      expenseId: String(expenseId),
      expectedVersion: expectedVersion ?? null,
      idempotent: false,
      startedAt: now,
      updatedAt: now,
    }, journalBinding);
    await invokeFault(faultInjector, 'before:initial-saga-write', saga);
    writeSaga(saga);
    await invokeFault(faultInjector, 'after:initial-saga-write', saga);
    return drive(api, saga, { faultInjector });
  }

  async function recover(api, { faultInjector } = {}) {
    const active = Object.values(loadState().sagas).filter((saga) => !isTerminalSaga(saga));
    const errors = [];
    for (const saga of active) {
      try {
        await drive(api, saga, { faultInjector });
      } catch (error) {
        errors.push({ sagaId: saga.id, error });
      }
    }
    return { recovered: active.length, errors };
  }

  function listNonterminalSagas() {
    return Object.values(loadState().sagas || {})
      .filter((saga) => !isTerminalSaga(saga))
      .map((saga) => ({
        id: saga.id,
        phase: saga.phase,
        action: saga.action,
        inflowId: saga.inflowId || null,
        expenseId: saga.expenseId || null,
        terminal: false,
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  function inspectState() {
    return loadState();
  }

  async function markSynced() {
    return undefined;
  }

  return {
    activeOwnedIds,
    assertAvailable,
    assertJournalAdmission,
    inspectState,
    link,
    listNonterminalSagas,
    markSynced,
    proveTerminalJournalCompletion,
    recover,
    unlink,
  };
}

module.exports = {
  ReimbursementLinkInProgressError,
  createReimbursementLinkSaga,
};
