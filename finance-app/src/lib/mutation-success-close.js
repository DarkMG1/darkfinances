/**
 * Defers mutation form success close until dispatch lock is released and navigation can observe unlocked state.
 */

function shouldDeferSuccessClose({ successPending, tokenCurrent }) {
  return !!successPending && !!tokenCurrent;
}

function shouldInvokeDeferredSuccessClose({ tokenCurrent, pendingLocked, alreadyClosed }) {
  return !!tokenCurrent && !pendingLocked && !alreadyClosed;
}

module.exports = {
  shouldDeferSuccessClose,
  shouldInvokeDeferredSuccessClose,
};
