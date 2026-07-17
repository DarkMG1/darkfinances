'use strict';

const STALE_CODE = 'NOTIFICATION_RECONCILIATION_STALE';

/**
 * @typedef {{ generation: number, sessionId: number, lane: string }} LaneToken
 * @typedef {{
 *   canonical: string[];
 *   pending: string[];
 *   retiring: string[];
 *   cleanup: string[];
 *   laneToken: LaneToken | null;
 *   purgeTombstone?: boolean;
 * }} CategoryScheduleState
 */

function staleError() {
  const error = new Error(STALE_CODE);
  error.code = STALE_CODE;
  return error;
}

function normalizeCategoryState(raw) {
  if (Array.isArray(raw)) {
    return {
      canonical: [...raw],
      pending: [],
      retiring: [],
      cleanup: [],
      laneToken: null,
      purgeTombstone: false,
    };
  }
  if (raw && typeof raw === 'object') {
    return {
      canonical: Array.isArray(raw.canonical) ? [...raw.canonical] : [],
      pending: Array.isArray(raw.pending) ? [...raw.pending] : [],
      retiring: Array.isArray(raw.retiring) ? [...raw.retiring] : [],
      cleanup: Array.isArray(raw.cleanup) ? [...raw.cleanup] : [],
      laneToken: raw.laneToken ?? null,
      purgeTombstone: raw.purgeTombstone === true,
    };
  }
  return {
    canonical: [],
    pending: [],
    retiring: [],
    cleanup: [],
    laneToken: null,
    purgeTombstone: false,
  };
}

function laneTokenMatches(left, right) {
  if (left == null || right == null) return false;
  return left.generation === right.generation
    && left.sessionId === right.sessionId
    && left.lane === right.lane;
}

function readCategoryState(tracked, category) {
  return normalizeCategoryState(tracked[category]);
}

/** IDs that must remain represented because they may still exist in the OS. */
function osLiveIds(state) {
  return [...new Set([
    ...state.canonical,
    ...state.pending,
    ...state.retiring,
    ...state.cleanup,
  ])];
}

/** All IDs this category owns for purge/cancel evidence. */
function allTrackedIds(state) {
  return osLiveIds(state);
}

function hasStageEvidence(state) {
  return state.pending.length > 0
    || state.retiring.length > 0
    || state.cleanup.length > 0
    || state.laneToken != null
    || state.purgeTombstone === true;
}

function writeCategoryState(tracked, category, state) {
  if (!hasStageEvidence(state)) {
    if (state.canonical.length) tracked[category] = state.canonical;
    else delete tracked[category];
    return;
  }
  tracked[category] = {
    canonical: state.canonical,
    pending: state.pending,
    retiring: state.retiring,
    cleanup: state.cleanup,
    laneToken: state.laneToken,
    ...(state.purgeTombstone ? { purgeTombstone: true } : {}),
  };
}

function readCommittedCategoryIds(tracked, category) {
  return readCategoryState(tracked, category).canonical;
}

function assertOwnsStage(state, laneToken) {
  if (!laneTokenMatches(state.laneToken, laneToken)) throw staleError();
}

/**
 * @param {Record<string, unknown>} tracked
 * @param {string} category
 * @param {CategoryScheduleState} state
 * @param {LaneToken} laneToken
 */
function casWriteStage(tracked, category, state, laneToken) {
  const current = readCategoryState(tracked, category);
  if (laneToken != null && current.laneToken != null && !laneTokenMatches(current.laneToken, laneToken)) {
    throw staleError();
  }
  writeCategoryState(tracked, category, state);
}

function mergeCleanup(state, ids) {
  if (!ids.length) return state;
  return {
    ...state,
    cleanup: [...new Set([...state.cleanup, ...ids])],
  };
}

module.exports = {
  STALE_CODE,
  allTrackedIds,
  assertOwnsStage,
  casWriteStage,
  hasStageEvidence,
  laneTokenMatches,
  mergeCleanup,
  normalizeCategoryState,
  osLiveIds,
  readCategoryState,
  readCommittedCategoryIds,
  staleError,
  writeCategoryState,
};
