const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeEvent, parseCsv } = require('../venmo-import');

test('CSV parser handles quoted commas and rejects unterminated fields', () => {
  assert.deepEqual(parseCsv('Type,Note\nCharge,\"Dinner, drinks\"\n'), [
    ['Type', 'Note'],
    ['Charge', 'Dinner, drinks'],
  ]);
  assert.throws(() => parseCsv('Type,Note\nCharge,\"Dinner'), /quoted field/);
});

test('event imports replace only that event and preserve other Venmo debts', () => {
  const existing = {
    bySlug: {
      alex: [{ event: 'Trip A', amount: 10 }],
      sam: [{ event: 'Trip B', amount: 20 }],
    },
    people: [
      { slug: 'alex', name: 'Alex Example', owed: 10 },
      { slug: 'sam', name: 'Sam Example', owed: 20 },
    ],
    imports: { 'Trip A': { sourceFile: 'old.csv' } },
  };
  const merged = mergeEvent(existing, 'Trip A', {
    generatedAt: '2026-07-10T00:00:00.000Z',
    sourceFile: 'new.csv',
    settledNet: {},
    bySlug: { alex: [{ event: 'Trip A', amount: 15 }] },
    people: [{ slug: 'alex', name: 'Alex Example', owed: 15 }],
  });
  assert.deepEqual(merged.bySlug.alex, [{ event: 'Trip A', amount: 15 }]);
  assert.deepEqual(merged.bySlug.sam, [{ event: 'Trip B', amount: 20 }]);
  assert.equal(merged.imports['Trip A'].sourceFile, 'new.csv');
});

test('merge rejects identity collisions instead of combining two people', () => {
  assert.throws(
    () => mergeEvent(
      { bySlug: { alex: [{ event: 'Old', amount: 1 }] }, people: [{ slug: 'alex', name: 'Alex One' }] },
      'New',
      { generatedAt: 'now', sourceFile: 'new.csv', settledNet: {}, bySlug: { alex: [{ event: 'New', amount: 2 }] }, people: [{ slug: 'alex', name: 'Alex Two' }] },
    ),
    /identity collision/
  );
});
