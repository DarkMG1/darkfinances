/**
 * One monotonic activation sequence shared by mutation form/action/screen hooks on a surface.
 * Every user-initiated dispatch (including retries) receives the next sequence value.
 */

let sequence = 0;

function nextMutationActivationSeq() {
  sequence += 1;
  return sequence;
}

function currentMutationActivationSeq() {
  return sequence;
}

function resetMutationActivationSequence() {
  sequence = 0;
}

module.exports = {
  currentMutationActivationSeq,
  nextMutationActivationSeq,
  resetMutationActivationSequence,
};
