/**
 * Synchronous cross-action admission lock for multi-mutation screens.
 * Owner lease ids prevent stale settles from releasing a newer holder.
 */

let nextAdmissionLeaseId = 1;

function createMutationAdmissionRef() {
  return { ownerLease: null };
}

function tryAcquireMutationAdmission(admissionRef) {
  if (!admissionRef) return 0;
  const state = admissionRef.current;
  if (state.ownerLease != null) return null;
  const lease = nextAdmissionLeaseId++;
  state.ownerLease = lease;
  return lease;
}

function releaseMutationAdmission(admissionRef, lease) {
  if (!admissionRef || lease == null || lease === 0) return;
  if (admissionRef.current.ownerLease === lease) {
    admissionRef.current.ownerLease = null;
  }
}

function isMutationAdmissionBlocked(admissionRef) {
  return admissionRef?.current?.ownerLease != null;
}

function resetAdmissionLeaseCounter() {
  nextAdmissionLeaseId = 1;
}

module.exports = {
  createMutationAdmissionRef,
  isMutationAdmissionBlocked,
  releaseMutationAdmission,
  resetAdmissionLeaseCounter,
  tryAcquireMutationAdmission,
};
