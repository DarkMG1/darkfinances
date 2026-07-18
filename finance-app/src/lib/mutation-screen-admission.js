/**
 * Synchronous cross-action admission lock for multi-mutation screens.
 * Prevents sibling dispatches in the same tick before React state catches up.
 */

function tryAcquireMutationAdmission(admissionRef) {
  if (!admissionRef) return true;
  if (admissionRef.current) return false;
  admissionRef.current = true;
  return true;
}

function releaseMutationAdmission(admissionRef) {
  if (admissionRef) admissionRef.current = false;
}

function isMutationAdmissionBlocked(admissionRef) {
  return !!admissionRef?.current;
}

module.exports = {
  isMutationAdmissionBlocked,
  releaseMutationAdmission,
  tryAcquireMutationAdmission,
};
