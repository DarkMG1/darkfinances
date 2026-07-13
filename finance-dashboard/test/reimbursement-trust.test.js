const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyOwesTruth, directReimbursementLegs } = require('../dataModule');

function snapshot(generatedAt) {
  return {
    schemaVersion: 2,
    generatedAt,
    source: 'splitwise-pairwise (get_friends groups.balance)',
    manifest: {
      complete: true,
      itemizedComplete: true,
      expectedEvents: 1,
      resolvedEvents: 1,
      failedEvents: [],
      currency: 'USD',
    },
    bySlug: { alex: [{ event: 'trip', amount: 25 }] },
    total: 25,
  };
}

test('only complete fresh pairwise snapshots are current truth', () => {
  const now = Date.parse('2026-07-09T18:00:00Z');
  const fresh = snapshot('2026-07-09T17:30:00Z');
  assert.equal(classifyOwesTruth(fresh, { now }).current, fresh);

  const incomplete = snapshot('2026-07-09T17:30:00Z');
  incomplete.manifest.resolvedEvents = 0;
  assert.equal(classifyOwesTruth(incomplete, { now }).warning, 'splitwise-snapshot-incomplete');
  assert.equal(classifyOwesTruth(incomplete, { now }).lastKnown, null);

  const stale = snapshot('2026-07-09T08:00:00Z');
  const classified = classifyOwesTruth(stale, { now });
  assert.equal(classified.current, null);
  assert.equal(classified.lastKnown, stale);
  assert.equal(classified.warning, 'splitwise-snapshot-stale');
});

test('mixed debt suppresses only Splitwise legs, not the entire person', () => {
  const direct = { amount: -10000, label: 'Direct loan', event: null };
  const trip = { amount: -2500, label: 'Cabin', event: 'cabin' };
  const tagged = { amount: -500, label: 'Splitwise settle-up', event: null };
  assert.deepEqual(directReimbursementLegs([direct, trip, tagged]), [direct]);
});
