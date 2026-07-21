'use strict';

let metadataSyncLegSequence = 0;

function resetMetadataSyncMutationState() {
  metadataSyncLegSequence = 0;
}

function isTemporaryImportedId(value) {
  const normalized = value == null ? '' : String(value);
  return normalized.startsWith('df-replace:') || normalized.startsWith('df-restore:');
}

function markMetadataSyncMutation(row, patch) {
  if (!row?.is_parent || !Object.prototype.hasOwnProperty.call(patch, 'imported_id')) return;
  if (!isTemporaryImportedId(row.imported_id)) return;
  const next = patch.imported_id;
  if (next == null || next === '' || !isTemporaryImportedId(next)) {
    row._pendingMetadataSyncMutation = true;
  }
}

function applyMetadataSyncMutations(rows) {
  for (const row of rows) {
    if (!row?._pendingMetadataSyncMutation || !row.is_parent) continue;
    let legs = Array.isArray(row.subtransactions) ? [...row.subtransactions] : [];
    if (legs.length > 1) legs.reverse();
    row.subtransactions = legs.map((leg) => ({
      ...structuredClone(leg),
      id: `${row.id}-meta-${++metadataSyncLegSequence}`,
      parent_id: row.id,
    }));
    delete row._pendingMetadataSyncMutation;
  }
}

module.exports = {
  applyMetadataSyncMutations,
  markMetadataSyncMutation,
  resetMetadataSyncMutationState,
};
