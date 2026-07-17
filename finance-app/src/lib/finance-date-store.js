const {
  DEFAULT_FINANCE_TIME_ZONE,
  configureFinanceTimeZone,
  financeTodayAt,
  getFinanceTimeZone,
} = require('./finance-date-core');

function createFinanceDateStore(options = {}) {
  let timeZone = options.timeZone ?? getFinanceTimeZone();
  let revision = 0;
  let now = options.now instanceof Date ? options.now : new Date();
  let today = financeTodayAt(now, timeZone);
  let snapshot = Object.freeze({ timeZone, today, revision });
  const listeners = new Set();

  const publishIfChanged = () => {
    if (snapshot.timeZone === timeZone && snapshot.today === today) return false;
    revision += 1;
    snapshot = Object.freeze({ timeZone, today, revision });
    return true;
  };

  const notify = () => {
    if (!publishIfChanged()) return;
    for (const listener of listeners) listener();
  };

  const syncToday = () => {
    const nextToday = financeTodayAt(now, timeZone);
    if (nextToday === today) return;
    today = nextToday;
    notify();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return snapshot;
    },
    setTimeZone(zone) {
      const nextZone = configureFinanceTimeZone(zone);
      const nextToday = financeTodayAt(now, nextZone);
      const changed = nextZone !== timeZone || nextToday !== today;
      timeZone = nextZone;
      today = nextToday;
      if (changed) notify();
    },
    tick(nextNow = new Date()) {
      now = nextNow instanceof Date ? nextNow : new Date(nextNow);
      syncToday();
    },
    setNow(nextNow) {
      now = nextNow instanceof Date ? nextNow : new Date(nextNow);
      syncToday();
    },
  };
}

let defaultStore = null;

function getFinanceDateStore(options) {
  if (!defaultStore) defaultStore = createFinanceDateStore(options);
  return defaultStore;
}

function resetFinanceDateStoreForTests() {
  defaultStore = null;
  configureFinanceTimeZone(DEFAULT_FINANCE_TIME_ZONE);
}

function createEditableFinanceDateState(initialToday) {
  return { value: initialToday, dirty: false, baseline: initialToday };
}

function applyEditableFinanceDateSync(state, snapshot) {
  if (state.dirty) return state;
  if (state.value === state.baseline) {
    if (state.value === snapshot.today) return state;
    return { value: snapshot.today, dirty: false, baseline: snapshot.today };
  }
  if (state.baseline === snapshot.today) return state;
  return { ...state, baseline: snapshot.today };
}

function createEditableFinanceDate(store, initialToday = store.getSnapshot().today) {
  let state = createEditableFinanceDateState(initialToday);

  const syncFromStore = () => {
    state = applyEditableFinanceDateSync(state, store.getSnapshot());
  };

  const unsubscribe = store.subscribe(syncFromStore);

  return {
    getValue() {
      return state.value;
    },
    getState() {
      return state;
    },
    setValue(next) {
      state = { ...state, value: next, dirty: true };
    },
    isDirty() {
      return state.dirty;
    },
    resetToToday() {
      const { today } = store.getSnapshot();
      state = { value: today, dirty: false, baseline: today };
    },
    dispose() {
      unsubscribe();
    },
  };
}

module.exports = {
  DEFAULT_FINANCE_TIME_ZONE,
  applyEditableFinanceDateSync,
  createEditableFinanceDate,
  createEditableFinanceDateState,
  createFinanceDateStore,
  getFinanceDateStore,
  resetFinanceDateStoreForTests,
};
