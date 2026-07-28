'use strict';

/**
 * Production restore mode is signaled by explicit boolean dryRun on the restore CLI contract:
 * - staged restore preview: dryRun=true (default, --dry-run)
 * - staged restore live: dryRun=false (--confirm / CONFIRM=1 without --dry-run)
 * - coordinated restore preview: dryRun=true (RESTORE_DRY_RUN=1 / --dry-run)
 * - coordinated restore live: dryRun=false (RESTORE_DRY_RUN unset, no --dry-run)
 */
function assertExplicitRestoreAdmissionMode(options = {}) {
  if (typeof options.dryRun !== 'boolean') {
    throw new Error('restore refused: explicit boolean dryRun mode is required for quiescence admission');
  }
}

function isLiveRestoreAdmission(options = {}) {
  assertExplicitRestoreAdmissionMode(options);
  return options.dryRun === false;
}

function resolveRestoreAdmissionTransportPolicy(options = {}) {
  assertExplicitRestoreAdmissionMode(options);
  const liveRestore = options.dryRun === false;
  const devOptIn = options.allowInlineAdmissionToken === true;
  return {
    liveRestore,
    requireTrustedFile: liveRestore || !devOptIn,
    allowInlineEnv: !liveRestore && devOptIn,
    allowDirectInjection: !liveRestore && devOptIn,
  };
}

function refuseInlineAdmissionTransport() {
  throw new Error(
    'restore refused: inline quiescence admission transport is not permitted; use RESTORE_QUIESCENCE_ADMISSION_PATH',
  );
}

function refuseTrustedAdmissionFileRequired() {
  throw new Error(
    'restore refused: trusted admission file path required (RESTORE_QUIESCENCE_ADMISSION_PATH)',
  );
}

module.exports = {
  assertExplicitRestoreAdmissionMode,
  isLiveRestoreAdmission,
  resolveRestoreAdmissionTransportPolicy,
  refuseInlineAdmissionTransport,
  refuseTrustedAdmissionFileRequired,
};
