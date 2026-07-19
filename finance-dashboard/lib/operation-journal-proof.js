'use strict';

const { AppError } = require('./errors');

function normalizeJournalBinding(binding) {
  if (!binding?.fingerprint) return null;
  return {
    fingerprint: binding.fingerprint,
    fingerprintVersion: binding.fingerprintVersion,
    method: binding.method || null,
    route: binding.route || null,
  };
}

function journalProofFromOperation(operation) {
  if (!operation?.fingerprint || operation.fingerprintVersion == null) return null;
  return {
    fingerprint: operation.fingerprint,
    fingerprintVersion: operation.fingerprintVersion,
    method: operation.method || null,
    route: operation.route || null,
  };
}

function journalBindingsMatch(saga, binding, { expectedMethod = null, expectedRoute = null } = {}) {
  const normalized = normalizeJournalBinding(binding);
  if (!normalized) return false;
  if (!saga?.operationJournalFingerprint) return false;
  if (saga.operationJournalFingerprint !== normalized.fingerprint) return false;
  if (saga.operationJournalFingerprintVersion !== normalized.fingerprintVersion) return false;
  if (saga.operationJournalMethod && normalized.method
    && saga.operationJournalMethod !== normalized.method) return false;
  if (saga.operationJournalRoute && normalized.route
    && saga.operationJournalRoute !== normalized.route) return false;
  if (expectedMethod && normalized.method && normalized.method !== expectedMethod) return false;
  if (expectedRoute && normalized.route && normalized.route !== expectedRoute) return false;
  return true;
}

function idempotencyKeyReuseError() {
  return new AppError('Idempotency key was already used for a different request', {
    code: 'IDEMPOTENCY_KEY_REUSED',
    status: 409,
    expose: true,
  });
}

function assertJournalBinding(saga, binding, options = {}) {
  const normalized = normalizeJournalBinding(binding);
  if (!normalized) return;
  if (!saga?.operationJournalFingerprint || !journalBindingsMatch(saga, normalized, options)) {
    throw idempotencyKeyReuseError();
  }
}

function terminalProofEnvelope(result, journalOperation) {
  if (!result || result.ok !== true) return null;
  if (result.needsSync) return null;
  if (result.status != null && result.status !== 'completed') return null;
  const binding = normalizeJournalBinding(journalOperation);
  if (!binding) return null;
  return {
    result,
    fingerprint: binding.fingerprint,
    fingerprintVersion: binding.fingerprintVersion,
  };
}

function composeTerminalProofResolver(provers) {
  const ordered = Array.isArray(provers) ? provers : [];
  return async function composedTerminalProofResolver({ key, operation }) {
    const journalOperation = journalProofFromOperation(operation);
    if (!journalOperation) return null;
    for (const prove of ordered) {
      let result = null;
      try {
        result = await prove(key, journalOperation);
      } catch (_) {
        result = null;
      }
      const envelope = terminalProofEnvelope(result, journalOperation);
      if (envelope) return envelope;
    }
    return null;
  };
}

module.exports = {
  assertJournalBinding,
  composeTerminalProofResolver,
  idempotencyKeyReuseError,
  journalBindingsMatch,
  journalProofFromOperation,
  normalizeJournalBinding,
  terminalProofEnvelope,
};
