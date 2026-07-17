'use strict';

const {
  allTrackedIds,
  assertOwnsStage,
  casWriteStage,
  laneTokenMatches,
  readCategoryState,
  writeCategoryState,
} = require('./notification-scheduled-stage');

/**
 * @param {{
 *   readTracked: (scope: string) => Record<string, unknown>;
 *   writeTracked: (scope: string, tracked: Record<string, unknown>) => void;
 *   confirmCancelScheduledIds: (ids: string[]) => Promise<{ confirmed: string[], retained: string[] }>;
 *   assertReconciliationCurrent: (token: any) => void;
 *   onStageEvent?: (event: string, context: Record<string, unknown>) => void | Promise<void>;
 * }} deps
 */
function createCategoryScheduleReplacer(deps) {
  const {
    readTracked,
    writeTracked,
    confirmCancelScheduledIds,
    scheduleNotificationAsync,
    assertReconciliationCurrent,
    onStageEvent,
  } = deps;

  async function emit(event, context) {
    if (onStageEvent) await onStageEvent(event, context);
  }

  async function cancelEvidenceBucket(scope, category, state, bucket) {
    const ids = state[bucket];
    if (!ids.length) return { state, incomplete: false };

    const { confirmed, retained } = await confirmCancelScheduledIds(ids);
    const next = {
      ...state,
      [bucket]: retained,
    };
    await emit('cancelEvidence', {
      scope,
      category,
      bucket,
      requested: ids,
      confirmed,
      retained,
    });
    return {
      state: next,
      incomplete: retained.length > 0,
    };
  }

  async function convergeCategory(scope, category) {
    const tracked = readTracked(scope);
    let state = readCategoryState(tracked, category);
    if (!state.pending.length && !state.retiring.length && !state.cleanup.length && !state.laneToken) {
      return { state, incomplete: false };
    }

    let incomplete = false;
    for (const bucket of ['pending', 'retiring', 'cleanup']) {
      const result = await cancelEvidenceBucket(scope, category, state, bucket);
      state = result.state;
      if (result.incomplete) incomplete = true;
    }

    if (!state.pending.length && !state.retiring.length && !state.cleanup.length) {
      state = { ...state, laneToken: null, purgeTombstone: false };
    }

    writeCategoryState(tracked, category, state);
    writeTracked(scope, tracked);
    await emit('converged', { scope, category, state, incomplete });
    return { state, incomplete };
  }

  /**
   * @param {any} token
   * @param {string} scope
   * @param {string} category
   * @param {(stage: { scheduleOne: (request: unknown) => Promise<string> }) => Promise<string[]>} buildNewSet
   */
  async function replaceCategorySchedules(token, scope, category, buildNewSet) {
    assertReconciliationCurrent(token);
    await convergeCategory(scope, category);

    const tracked = readTracked(scope);
    const initial = readCategoryState(tracked, category);
    const previousCanonical = [...initial.canonical];
    const laneToken = {
      generation: token.generation,
      sessionId: token.sessionId,
      lane: token.lane,
    };

    let state = {
      canonical: previousCanonical,
      pending: [],
      retiring: [],
      cleanup: [...initial.cleanup],
      laneToken,
      purgeTombstone: false,
    };
    casWriteStage(tracked, category, state, laneToken);
    writeTracked(scope, tracked);
    await emit('stageOpened', { scope, category, state, previousCanonical, laneToken });

    let incompleteCleanup = false;

    try {
      const newIds = await buildNewSet({
        scheduleOne: async (request) => {
          assertReconciliationCurrent(token);
          const id = await scheduleNotificationAsync(request);

          const trackedNow = readTracked(scope);
          const current = readCategoryState(trackedNow, category);
          assertOwnsStage(current, laneToken);
          state = {
            ...current,
            pending: [...current.pending, id],
          };
          casWriteStage(trackedNow, category, state, laneToken);
          writeTracked(scope, trackedNow);

          await emit('afterSchedule', { scope, category, id, laneToken, state });
          await emit('afterStageWrite', { scope, category, state, laneToken });
          return id;
        },
      });

      assertReconciliationCurrent(token);
      const trackedBeforeCommit = readTracked(scope);
      const preCommit = readCategoryState(trackedBeforeCommit, category);
      assertOwnsStage(preCommit, laneToken);

      const toRetire = previousCanonical.filter((id) => !newIds.includes(id));
      state = {
        canonical: [...newIds],
        pending: [],
        retiring: toRetire,
        cleanup: preCommit.cleanup,
        laneToken,
        purgeTombstone: false,
      };
      casWriteStage(trackedBeforeCommit, category, state, laneToken);
      writeTracked(scope, trackedBeforeCommit);
      await emit('afterCanonicalCommit', { scope, category, state, laneToken, newIds, toRetire });

      for (const oldId of toRetire) {
        assertReconciliationCurrent(token);
        const { confirmed, retained } = await confirmCancelScheduledIds([oldId]);
        await emit('afterOldCancel', {
          scope,
          category,
          oldId,
          laneToken,
          confirmed,
          retained,
        });

        const trackedMid = readTracked(scope);
        const mid = readCategoryState(trackedMid, category);
        assertOwnsStage(mid, laneToken);

        if (retained.includes(oldId)) {
          incompleteCleanup = true;
          state = mid;
          await emit('retiringCancelRetained', { scope, category, oldId, laneToken, state: mid });
          continue;
        }

        state = {
          ...mid,
          retiring: mid.retiring.filter((id) => id !== oldId),
        };
        casWriteStage(trackedMid, category, state, laneToken);
        writeTracked(scope, trackedMid);
        await emit('duringCleanup', { scope, category, state, laneToken, cancelledOldId: oldId });
      }

      assertReconciliationCurrent(token);
      const trackedFinal = readTracked(scope);
      const finalState = readCategoryState(trackedFinal, category);
      assertOwnsStage(finalState, laneToken);
      state = {
        canonical: [...newIds],
        pending: [],
        retiring: [...finalState.retiring],
        cleanup: finalState.cleanup,
        laneToken: null,
        purgeTombstone: false,
      };
      writeCategoryState(trackedFinal, category, state);
      writeTracked(scope, trackedFinal);
      await emit('stageClosed', { scope, category, state, laneToken, incompleteCleanup });

      return { newIds, incompleteCleanup: incompleteCleanup || state.retiring.length > 0 || state.cleanup.length > 0 };
    } catch (error) {
      await abortCategoryReplacement(scope, category, laneToken, previousCanonical);
      throw error;
    }
  }

  async function abortCategoryReplacement(scope, category, laneToken, previousCanonical) {
    const tracked = readTracked(scope);
    const state = readCategoryState(tracked, category);
    if (!laneTokenMatches(state.laneToken, laneToken)) {
      await emit('abortSkippedNewerLane', { scope, category, laneToken });
      return;
    }

    const { retained: pendingRetained } = state.pending.length
      ? await confirmCancelScheduledIds(state.pending)
      : { retained: [] };

    const trackedAfterCancel = readTracked(scope);
    const afterCancel = readCategoryState(trackedAfterCancel, category);
    if (!laneTokenMatches(afterCancel.laneToken, laneToken)) {
      await emit('abortSkippedNewerLane', { scope, category, laneToken });
      return;
    }

    const committed = afterCancel.retiring.length > 0
      || afterCancel.canonical.some((id) => !previousCanonical.includes(id));

    const nextState = committed
      ? {
        canonical: [...afterCancel.canonical],
        pending: pendingRetained,
        retiring: [...afterCancel.retiring],
        cleanup: [...afterCancel.cleanup],
        laneToken: null,
        purgeTombstone: false,
      }
      : {
        canonical: [...previousCanonical],
        pending: pendingRetained,
        retiring: [],
        cleanup: [...afterCancel.cleanup],
        laneToken: null,
        purgeTombstone: false,
      };

    writeCategoryState(trackedAfterCancel, category, nextState);
    writeTracked(scope, trackedAfterCancel);
    await emit('aborted', {
      scope,
      category,
      nextState,
      laneToken,
      pendingRetained,
      committed,
    });
  }

  return {
    abortCategoryReplacement,
    convergeCategory,
    replaceCategorySchedules,
    readCategoryState,
    allTrackedIds,
  };
}

module.exports = {
  createCategoryScheduleReplacer,
};
