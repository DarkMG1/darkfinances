const test = require('node:test');
const assert = require('node:assert/strict');
const {
  handleFinanceDateAppStateChange,
  subscribeFinanceDateAppState,
} = require('../src/lib/finance-date-app-state');
const { createFinanceDateStore } = require('../src/lib/finance-date-store');

function createMockAppState(initial = 'active') {
  const listeners = new Set();
  const api = {
    currentState: initial,
    addEventListener(_event, listener) {
      listeners.add(listener);
      return {
        remove() {
          listeners.delete(listener);
        },
      };
    },
    emit(next) {
      for (const listener of listeners) listener(next);
    },
  };
  return api;
}

test('active transition ticks store with current clock', () => {
  const store = createFinanceDateStore({
    timeZone: 'America/Los_Angeles',
    now: new Date('2026-07-10T06:59:00.000Z'),
  });
  assert.equal(store.getSnapshot().today, '2026-07-09');

  handleFinanceDateAppStateChange(
    'background',
    'active',
    store,
    () => new Date('2026-07-10T07:01:00.000Z'),
  );
  assert.equal(store.getSnapshot().today, '2026-07-10');
});

test('non-active transitions do not tick the store', () => {
  const store = createFinanceDateStore({
    timeZone: 'America/Los_Angeles',
    now: new Date('2026-07-10T06:59:00.000Z'),
  });
  let ticks = 0;
  const originalTick = store.tick.bind(store);
  store.tick = (nextNow = new Date()) => {
    ticks += 1;
    return originalTick(nextNow);
  };

  handleFinanceDateAppStateChange('active', 'background', store);
  handleFinanceDateAppStateChange('background', 'inactive', store);
  assert.equal(ticks, 0);
});

test('foreground after Pacific midnight advances snapshot before interval timer', () => {
  const store = createFinanceDateStore({
    timeZone: 'America/Los_Angeles',
    now: new Date('2026-07-10T06:59:00.000Z'),
  });
  const appState = createMockAppState('active');
  let clock = new Date('2026-07-10T06:59:00.000Z');
  const unsubscribe = subscribeFinanceDateAppState(store, appState, () => clock);

  assert.equal(store.getSnapshot().today, '2026-07-09');

  appState.emit('background');
  assert.equal(store.getSnapshot().today, '2026-07-09');

  clock = new Date('2026-07-10T07:01:00.000Z');
  appState.emit('active');
  assert.equal(store.getSnapshot().today, '2026-07-10');

  clock = new Date('2026-07-10T08:00:00.000Z');
  store.tick(clock);
  assert.equal(store.getSnapshot().today, '2026-07-10');

  unsubscribe();
  appState.emit('active');
  assert.equal(store.getSnapshot().today, '2026-07-10');
});
