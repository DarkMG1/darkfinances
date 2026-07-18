'use strict';

/**
 * Pure transition helper for FinanceStatusBanner ping availability recovery.
 * When NetInfo remains online, a ping error→success pair requests one reconnect
 * owner refresh — never a blanket query invalidation.
 *
 * @param {{ wasUnavailable: boolean }} state
 * @param {{ isError: boolean, isSuccess: boolean, connectivityPhase: string }} input
 */
function applyPingAvailabilityTransition(state, { isError, isSuccess, connectivityPhase }) {
  if (isError) {
    return { wasUnavailable: true, recoveryRequested: false };
  }
  if (isSuccess && state.wasUnavailable) {
    const recoveryRequested = connectivityPhase === 'online';
    return { wasUnavailable: false, recoveryRequested };
  }
  return { wasUnavailable: state.wasUnavailable, recoveryRequested: false };
}

module.exports = {
  applyPingAvailabilityTransition,
};
