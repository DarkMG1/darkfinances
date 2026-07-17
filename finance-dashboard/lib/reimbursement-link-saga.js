'use strict';

const crypto = require('crypto');
const { KnownPreApplyError } = require('./errors');
const { readJsonFile, writeJsonFile } = require('./json-store');
const {
  applyLinkRecord,
  buildExplicitLinkRecord,
  linkPairKey,
  linkRecordConverged,
  removeLinkRecord,
  sameTransactionId,
} = require('./reimbursement-allocation');

const RECORD_VERSION = 1;
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

function createReimbursementLinkSaga({
  sagaPath,
  readLinks,
  writeLinks,
  assertExternalAvailable,
}) {
  function loadState() {
    const state = readJsonFile(sagaPath, { schemaVersion: 1, sagas: {} });
    if (!state || typeof state !== 'object' || Array.isArray(state)) return { schemaVersion: 1, sagas: {} };
    if (!state.sagas || typeof state.sagas !== 'object' || Array.isArray(state.sagas)) state.sagas = {};
    return state;
  }

  function writeState(state) {
    writeJsonFile(sagaPath, { schemaVersion: 1, sagas: state.sagas || {} });
  }

  function writeSaga(saga) {
    const state = loadState();
    state.sagas[saga.id] = saga;
    writeState(state);
  }

  function deleteSaga(id) {
    const state = loadState();
    delete state.sagas[id];
    writeState(state);
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

  async function applyPreparedLink(api, saga, { faultInjector } = {}) {
    const store = readLinks();
    const { record } = buildExplicitLinkRecord({
      inflowLive: saga.inflowLive,
      expenseLive: saga.expenseLive,
      allocationCents: saga.allocationCents,
      person: saga.person,
      existingLink: store.links.find(
        (link) => sameTransactionId(link?.inflow?.id, saga.inflowId)
          && sameTransactionId(link?.expense?.id, saga.expenseId),
      ),
      expectedVersion: saga.expectedVersion,
    });
    await checkpoint(saga, { phase: 'links-pending', pendingRecord: record }, 'links-pending-checkpoint', faultInjector);
    applyLinkRecord(store, record);
    await invokeFault(faultInjector, 'before:links-write', saga);
    writeLinks(store);
    await invokeFault(faultInjector, 'after:links-write', saga);
    const converged = linkRecordConverged(readLinks(), record);
    if (!converged) throw new Error('reimbursement link sidecar did not converge');
    await checkpoint(saga, { phase: 'completed', pendingRecord: null }, 'saga-terminal-write', faultInjector);
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
    const store = readLinks();
    const removed = removeLinkRecord(store, { inflowId: saga.inflowId, expenseId: saga.expenseId });
    await invokeFault(faultInjector, 'before:links-write', saga);
    if (removed > 0) writeLinks(store);
    await invokeFault(faultInjector, 'after:links-write', saga);
    await checkpoint(saga, { phase: 'completed' }, 'saga-terminal-write', faultInjector);
    return { ok: true, removed };
  }

  async function drive(api, saga, { faultInjector } = {}) {
    assertExternalAvailable?.({
      accountId: saga.accountId,
      ids: [saga.inflowId, saga.expenseId],
    });
    if (isTerminalSaga(saga)) {
      return saga.action === 'unlink'
        ? { ok: true, removed: saga.removed ?? 0 }
        : {
          ok: true,
          inflowId: saga.inflowId,
          expenseId: saga.expenseId,
          allocationCents: saga.allocationCents,
          linkKey: saga.linkKey,
          version: saga.resultVersion ?? saga.version ?? null,
          idempotent: saga.idempotent === true,
        };
    }
    if (saga.action === 'unlink') return applyPreparedUnlink(api, saga, { faultInjector });
    return applyPreparedLink(api, saga, { faultInjector });
  }

  async function link(api, admission, { operationIdentity, faultInjector } = {}) {
    assertExternalAvailable?.({
      accountId: admission.inflowLive.accountId,
      ids: [admission.inflowLive.id, admission.expenseLive.id],
    });
    const inflowId = String(admission.inflowLive.id);
    const expenseId = String(admission.expenseLive.id);
    const existingTerminal = Object.values(loadState().sagas).find(
      (saga) => isTerminalSaga(saga)
        && saga.action === 'link'
        && sameTransactionId(saga.inflowId, inflowId)
        && sameTransactionId(saga.expenseId, expenseId)
        && saga.allocationCents === admission.allocationCents
        && saga.operationIdentity === operationIdentity,
    );
    if (existingTerminal) {
      return {
        ok: true,
        inflowId,
        expenseId,
        allocationCents: admission.allocationCents,
        linkKey: linkPairKey(inflowId, expenseId),
        version: existingTerminal.resultVersion ?? null,
        idempotent: true,
      };
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
        version: linkVersionSafe(existingLink),
        idempotent: true,
      };
    }

    const now = new Date().toISOString();
    const saga = {
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
      idempotent: false,
      startedAt: now,
      updatedAt: now,
    };
    await invokeFault(faultInjector, 'before:initial-saga-write', saga);
    writeSaga(saga);
    await invokeFault(faultInjector, 'after:initial-saga-write', saga);
    const result = await drive(api, saga, { faultInjector });
    saga.resultVersion = built.record.version;
    return result;
  }

  async function unlink(api, { inflowId, expenseId, accountId, expectedVersion, operationIdentity, faultInjector } = {}) {
    assertExternalAvailable?.({ accountId, ids: [inflowId, expenseId] });
    const store = readLinks();
    const existing = store.links.find(
      (link) => sameTransactionId(link?.inflow?.id, inflowId)
        && sameTransactionId(link?.expense?.id, expenseId),
    );
    if (!existing) return { ok: true, removed: 0 };
    if (expectedVersion != null && linkVersionSafe(existing) !== Number(expectedVersion)) {
      const { ReimbursementLinkStaleError } = require('./reimbursement-allocation');
      throw new ReimbursementLinkStaleError();
    }
    const now = new Date().toISOString();
    const saga = {
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
      startedAt: now,
      updatedAt: now,
    };
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
    if (errors.length) throw errors[0].error;
    return { recovered: active.length };
  }

  function inspectState() {
    return loadState();
  }

  async function markSynced() {
    return undefined;
  }

  return {
    assertAvailable,
    inspectState,
    link,
    markSynced,
    recover,
    unlink,
  };
}

function linkVersionSafe(link) {
  if (!link) return 0;
  if (link.version != null) return Number(link.version) || 0;
  if (link.allocationCents != null || link.amount != null) return 1;
  return 0;
}

module.exports = {
  ReimbursementLinkInProgressError,
  createReimbursementLinkSaga,
};
