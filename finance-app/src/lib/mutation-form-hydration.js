/**
 * Draft hydration lifecycle for useMutationForm persistence ordering.
 */

function beginDraftHydration(state) {
  state.generation += 1;
  state.skipPersist = true;
  return state.generation;
}

function finishDraftHydration(state, generation) {
  if (state.generation === generation) {
    state.skipPersist = false;
  }
}

function shouldPersistMutationFormDraft(state, fields, baseline, fieldsEqual) {
  if (state.skipPersist) return false;
  if (fieldsEqual(fields, baseline)) return false;
  return true;
}

function createDraftHydrationState() {
  return { generation: 0, skipPersist: true };
}

module.exports = {
  beginDraftHydration,
  createDraftHydrationState,
  finishDraftHydration,
  shouldPersistMutationFormDraft,
};
