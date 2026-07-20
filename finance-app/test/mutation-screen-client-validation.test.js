const test = require('node:test');
const assert = require('node:assert/strict');
const { buildScreenClientValidationOutcome } = require('../src/lib/mutation-screen-client-validation');
const { invalidateScreenRetryOnFieldEdit } = require('../src/lib/mutation-screen-retry-invalidation');
const { resolveTransactionDateAttempt } = require('../src/lib/mutation-transaction-date-attempt');

test('client validation with link action key sets activeKey and inline allocation error', () => {
  const registry = new Map([
    ['link', { lastVars: { allocationCents: 2000 }, lastSuccess: () => {}, lastSettled: undefined, lastError: undefined, rollback: undefined }],
  ]);
  const next = buildScreenClientValidationOutcome(
    'Enter a positive dollar amount with at most two decimal places (e.g. 20.00).',
    { allocationCents: 'Invalid allocation amount.' },
    ['allocationCents'],
    'link',
    registry,
  );
  assert.equal(next.activeKey, 'link');
  assert.equal(next.outcome.fieldErrors.allocationCents, 'Invalid allocation amount.');
  assert.equal(next.outcome.firstField, 'allocationCents');
  assert.equal(registry.get('link').lastVars, null);
});

test('client validation with date action key sets activeKey and clears stale retry vars', () => {
  const registry = new Map([
    ['date', { lastVars: { date: '2026-06-15' }, lastSuccess: undefined, lastSettled: undefined, lastError: undefined, rollback: undefined }],
  ]);
  const next = buildScreenClientValidationOutcome(
    'Use the format YYYY-MM-DD, e.g. 2026-06-30.',
    { date: 'Invalid date format.' },
    ['date'],
    'date',
    registry,
  );
  assert.equal(next.activeKey, 'date');
  assert.equal(next.outcome.fieldErrors.date, 'Invalid date format.');
  assert.equal(next.outcome.firstField, 'date');
  assert.equal(registry.get('date').lastVars, null);
});

test('grid date attempt commits picked day to local dateText before dispatch', () => {
  const currentDate = '2026-01-01';
  const dateText = currentDate;
  const picked = '2026-06-15';
  const attempt = resolveTransactionDateAttempt(dateText, picked);
  assert.equal(attempt.next, picked);
  assert.equal(attempt.dateText, picked);
});

test('grid date A error then choose B clears retry for A and fresh dispatch uses B', () => {
  const currentDate = '2026-01-01';
  let dateText = currentDate;
  let outcome = { kind: 'network' };
  let activeKey = 'date';
  let lastVars = { id: 'txn-1', date: '2026-06-15', isLeg: false };
  let lastDispatch = null;
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

  const attemptA = resolveTransactionDateAttempt(dateText, '2026-06-15');
  dateText = attemptA.dateText;
  lastVars = { id: 'txn-1', date: attemptA.next, isLeg: false };

  assert.equal(dateText, '2026-06-15');
  assert.deepEqual(lastVars, { id: 'txn-1', date: '2026-06-15', isLeg: false });

  const attemptB = resolveTransactionDateAttempt(dateText, '2026-06-20');
  assert.equal(
    invalidateScreenRetryOnFieldEdit(screen, 'date', { date: '2026-06-15' }, { date: attemptB.dateText }),
    true,
  );
  assert.equal(cleared, 1);
  assert.equal(screen.outcome, null);
  assert.equal(lastVars, null);

  dateText = attemptB.dateText;
  lastDispatch = { id: 'txn-1', date: attemptB.next, isLeg: false };
  assert.deepEqual(lastDispatch, { id: 'txn-1', date: '2026-06-20', isLeg: false });
});
