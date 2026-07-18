/**
 * Guards stale Alert discard callbacks after identity/month/entity changes.
 */

function nextDismissRequest(seqRef) {
  seqRef.value += 1;
  return seqRef.value;
}

function bumpDismissGeneration(seqRef) {
  seqRef.value += 1;
}

/**
 * @param {{ identity: string; nonce: number } | null | undefined} request
 * @param {string} currentIdentity
 * @param {{ value: number }} seqRef
 */
function shouldApplyFormDismiss(request, currentIdentity, seqRef) {
  if (!request) return false;
  if (request.identity !== currentIdentity) return false;
  if (request.nonce !== seqRef.value) return false;
  return true;
}

module.exports = {
  bumpDismissGeneration,
  nextDismissRequest,
  shouldApplyFormDismiss,
};
