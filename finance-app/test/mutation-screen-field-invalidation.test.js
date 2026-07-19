const test = require('node:test');
const assert = require('node:assert/strict');
const { invalidateScreenRetryOnFieldEdit } = require('../src/lib/mutation-screen-retry-invalidation');
const { parseStrictAllocationDollars } = require('../src/lib/allocation-parse');

function createLinkScreen() {
  let outcome = { kind: 'validation', fieldErrors: { allocationCents: 'bad' } };
  let activeKey = 'link';
  let lastVars = { allocationCents: parseStrictAllocationDollars('20.00') };
  let cleared = 0;
  const screen = {
    get outcome() { return outcome; },
    get activeKey() { return activeKey; },
    clear() {
      cleared += 1;
      outcome = null;
      activeKey = null;
      lastVars = null;
    },
  };
  return {
    screen,
    get cleared() { return cleared; },
    get lastVars() { return lastVars; },
    retry() { return lastVars; },
  };
}

test('link allocation error then edit invalidates retry; fresh Link uses edited amount', () => {
  const sim = createLinkScreen();
  const snapshot = { allocationText: '20.00' };
  assert.equal(invalidateScreenRetryOnFieldEdit(sim.screen, 'link', snapshot, { allocationText: '20.00' }), false);
  assert.deepEqual(sim.retry(), { allocationCents: 2000 });

  assert.equal(
    invalidateScreenRetryOnFieldEdit(sim.screen, 'link', snapshot, { allocationText: '15.00' }),
    true,
  );
  assert.equal(sim.cleared, 1);
  assert.equal(sim.screen.outcome, null);
  assert.equal(sim.retry(), null);

  const freshCents = parseStrictAllocationDollars('15.00');
  assert.equal(freshCents, 1500);
});

test('date field edit after error clears stale retry payload', () => {
  const screen = {
    outcome: { kind: 'validation' },
    activeKey: 'date',
    cleared: 0,
    clear() { this.outcome = null; this.activeKey = null; this.cleared += 1; },
  };
  const snapshot = { date: '2026-01-01' };
  assert.equal(invalidateScreenRetryOnFieldEdit(screen, 'date', snapshot, { date: '2026-01-01' }), false);
  assert.equal(invalidateScreenRetryOnFieldEdit(screen, 'date', snapshot, { date: '2026-02-02' }), true);
  assert.equal(screen.cleared, 1);
});

test('payee rename field edit after error clears stale retry payload', () => {
  const screen = {
    outcome: { kind: 'network' },
    activeKey: 'payee',
    cleared: 0,
    clear() { this.outcome = null; this.activeKey = null; this.cleared += 1; },
  };
  const snapshot = { payee: 'Old Name' };
  assert.equal(invalidateScreenRetryOnFieldEdit(screen, 'payee', snapshot, { payee: 'New Name' }), true);
  assert.equal(screen.cleared, 1);
});
