const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyEditableFinanceDateSync,
  createEditableFinanceDate,
  createEditableFinanceDateState,
  createFinanceDateStore,
  resetFinanceDateStoreForTests,
} = require('../src/lib/finance-date-store');

test('getSnapshot returns referentially stable object until today or zone changes', () => {
  const store = createFinanceDateStore({
    timeZone: 'America/Los_Angeles',
    now: new Date('2026-07-10T06:00:00.000Z'),
  });
  const first = store.getSnapshot();
  const second = store.getSnapshot();
  assert.ok(Object.is(first, second));
  assert.equal(first.today, '2026-07-09');

  store.tick(new Date('2026-07-10T06:00:00.000Z'));
  assert.ok(Object.is(store.getSnapshot(), first));

  store.setNow(new Date('2026-07-10T07:01:00.000Z'));
  const third = store.getSnapshot();
  assert.ok(!Object.is(first, third));
  assert.equal(third.today, '2026-07-10');
  assert.ok(Object.is(store.getSnapshot(), third));
});

test('subscribe notifies only when snapshot values change', () => {
  const store = createFinanceDateStore({
    timeZone: 'America/Los_Angeles',
    now: new Date('2026-07-10T06:00:00.000Z'),
  });
  let calls = 0;
  const unsubscribe = store.subscribe(() => {
    calls += 1;
  });

  store.tick(new Date('2026-07-10T06:30:00.000Z'));
  assert.equal(calls, 0);

  store.setNow(new Date('2026-07-10T07:01:00.000Z'));
  assert.equal(calls, 1);

  store.setTimeZone('America/Los_Angeles');
  assert.equal(calls, 1);

  store.setTimeZone('America/New_York');
  assert.equal(calls, 2);
  unsubscribe();
});

test('applyEditableFinanceDateSync preserves user-edited dates across rollovers', () => {
  const snapshot = { timeZone: 'America/Los_Angeles', today: '2026-07-10', revision: 2 };
  const dirty = createEditableFinanceDateState('2026-07-05');
  dirty.dirty = true;
  dirty.baseline = '2026-07-09';
  assert.deepEqual(applyEditableFinanceDateSync(dirty, snapshot), dirty);

  const synced = createEditableFinanceDateState('2026-07-09');
  assert.deepEqual(applyEditableFinanceDateSync(synced, snapshot), {
    value: '2026-07-10',
    dirty: false,
    baseline: '2026-07-10',
  });
});

test('mocked server zone change updates unedited defaults', () => {
  resetFinanceDateStoreForTests();
  const instant = new Date('2026-07-10T06:00:00.000Z');
  const store = createFinanceDateStore({ timeZone: 'America/Los_Angeles', now: instant });
  const field = createEditableFinanceDate(store);
  assert.equal(field.getValue(), '2026-07-09');

  store.setTimeZone('America/New_York');
  assert.equal(field.getValue(), '2026-07-10');

  field.setValue('2026-07-05');
  store.setTimeZone('America/Los_Angeles');
  assert.equal(field.getValue(), '2026-07-05');
  field.dispose();
});

test('finance midnight rollover refreshes unedited defaults', () => {
  resetFinanceDateStoreForTests();
  const store = createFinanceDateStore({
    timeZone: 'America/Los_Angeles',
    now: new Date('2026-07-10T06:59:00.000Z'),
  });
  const field = createEditableFinanceDate(store);
  assert.equal(field.getValue(), '2026-07-09');

  store.setNow(new Date('2026-07-10T07:01:00.000Z'));
  assert.equal(field.getValue(), '2026-07-10');

  field.setValue('2026-07-07');
  store.setNow(new Date('2026-07-11T07:01:00.000Z'));
  assert.equal(field.getValue(), '2026-07-07');
  field.dispose();
});

test('ping propagation contract updates store revision and today', () => {
  resetFinanceDateStoreForTests();
  const instant = new Date('2026-07-10T06:00:00.000Z');
  const store = createFinanceDateStore({ timeZone: 'America/Los_Angeles', now: instant });
  const seen = [];
  store.subscribe(() => seen.push(store.getSnapshot()));

  store.setTimeZone('America/New_York');
  assert.equal(seen.at(-1)?.timeZone, 'America/New_York');
  assert.equal(seen.at(-1)?.today, '2026-07-10');
  assert.ok(seen.at(-1)?.revision >= 1);
});
