/**
 * Snapshot + dirty detection for the split transaction editor.
 */

function snapshotSplitEditor(mode, legs) {
  return JSON.stringify({
    mode,
    legs: (legs ?? []).map((l) => ({
      id: l.id ?? null,
      catId: l.catId,
      catName: l.catName,
      name: l.name,
      notes: l.notes,
      amt: l.amt,
      pct: l.pct,
    })),
  });
}

function isSplitEditorDirty(mode, legs, baselineSnapshot) {
  if (baselineSnapshot == null) return false;
  return snapshotSplitEditor(mode, legs) !== baselineSnapshot;
}

function seedSplitEditorBaseline(mode, legs) {
  return snapshotSplitEditor(mode, legs);
}

module.exports = {
  isSplitEditorDirty,
  seedSplitEditorBaseline,
  snapshotSplitEditor,
};
