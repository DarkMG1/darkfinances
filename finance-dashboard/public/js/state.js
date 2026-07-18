export const state = {
  month: null,
  accountFilter: null,
  categoryFilter: null,
  txnFilter: 'all',
  txnPage: 50,
  netWorth: null,
  netWorthAuthoritative: false,
  netWorthHasServerMetric: false,
  netWorthIncompleteReasons: [],
  trendFirstNW: null,
  trendMonths: null,
};

export let allTxns = [];
export let categories = [];
export let accounts = [];
export let goalsData = [];

const chartRefs = {
  spending: null,
  netWorth: null,
  ive: null,
};

export function setAllTxns(value) {
  allTxns = value;
}

export function setCategories(value) {
  categories = value;
}

export function setAccounts(value) {
  accounts = value;
}

export function setGoalsData(value) {
  goalsData = value;
}

export function destroyChart(key) {
  if (chartRefs[key]) {
    chartRefs[key].destroy();
    chartRefs[key] = null;
  }
}

export function setChart(key, instance) {
  chartRefs[key] = instance;
}
