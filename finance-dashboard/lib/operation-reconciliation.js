const { isCompleted, isKnownFailed } = require('./operation-journal');

async function reconcileOperationJournalFromProof(journal, key, {
  proofResolver,
  onJournalError,
} = {}) {
  const record = journal.get(key);
  if (!record) return null;
  if (isCompleted(record) || isKnownFailed(record)) return journal.status(key);
  if (!proofResolver) return journal.status(key);

  let proof = null;
  try {
    proof = await proofResolver({ key, operation: record });
  } catch (_) {
    return journal.status(key);
  }
  if (!proof || proof.result === undefined) return journal.status(key);

  try {
    journal.reconcileFromTerminalProof(key, proof);
  } catch (error) {
    if (onJournalError) onJournalError(error, 'reconcile');
    return journal.status(key);
  }
  return journal.status(key);
}

module.exports = {
  reconcileOperationJournalFromProof,
};
