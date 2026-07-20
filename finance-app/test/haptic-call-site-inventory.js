/**
 * Authoritative inventory for mutation outcome haptic ownership (PR-40 / L5).
 * Behavioral tests import this list — do not rely on ad-hoc regex alone.
 */

/** Where generic mutation success/warning haptics are emitted. */
const OUTCOME_HAPTIC_OWNER = 'src/api/client/requests.ts (useFinanceMutation via mutationOutcomeHaptics)';

/** Caller-layer outcome haptics removed in PR-40 (request layer owns these). */
const REMOVED_CALLER_OUTCOME_HAPTICS = [
  { file: 'src/app/transaction/[id].tsx', removed: 'haptics.success() in delete/receipt/date onSuccess' },
  { file: 'src/app/split/[id].tsx', removed: 'haptics.success() in split/unsplit onSuccess' },
  { file: 'src/app/review.tsx', removed: 'haptics.success() in setDisposition onSuccess' },
  { file: 'src/app/reimbursement.tsx', removed: 'haptics.success() in confirm onSuccess' },
  { file: 'src/app/(tabs)/index.tsx', removed: 'haptics.success/warning in bankSync callbacks' },
];

/**
 * Screen-level semantic haptics that are NOT duplicate mutation outcome ownership.
 * Each must be justified; tap/selection haptics are unrestricted and not listed.
 */
const DOCUMENTED_SEMANTIC_EXCEPTIONS = [
  {
    file: 'src/app/transaction/[id].tsx',
    pattern: 'haptics.warning()',
    reason: 'Destructive delete confirmation dialog — pre-mutation semantic cue, not mutation outcome.',
  },
  {
    file: 'src/app/(tabs)/transactions.tsx',
    pattern: 'haptics.warning()',
    reason: 'CSV export uses buildQuery (GET), not useFinanceMutation — local failure feedback.',
  },
];

/** Files that must never call haptics.success/warning inside mutation callback blocks. */
const MUTATION_CALLBACK_SCAN_ROOTS = [
  'src/app',
];

module.exports = {
  OUTCOME_HAPTIC_OWNER,
  REMOVED_CALLER_OUTCOME_HAPTICS,
  DOCUMENTED_SEMANTIC_EXCEPTIONS,
  MUTATION_CALLBACK_SCAN_ROOTS,
};
