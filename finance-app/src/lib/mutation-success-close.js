/**
 * Defers mutation form success close until dispatch lock is released and navigation can observe unlocked state.
 */

function shouldDeferSuccessClose({ successPending, tokenCurrent }) {
  return !!successPending && !!tokenCurrent;
}

function shouldInvokeDeferredSuccessClose({ tokenCurrent, pendingLocked, alreadyClosed }) {
  return !!tokenCurrent && !pendingLocked && !alreadyClosed;
}

function shouldScheduleDeferredSuccessClose({ phase, dispatchPending, pendingLocked, successPending }) {
  return phase === 'success' && !dispatchPending && !pendingLocked && !!successPending;
}

function shouldRunDeferredSuccessClose({ phase, tokenCurrent, pendingLocked, dispatchPending, alreadyClosed }) {
  return (
    phase === 'success'
    && !!tokenCurrent
    && !pendingLocked
    && !dispatchPending
    && !alreadyClosed
  );
}

module.exports = {
  shouldDeferSuccessClose,
  shouldInvokeDeferredSuccessClose,
  shouldScheduleDeferredSuccessClose,
  shouldRunDeferredSuccessClose,
};
