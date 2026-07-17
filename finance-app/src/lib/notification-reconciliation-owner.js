'use strict';

const {
  beginReconciliation,
  cancelReconciliation,
  endReconciliation,
  getProfileGeneration,
  isNotificationScopeAdmissionAllowed,
  purgeProfileGeneration,
} = require('./notification-reconciliation');
const { reportUnexpectedReconciliationError } = require('./notification-reconciliation-errors');

/**
 * Mirrors the root NotificationReconciliationOwner React effects without React so
 * behavioral tests can simulate same-commit scheduling/event runs.
 *
 * @param {{
 *   generation: number;
 *   reconcileScheduled: (input: any) => Promise<void>;
 *   reconcileEvent: (input: any) => Promise<void>;
 *   recordDiagnostic?: (error: unknown) => void;
 * }} deps
 */
function createNotificationReconciliationOwnerRunner(deps) {
  /** @type {{ scheduled?: { token: any, cancel: () => void }, event?: { token: any, cancel: () => void } }} */
  let activeRuns = {};

  async function runLane(lane, input, token) {
    const reconcile = lane === 'scheduled' ? deps.reconcileScheduled : deps.reconcileEvent;
    try {
      await reconcile({ ...input, token });
    } catch (error) {
      reportUnexpectedReconciliationError(error, deps.recordDiagnostic);
      throw error;
    } finally {
      if (token) endReconciliation(token);
    }
  }

  function admitScope(scope) {
    deps.generation = getProfileGeneration();
    return isNotificationScopeAdmissionAllowed(scope);
  }

  function startScheduled(input) {
    activeRuns.scheduled?.cancel();
    const scope = input.scope;
    if (!admitScope(scope)) {
      return {
        token: null,
        suppressed: true,
        cancel: () => {},
        run: Promise.resolve(),
      };
    }
    const token = beginReconciliation('scheduled', deps.generation, scope);
    const run = runLane('scheduled', input, token);
    activeRuns.scheduled = {
      token,
      cancel: () => cancelReconciliation(token),
      run,
    };
    return activeRuns.scheduled;
  }

  function startEvent(input) {
    activeRuns.event?.cancel();
    const scope = input.scope;
    if (!admitScope(scope)) {
      return {
        token: null,
        suppressed: true,
        cancel: () => {},
        run: Promise.resolve(),
      };
    }
    const token = beginReconciliation('event', deps.generation, scope);
    const run = runLane('event', input, token);
    activeRuns.event = {
      token,
      cancel: () => cancelReconciliation(token),
      run,
    };
    return activeRuns.event;
  }

  function cleanupScheduled() {
    if (!activeRuns.scheduled) return;
    activeRuns.scheduled.cancel();
    activeRuns.scheduled = undefined;
  }

  function cleanupEvent() {
    if (!activeRuns.event) return;
    activeRuns.event.cancel();
    activeRuns.event = undefined;
  }

  /**
   * Simulates React running both effect bodies in one commit before either cleanup fires.
   */
  function startBothInOneCommit(scheduledInput, eventInput) {
    const scheduled = startScheduled(scheduledInput);
    const event = startEvent(eventInput);
    return { scheduled, event };
  }

  function purgeProfile(scope) {
    activeRuns.scheduled?.cancel();
    activeRuns.event?.cancel();
    activeRuns = {};
    deps.generation = purgeProfileGeneration(scope);
    return deps.generation;
  }

  return {
    startScheduled,
    startEvent,
    startBothInOneCommit,
    cleanupScheduled,
    cleanupEvent,
    purgeProfile,
    activeRuns: () => activeRuns,
  };
}

module.exports = {
  createNotificationReconciliationOwnerRunner,
};
