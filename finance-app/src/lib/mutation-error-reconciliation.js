/**
 * Per-dispatch error reconciliation tasks — onSettled awaits before unlock/release.
 */

function startMutationErrorReconciliation(run) {
  return Promise.resolve().then(run).catch(() => {});
}

async function awaitMutationErrorReconciliation(task) {
  if (!task) return;
  try {
    await task;
  } catch {
    // Outcome mapping lives inside the task; settle must still proceed.
  }
}

module.exports = {
  awaitMutationErrorReconciliation,
  startMutationErrorReconciliation,
};
