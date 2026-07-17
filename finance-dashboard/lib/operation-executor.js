const { AppError, KnownPreApplyError } = require('./errors');
const {
  PHASES,
  isCompleted,
  isKnownFailed,
} = require('./operation-journal');

const OUTCOME_UNKNOWN_MESSAGE = 'The request outcome is unknown; check operation status before retrying';

function outcomeUnknown(cause) {
  return new AppError(OUTCOME_UNKNOWN_MESSAGE, {
    code: 'OUTCOME_UNKNOWN',
    status: 409,
    expose: true,
    cause,
  });
}

function terminalFailure(operation) {
  const storedStatus = operation.error?.status;
  const status = Number.isInteger(storedStatus) && storedStatus >= 400 && storedStatus <= 499
    ? storedStatus
    : 400;
  return new AppError(operation.error?.message || 'The operation failed before local application', {
    code: operation.error?.code || 'OPERATION_FAILED',
    status,
    expose: true,
  });
}

class OperationContext {
  constructor(journal, key, onJournalError, journalBinding = {}) {
    this.journal = journal;
    this.key = key;
    this.onJournalError = onJournalError;
    this.fingerprint = journalBinding.fingerprint || null;
    this.fingerprintVersion = journalBinding.fingerprintVersion ?? null;
    this.method = journalBinding.method || null;
    this.route = journalBinding.route || null;
    this.phase = PHASES.STARTED;
    this.effectBoundaryCrossed = false;
  }

  get journalBinding() {
    return {
      fingerprint: this.fingerprint,
      fingerprintVersion: this.fingerprintVersion,
      method: this.method,
      route: this.route,
    };
  }

  effectsMayExist() {
    this.effectBoundaryCrossed = true;
  }

  writeCheckpoint(name, write) {
    try {
      return write();
    } catch (error) {
      if (this.onJournalError) this.onJournalError(error, name);
      throw error;
    }
  }

  localApplied(result) {
    this.effectsMayExist();
    const operation = this.writeCheckpoint(
      PHASES.LOCAL_APPLIED,
      () => this.journal.localApplied(this.key, result),
    );
    this.phase = PHASES.LOCAL_APPLIED;
    return operation;
  }

  async applyLocal(mutation) {
    this.effectsMayExist();
    const result = await mutation();
    this.localApplied(result);
    return result;
  }

  async sync(syncOperation) {
    const operation = this.writeCheckpoint(
      PHASES.SYNC_UNKNOWN,
      () => this.journal.syncUnknown(this.key),
    );
    this.phase = PHASES.SYNC_UNKNOWN;
    this.effectsMayExist();
    await syncOperation();
    return operation;
  }
}

async function tryReconcileExistingOperation({
  journal,
  key,
  existing,
  terminalProofResolver,
  onJournalError,
}) {
  if (!terminalProofResolver || isCompleted(existing) || isKnownFailed(existing)) return null;
  let proof = null;
  try {
    proof = await terminalProofResolver({ key, operation: existing });
  } catch (error) {
    if (onJournalError) onJournalError(error, 'reconcile-proof');
    return null;
  }
  if (!proof || proof.result === undefined) return null;
  let completed;
  try {
    completed = journal.reconcileFromTerminalProof(key, proof);
  } catch (error) {
    if (onJournalError) onJournalError(error, 'reconcile');
    throw outcomeUnknown(error);
  }
  return {
    result: completed.result === undefined ? null : completed.result,
    operation: { key, replayed: true, reconciled: true },
  };
}

async function executeJournaledOperation({
  journal,
  key,
  request,
  handler,
  requiresCheckpoint = true,
  onJournalError,
  terminalProofResolver,
  knownPreApplyFailure = (error) => error instanceof KnownPreApplyError,
}) {
  const admission = journal.start(key, request);
  const { existing } = admission;
  const journalBinding = {
    fingerprint: admission.fingerprint,
    fingerprintVersion: admission.fingerprintVersion,
    method: admission.method,
    route: admission.route,
  };
  if (existing) {
    if (isCompleted(existing)) {
      return {
        result: existing.result === undefined ? null : existing.result,
        operation: { key, replayed: true },
      };
    }
    if (isKnownFailed(existing)) throw terminalFailure(existing);
    const reconciled = await tryReconcileExistingOperation({
      journal,
      key,
      existing,
      terminalProofResolver,
      onJournalError,
    });
    if (reconciled) return reconciled;
    throw outcomeUnknown();
  }

  const context = new OperationContext(journal, key, onJournalError, journalBinding);
  let result;
  try {
    result = await handler(context);
  } catch (error) {
    if (!context.effectBoundaryCrossed && error?.code === 'IDEMPOTENCY_KEY_REUSED') throw error;
    if (!context.effectBoundaryCrossed && knownPreApplyFailure(error)) {
      let failed;
      try {
        failed = journal.failBeforeApply(key, error);
      } catch (journalError) {
        if (onJournalError) onJournalError(journalError, PHASES.FAILED);
        throw outcomeUnknown(journalError);
      }
      throw terminalFailure(failed);
    }
    throw outcomeUnknown(error);
  }

  if (requiresCheckpoint && context.phase === PHASES.STARTED) {
    throw outcomeUnknown(new Error('Mutation handler returned without a durable local checkpoint'));
  }

  let completed;
  try {
    completed = journal.complete(key, result);
  } catch (error) {
    if (onJournalError) onJournalError(error, PHASES.COMPLETED);
    throw outcomeUnknown(error);
  }

  return {
    result: completed.result,
    operation: { key, replayed: false },
  };
}

module.exports = {
  OUTCOME_UNKNOWN_MESSAGE,
  OperationContext,
  executeJournaledOperation,
  outcomeUnknown,
  terminalFailure,
  tryReconcileExistingOperation,
};
