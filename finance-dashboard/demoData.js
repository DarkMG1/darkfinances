// demoData.js — fully synthetic dataset for "Demo Mode".
// Returns the same shapes as dataModule.js but never touches Actual or real data,
// so the dashboard / app can be shown to other people safely. Dates are computed
// relative to "today" on each call so the demo always looks current.

const { metricValue } = require('./lib/metric-provenance');
const { safeToSpendIncompleteReasons } = require('./lib/safe-to-spend');
const {
  buildObligationGraph,
  forecastCashEventsFromGraph,
  graphSummary,
  safeToSpendFromGraph,
} = require('./lib/domain/obligation-graph');
const { assembleObligationGraphInputs, buildGraphTransactionInputs } = require('./lib/obligation-graph-bridge');
const {
  buildCategoryInfo,
  buildTransferIndex,
  classifyTransactionLeaves,
  hasActualTransferIdentity,
  leafCountsAsRealSpend,
  transactionLeaves,
} = require('./lib/domain/classification');
const { spendSummaryFromClassifiedLeaves, mergeProjectionCompleteness } = require('./lib/domain/projection-completeness');
const { addDays, addMonths, daysBetween, daysInMonth, monthEnd, shiftMonth, todayYMD } = require('./lib/date-only');
const {
  inferRecurrenceSchedule,
  nextOccurrenceAfter,
  renewalWindow,
} = require('./lib/recurrence');
const { projectAllocationLedger } = require('./lib/reimbursement-export-ledger');

const pad2 = (n) => String(n).padStart(2, '0');
const anchorDate = () => (process.env.DEMO_FINANCE_NOW ? new Date(process.env.DEMO_FINANCE_NOW) : new Date());
const financeAnchor = () => todayYMD(anchorDate());
const dayOfFinanceMonth = (anchor = financeAnchor()) => Number(anchor.slice(8, 10));
const ymd = (d) => {
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  return todayYMD(d instanceof Date ? d : new Date(d));
};
const monthKey = (d) => ymd(d).slice(0, 7);
const round2 = (n) => Math.round(n * 100) / 100;
function daysAgo(n) { return addDays(financeAnchor(), -n); }
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const recurKey = (p) => (p || '').toLowerCase().replace(/[#*]?\d{3,}/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const currentMonth = () => financeAnchor().slice(0, 7);
const categoryById = (id) => categories().find((c) => c.id === id) || null;
const categoryByName = (name) => categories().find((c) => c.name.toLowerCase() === String(name || '').toLowerCase()) || null;
const monthStart = (month) => `${month}-01`;

// ---- Accounts -------------------------------------------------------------
const ACCOUNTS = [
  { id: 'acc-check', name: 'Everyday Checking', offbudget: false, balance: 4820.55, role: 'operating_cash', roleSource: 'explicit' },
  { id: 'acc-save', name: 'High-Yield Savings', offbudget: false, balance: 18450.00, role: 'protected_savings', roleSource: 'explicit' },
  { id: 'acc-credit', name: 'Sapphire Card', offbudget: false, balance: -1240.30, role: 'credit_card', roleSource: 'explicit' },
  { id: 'acc-invest', name: 'Brokerage', offbudget: true, balance: 32160.75, role: 'investment', roleSource: 'explicit' },
  { id: 'acc-roth', name: 'Roth IRA', offbudget: true, balance: 21300.00, role: 'investment', roleSource: 'explicit' },
];
const accounts = () => ACCOUNTS.map((a) => ({ ...a }));

// ---- Categories -----------------------------------------------------------
const CATS = [
  ['Salary', 'Income'], ['Interest', 'Income'],
  ['Rent', 'Housing'],
  ['Groceries', 'Food'], ['Dining', 'Food'], ['Coffee', 'Food'],
  ['Gas', 'Transport'], ['Rideshare', 'Transport'], ['Parking', 'Transport'],
  ['Electric', 'Bills & Utilities'], ['Internet', 'Bills & Utilities'], ['Phone', 'Bills & Utilities'],
  ['Streaming', 'Subscriptions'], ['Software', 'Subscriptions'], ['Cloud', 'Subscriptions'],
  ['Shopping', 'Shopping'], ['Electronics', 'Shopping'],
  ['Gym', 'Health'], ['Pharmacy', 'Health'],
  ['Entertainment', 'Entertainment'], ['Travel', 'Travel'],
  ['Transfer', 'Money Movement'],
];
const DEMO_CLASSIFIER_PATTERNS = {
  incomeGroup: /^income$/i,
  moneyMovementGroup: /money movement/i,
  moneyMovementCategory: /^(transfers?|investments?|credit\s*card\s*payments?|cc\s*payments?)$/i,
  reimbursementCategory: /^reimbursement$/i,
};
const demoCategoryInfo = () => buildCategoryInfo(
  [{ name: 'Income', is_income: true, categories: [{ id: catId('Salary'), name: 'Salary' }, { id: catId('Interest'), name: 'Interest' }] },
    { name: 'Money Movement', categories: [{ id: catId('Transfer'), name: 'Transfer' }] },
    ...Array.from(new Set(CATS.map(([, group]) => group))).filter((g) => g !== 'Income' && g !== 'Money Movement').map((group) => ({
      name: group,
      categories: CATS.filter(([, g]) => g === group).map(([name]) => ({ id: catId(name), name })),
    }))],
  DEMO_CLASSIFIER_PATTERNS,
);
const catId = (name) => 'cat-' + name.toLowerCase().replace(/[^a-z]+/g, '-');
const categories = () => CATS.map(([name, group]) => ({ id: catId(name), name, group }));

// ---- Recurring / Subscriptions -------------------------------------------
function buildSub(payee, category, amount, daysSinceLast, occ, priceFrom) {
  const last = ymd(daysAgo(daysSinceLast));
  const history = [];
  for (let k = occ - 1; k >= 0; k--) history.push({ date: addMonths(last, -k), amount: priceFrom && k >= 2 ? priceFrom : amount });
  const schedule = inferRecurrenceSchedule({
    cadence: 'monthly',
    dates: history.map((entry) => entry.date),
    forced: true,
  });
  const nextRenewal = nextOccurrenceAfter(last, schedule);
  const priceChange = priceFrom && priceFrom !== amount
    ? { from: round2(priceFrom), to: round2(amount), pct: Math.round(((amount - priceFrom) / priceFrom) * 100) } : null;
  return {
    key: recurKey(payee), payee, category, cadence: 'monthly', amount: round2(amount), monthlyEquivalent: round2(amount),
    isBill: /rent|mortgage|phone|internet|cable|utilit|electric|water|\bgas\b|sewer|trash|insuranc|\bloan/i.test(category),
    occurrences: occ, firstCharged: history[0].date, lastCharged: last, nextRenewal,
    renewalWindow: renewalWindow(nextRenewal),
    priceChange, status: 'active', hidden: false, history,
  };
}
function activeSubs() {
  const cardPayment = buildSub('Sapphire Card Payment', 'Transfer', 1240.3, 4, 6);
  cardPayment.isBill = true;
  cardPayment.key = recurKey('Sapphire Card Payment');
  return [
    buildSub('Skyline Apartments', 'Rent', 2100, 2, 12),
    cardPayment,
    buildSub('Verizon Wireless', 'Phone', 85.0, 6, 11),
    buildSub('City Fiber Internet', 'Internet', 69.99, 14, 10),
    buildSub('Adobe Creative Cloud', 'Software', 54.99, 12, 9),
    buildSub('Planet Fitness', 'Gym', 24.99, 22, 7),
    buildSub('Netflix', 'Streaming', 15.49, 8, 8, 11.99),
    buildSub('Spotify', 'Streaming', 11.99, 19, 10),
    buildSub('iCloud+', 'Cloud', 2.99, 3, 12),
  ];
}
function recurring() {
  const cancelled = buildSub('HBO Max', 'Streaming', 15.99, 96, 6);
  cancelled.status = 'inactive';
  const all = [...activeSubs(), cancelled].sort((a, b) => b.monthlyEquivalent - a.monthlyEquivalent);
  const active = all.filter((i) => i.status === 'active');
  const monthlyTotal = round2(active.reduce((s, i) => s + i.monthlyEquivalent, 0));
  const subsActive = active.filter((i) => !i.isBill);
  const billsActive = active.filter((i) => i.isBill);
  return {
    items: all,
    monthlyTotal,
    annualTotal: round2(monthlyTotal * 12),
    activeCount: active.length,
    count: all.length,
    subMonthlyTotal: round2(subsActive.reduce((s, i) => s + i.monthlyEquivalent, 0)),
    subActiveCount: subsActive.length,
    billMonthlyTotal: round2(billsActive.reduce((s, i) => s + i.monthlyEquivalent, 0)),
    billActiveCount: billsActive.length,
  };
}
function bills() {
  const today = financeAnchor();
  const within = [];
  for (const it of activeSubs()) {
    if (!it.isBill) continue; // bills view = true bills only (rent/utilities/phone/internet)
    if (!it.nextRenewal) continue;
    const diff = daysBetween(today, it.nextRenewal);
    if (diff >= 0 && diff <= 45) within.push({ id: `${it.key}|${it.nextRenewal}`, key: it.key, payee: it.payee, amount: it.amount, dueDate: it.nextRenewal, category: it.category, cadence: it.cadence, paid: false, paidDate: null, matched: null });
  }
  within.sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
  return { bills: within, total: round2(within.reduce((s, b) => s + b.amount, 0)), count: within.length, unpaidCount: within.length, horizonDays: 45 };
}

function today() {
  const asOf = new Date().toISOString();
  const financeDate = financeAnchor();
  const monthEndDate = monthEnd(financeDate.slice(0, 7));
  const allAccounts = accounts();
  const cash = allAccounts.filter((account) => account.role === 'operating_cash');
  const cashCents = Math.round(cash.reduce((sum, account) => sum + account.balance, 0) * 100);
  const upcoming = bills();
  const recurringData = recurring();
  const incomeData = income();
  const currentSpending = spending({});
  const inbox = review();
  const graphTxnInputs = buildGraphTransactionInputs(
    transactions().map((t) => actualRowFromDemoTransaction(t)),
    demoCategoryInfo(),
    {
      windowStart: financeDate,
      windowEnd: monthEndDate,
      accountRolesById: Object.fromEntries(allAccounts.map((account) => [account.id, account.role])),
    },
  );
  const graphInputs = assembleObligationGraphInputs({
    financeDate,
    windowStart: financeDate,
    windowEnd: monthEndDate,
    accounts: allAccounts,
    accountOverrides: {
      'acc-credit': {
        creditLiabilityCoverage: 'current_balance',
        paymentRecurringKey: 'sapphire card payment',
        fundingAccountId: 'acc-check',
      },
    },
    recurring: recurringData,
    income: incomeData,
    bills: upcoming,
    budgets: { supported: false },
    reimb: { totalOwed: 0 },
    operatingAccountIds: cash.map((account) => account.id),
    transfers: graphTxnInputs.transfers,
    economicTransactions: graphTxnInputs.economicTransactions,
  });
  const graph = buildObligationGraph(graphInputs);
  const stfFromGraph = safeToSpendFromGraph(graph, {
    operatingCashCents: cashCents,
    monthStart: financeDate,
    monthEnd: monthEndDate,
  });
  const incompleteReasons = safeToSpendIncompleteReasons({
    accounts: allAccounts,
    visibleAccounts: allAccounts,
    operatingAccounts: cash,
    budgets: { supported: false },
    recurring: recurringData,
    goals: goals(),
    spendingCompleteness: currentSpending.current?.completeness,
    obligationGraph: graph,
    liabilityPolicies: graphInputs.liabilityPolicies,
  });
  const safeToSpend = metricValue({
    metric: 'safe_to_spend',
    value: incompleteReasons.length === 0 && Number.isSafeInteger(stfFromGraph.valueCents)
      ? stfFromGraph.valueCents / 100
      : null,
    valueCents: incompleteReasons.length === 0 && Number.isSafeInteger(stfFromGraph.valueCents)
      ? stfFromGraph.valueCents
      : null,
    complete: incompleteReasons.length === 0,
    incompleteReasons,
    asOf,
    financeDate,
    sources: cash.map((account) => ({ type: 'actual-account', id: account.id, role: account.role })),
    method: stfFromGraph.method,
    excludes: ['possible reimbursements'],
  });
  return {
    asOf,
    financeDate,
    revision: `demo-${currentMonth()}`,
    complete: safeToSpend.complete && currentSpending.current?.completeness?.complete !== false,
    incompleteReasons: [...new Set([
      ...safeToSpend.incompleteReasons,
      ...(currentSpending.current?.completeness?.complete === false ? currentSpending.current.completeness.incompleteReasons : []),
    ])],
    health: { ready: true, initializedAt: asOf, lastSyncAt: asOf, lastErrorAt: null, lastError: null },
    accounts: allAccounts,
    spending: currentSpending,
    liquidity: { safeToSpend },
    obligationGraph: {
      version: graph.version,
      summary: graphSummary(graph),
      completeness: graph.completeness,
      reservations: (stfFromGraph.reservations || []).slice(0, 12),
    },
    obligations: {
      bills: upcoming.bills.slice(0, 5),
      nextIncome: incomeData.streams[0] || null,
      source: graph.completeness.complete ? 'obligation-graph' : 'inferred',
      reserved: (stfFromGraph.reservations || []).slice(0, 8),
    },
    review: inbox,
    activity: { recent: transactions().slice(0, 8) },
  };
}

// ---- Income / paycheck streams -------------------------------------------
function income() {
  const lastPay = ymd(daysAgo(1));
  const payHist = [];
  for (let k = 5; k >= 0; k--) payHist.push({ date: addDays(lastPay, -k * 14), amount: 3250 });
  const payNext = addDays(lastPay, 14);
  const payMonthly = round2(3250 * (30.44 / 14));

  const intLast = ymd(daysAgo(6));
  const intHist = [];
  for (let k = 5; k >= 0; k--) intHist.push({ date: addDays(intLast, -k * 30), amount: 12.4 });
  const intNext = addDays(intLast, 30);

  const streams = [
    {
      key: recurKey('Acme Corp Payroll'), payee: 'Acme Corp Payroll', category: 'Salary',
      cadence: 'biweekly', amount: 3250, monthlyEquivalent: payMonthly, occurrences: 6,
      lastPaid: lastPay, nextPay: payNext, active: true, history: payHist,
    },
    {
      key: 'interest', payee: 'Interest', category: 'Income',
      cadence: 'monthly', amount: 12.4, monthlyEquivalent: 12.4, occurrences: 6,
      lastPaid: intLast, nextPay: intNext, active: true, history: intHist,
    },
  ];
  const active = streams.filter((s) => s.active);
  const monthlyTotal = round2(active.reduce((s, x) => s + x.monthlyEquivalent, 0));
  const nextPayday = active.map((s) => s.nextPay).sort()[0];
  const nextStream = active.find((s) => s.nextPay === nextPayday);
  const primary = active[0];
  return {
    streams, activeCount: active.length, count: streams.length,
    monthlyTotal, annualTotal: round2(monthlyTotal * 12),
    nextPayday, nextPaydayAmount: nextStream.amount, nextPaydayPayee: nextStream.payee,
    primaryPayee: primary.payee, primaryAmount: primary.amount,
    primaryMonthly: primary.monthlyEquivalent, primaryCadence: primary.cadence,
    primaryNextPay: primary.nextPay,
  };
}

// ---- Goals ----------------------------------------------------------------
function goals() {
  const mk = (id, name, target, current, accountId, deadline) => ({ id, name, target, accountId: accountId || null, deadline: deadline || null, current: round2(current), pct: Math.round((current / target) * 100) });
  return [
    mk('goal-ef', 'Emergency Fund', 20000, 18450, 'acc-save'),
    mk('goal-jp', 'Japan Trip', 6000, 2750, null, ymd(daysAgo(-150))),
    mk('goal-mac', 'New MacBook', 2500, 1100, null),
  ];
}

// ---- Spending (this month + prev) -----------------------------------------
function summarizeTxns(start, end) {
  const catInfo = demoCategoryInfo();
  const allRows = transactions().map((t) => actualRowFromDemoTransaction(t));
  const transferIndex = buildTransferIndex(allRows);
  const classified = transactions()
    .filter((t) => (!start || t.date >= start) && (!end || t.date <= end))
    .flatMap((t) => {
      const row = actualRowFromDemoTransaction(t);
      return classifyTransactionLeaves(row.transaction, catInfo, { accountId: row.accountId, transferIndex });
    });
  return spendSummaryFromClassifiedLeaves(classified);
}

function actualRowFromDemoTransaction(t) {
  const subtransactions = Array.isArray(t.subtransactions) ? t.subtransactions : null;
  return {
    transaction: {
      id: t.id,
      is_parent: !!subtransactions?.length,
      amount: Math.round((t.amount || 0) * 100),
      category: t.categoryId,
      notes: t.notes,
      transfer_id: t.transferId || null,
      transferred_id: t.transferredId || null,
      subtransactions: subtransactions?.map((leg) => ({
        id: leg.id,
        amount: Math.round((leg.amount || 0) * 100),
        category: leg.categoryId,
        notes: leg.notes,
        transfer_id: leg.transferId || null,
        transferred_id: leg.transferredId || null,
      })),
    },
    accountId: t.accountId,
  };
}

function spending(opts = {}) {
  const anchor = financeAnchor();
  let start = opts.start;
  let end = opts.end;
  let key = opts.month || currentMonth();
  if (!start || !end) {
    key = opts.month || currentMonth();
    start = monthStart(key);
    end = opts.month ? monthEnd(key) : anchor;
  }
  const span = Math.max(1, daysBetween(start, end) + 1);
  const prevEnd = addDays(start, -1);
  const prevStart = addDays(prevEnd, -(span - 1));
  const current = summarizeTxns(start, end);
  const previous = summarizeTxns(prevStart, prevEnd);
  return {
    current,
    prev: previous,
    month: key || start.slice(0, 7),
    completeness: mergeProjectionCompleteness([current.completeness, previous.completeness]),
  };
}

// ---- Trends (up to 36 months) ---------------------------------------------
function trends(n = 12) {
  const out = [];
  let nw = 59000;
  const anchorMonth = currentMonth();
  for (let i = 35; i >= 0; i--) {
    const month = shiftMonth(anchorMonth, -i);
    const rnd = mulberry32(1000 + i);
    const income = 6500 + (i % 6 === 0 ? 1600 : 0) + Math.round(rnd() * 80);
    const spend = 4300 + Math.round(rnd() * 1100);
    const net = income - spend;
    nw += net * 0.22 + (rnd() * 240 - 60);
    out.push({ month, netWorth: round2(nw), spend: round2(spend), income: round2(income), net: round2(net) });
  }
  return { months: out.slice(36 - Math.min(36, Math.max(3, n))) };
}

// ---- Budgets --------------------------------------------------------------
function bcat(name, budgeted, spent, daysElapsed = dayOfFinanceMonth()) {
  const remaining = round2(budgeted - spent);
  const pct = budgeted ? Math.round((spent / budgeted) * 100) : null;
  const over = spent > budgeted;
  return {
    id: catId(name), name, budgeted, target: budgeted, spent, remaining,
    projected: round2(spent * 1.08), expectedToDate: round2(budgeted * 0.5),
    dailyPace: round2(spent / Math.max(1, daysElapsed)), balance: remaining, pct, over,
    status: over ? 'over' : pct && pct > 85 ? 'watch' : 'on_track',
    rolloverMode: 'none', rolloverAmount: 0, annualTarget: null, trueExpenseCadence: null,
    snoozedMonth: null, priority: null, linkedGoal: null,
  };
}
function bgroup(name, cats) {
  const budgeted = round2(cats.reduce((s, c) => s + c.budgeted, 0));
  const spent = round2(cats.reduce((s, c) => s + c.spent, 0));
  const remaining = round2(budgeted - spent);
  const projected = round2(cats.reduce((s, c) => s + c.projected, 0));
  return {
    id: 'grp-' + name.toLowerCase().replace(/[^a-z]+/g, '-'), name,
    budgeted, target: budgeted, spent, remaining, projected,
    status: remaining < 0 ? 'over' : spent / Math.max(1, budgeted) > 0.85 ? 'watch' : 'on_track',
    categories: cats,
  };
}
function budgets() {
  const month = currentMonth();
  const elapsed = dayOfFinanceMonth();
  const groups = [
    bgroup('Housing', [bcat('Rent', 2100, 2100)]),
    bgroup('Food', [bcat('Groceries', 600, 512.34), bcat('Dining', 300, 328.9), bcat('Coffee', 60, 58.5)]),
    bgroup('Transport', [bcat('Gas', 180, 132.2), bcat('Rideshare', 60, 46.8)]),
    bgroup('Bills & Utilities', [bcat('Electric', 110, 94.4), bcat('Internet', 70, 69.99), bcat('Phone', 85, 85)]),
    bgroup('Subscriptions', [bcat('Streaming', 30, 27.48), bcat('Software', 55, 54.99), bcat('Cloud', 5, 2.99)]),
    bgroup('Shopping', [bcat('Shopping', 300, 243.1), bcat('Electronics', 150, 129)]),
    bgroup('Health', [bcat('Gym', 25, 24.99), bcat('Pharmacy', 40, 18.5)]),
    bgroup('Entertainment', [bcat('Entertainment', 100, 64.99)]),
  ];
  const totalBudgeted = round2(groups.reduce((s, g) => s + g.budgeted, 0));
  const totalSpent = round2(groups.reduce((s, g) => s + g.spent, 0));
  const totalProjected = round2(groups.reduce((s, g) => s + g.projected, 0));
  const totalRemaining = round2(totalBudgeted - totalSpent);
  return {
    month, supported: true,
    totalBudgeted, totalTarget: totalBudgeted, totalSpent, totalRemaining, totalProjected,
    daysInMonth: daysInMonth(month),
    daysElapsed: elapsed,
    status: totalRemaining < 0 ? 'over' : 'on_track',
    groups,
  };
}

// ---- Reimbursement --------------------------------------------------------
function reimbursement() {
  const owes = [
    { slug: 'alex', owed: 142.5, misc: 30, trips: [{ event: 'tahoe trip', remaining: 112.5 }], legs: [{ date: ymd(daysAgo(20)), amount: 112.5, label: 'Tahoe cabin share' }, { date: ymd(daysAgo(5)), amount: 30, label: 'Group dinner' }] },
    { slug: 'sam', owed: 112.5, misc: 0, trips: [{ event: 'tahoe trip', remaining: 112.5 }], legs: [{ date: ymd(daysAgo(20)), amount: 112.5, label: 'Tahoe cabin share' }] },
  ];
  const events = [
    { event: 'tahoe trip', fronted: 450, recovered: 225, net: -225, status: 'open', n: 6, firstDate: ymd(daysAgo(22)), lastDate: ymd(daysAgo(12)), settledDate: null },
    { event: 'concert', fronted: 120, recovered: 120, net: 0, status: 'settled_zelle', n: 2, firstDate: ymd(daysAgo(15)), lastDate: ymd(daysAgo(12)), settledDate: ymd(daysAgo(9)) },
    { event: 'ski weekend', fronted: 300, recovered: 300, net: 0, status: 'settled_venmo', n: 4, firstDate: ymd(daysAgo(82)), lastDate: ymd(daysAgo(76)), settledDate: ymd(daysAgo(64)) },
  ];
  return {
    range: { from: ymd(daysAgo(150)), to: financeAnchor() },
    totalOwed: 255.0, debtorCount: 2, owes, people: [], events, expected: [], buckets: {},
  };
}

// ---- Insights -------------------------------------------------------------
function insights() {
  const month = currentMonth();
  const catInfo = demoCategoryInfo();
  const leaves = transactions()
    .filter((t) => t.date.slice(0, 7) === month)
    .flatMap((t) => classifyTransactionLeaves(actualRowFromDemoTransaction(t).transaction, catInfo, { accountId: t.accountId, transactionId: t.id })
      .map((lf) => ({ ...lf, payee: t.payee, date: t.date })));
  const expenses = leaves.filter((lf) => leafCountsAsRealSpend(lf));
  const byPayee = {};
  for (const lf of expenses) {
    const payee = lf.payee || '(no payee)';
    if (!byPayee[payee]) byPayee[payee] = { payee, total: 0, count: 0, category: lf.reason?.startsWith('category:') ? lf.reason.slice('category:'.length) : 'Uncategorized' };
    byPayee[payee].total = round2(byPayee[payee].total + Math.abs(lf.amount / 100));
    byPayee[payee].count += 1;
  }
  return {
    month,
    largestCharges: expenses.slice().sort((a, b) => a.amount - b.amount).slice(0, 5).map((lf) => ({
      id: lf.id, date: lf.date, payee: lf.payee, amount: lf.amount / 100, category: lf.reason?.startsWith('category:') ? lf.reason.slice('category:'.length) : 'Uncategorized',
    })),
    topMerchants: Object.values(byPayee).sort((a, b) => b.total - a.total).slice(0, 5),
    uncategorized: leaves.filter((lf) => lf.kind === 'uncat' && lf.amount < 0).map((lf) => ({ date: lf.date, payee: lf.payee, amount: lf.amount / 100 })),
    recurring: [
      { payee: 'Netflix', category: 'Streaming', monthsSeen: 8, estimated: 15.49 },
      { payee: 'Spotify', category: 'Streaming', monthsSeen: 10, estimated: 11.99 },
      { payee: 'Adobe Creative Cloud', category: 'Software', monthsSeen: 9, estimated: 54.99 },
    ],
    anomalies: [
      { category: 'Dining', current: 328.9, avg: 250.4, deltaPct: 31 },
      { category: 'Rideshare', current: 46.8, avg: 30.1, deltaPct: 55 },
    ],
  };
}

// ---- Tags -----------------------------------------------------------------
function tags() {
  return {
    tags: [
      { raw: '#ev-cabo', token: 'ev-cabo', label: 'cabo', kind: 'event', count: 6 },
      { raw: '#alex', token: 'alex', label: 'alex', kind: 'tag', count: 4 },
      { raw: '#work', token: 'work', label: 'work', kind: 'tag', count: 3 },
      { raw: '#reimbursable', token: 'reimbursable', label: 'reimbursable', kind: 'tag', count: 2 },
    ],
  };
}

// ---- Transactions ---------------------------------------------------------
let _txns = null;
let _nextTxn = 1;
function transactions() {
  if (_txns) return _txns;
  const rnd = mulberry32(42);
  const tx = [];
  const acctName = (accId) => (ACCOUNTS.find((a) => a.id === accId) || ACCOUNTS[0]).name;
  const push = (daysBack, payee, amount, cat, accId, notes = '', identity = {}) => {
    const id = identity.id || ('tx-' + _nextTxn++);
    if (!identity.id) _nextTxn += 1;
    const row = {
      id,
      parentId: null,
      isLeg: false,
      date: ymd(daysAgo(daysBack)),
      payee,
      account: acctName(accId),
      accountId: accId,
      cleared: true,
      amount: round2(amount),
      category: cat,
      categoryId: cat ? catId(cat) : null,
      notes,
      imported: true,
      transferId: identity.transferId || null,
      transferredId: identity.transferredId || null,
    };
    if (identity.subtransactions) {
      row.isSplit = true;
      row.splitCount = identity.subtransactions.length;
      row.category = 'Split';
      row.categoryId = null;
      row.subtransactions = identity.subtransactions;
    }
    tx.push(row);
  };
  for (const db of [1, 15, 31, 46]) push(db, 'Acme Corp Payroll', 3250, 'Salary', 'acc-check');
  push(2, 'Ally Bank Interest', 38.2, 'Interest', 'acc-save');
  push(2, 'Skyline Apartments', -2100, 'Rent', 'acc-check');
  push(32, 'Skyline Apartments', -2100, 'Rent', 'acc-check');
  push(8, 'Netflix', -15.49, 'Streaming', 'acc-credit');
  push(19, 'Spotify', -11.99, 'Streaming', 'acc-credit');
  push(3, 'iCloud+', -2.99, 'Cloud', 'acc-credit');
  push(12, 'Adobe Creative Cloud', -54.99, 'Software', 'acc-credit');
  push(22, 'Planet Fitness', -24.99, 'Gym', 'acc-credit');
  push(1, 'Verizon Wireless', -85, 'Phone', 'acc-credit');
  push(2, 'City Fiber Internet', -69.99, 'Internet', 'acc-credit');
  push(3, 'City Power & Light', -94.4, 'Electric', 'acc-check');
  const groc = ['Whole Foods', "Trader Joe's", 'Costco', 'Safeway'];
  for (let w = 0; w < 8; w++) push(3 + w * 7 + Math.floor(rnd() * 2), groc[w % groc.length], -(40 + Math.round(rnd() * 80)), 'Groceries', 'acc-credit', w < 2 ? '#ev-cabo #reimbursable' : '');
  for (let i = 0; i < 14; i++) push(Math.floor(rnd() * 55), 'Blue Bottle Coffee', -(4 + Math.round(rnd() * 4)), 'Coffee', 'acc-credit');
  const din = ['Chipotle', 'Sushi Ya', 'Olive Garden', 'Thai Basil', 'Shake Shack'];
  for (let i = 0; i < 12; i++) push(Math.floor(rnd() * 58), din[i % din.length], -(14 + Math.round(rnd() * 32)), 'Dining', 'acc-credit');
  for (let i = 0; i < 6; i++) push(4 + i * 9, 'Shell', -(34 + Math.round(rnd() * 26)), 'Gas', 'acc-credit');
  for (let i = 0; i < 4; i++) push(Math.floor(rnd() * 50), 'Uber', -(11 + Math.round(rnd() * 20)), 'Rideshare', 'acc-credit');
  push(7, 'Amazon', -64.3, 'Shopping', 'acc-credit');
  push(21, 'Amazon', -38.99, 'Shopping', 'acc-credit');
  push(17, 'Apple Store', -129, 'Electronics', 'acc-credit');
  push(11, 'AMC Theatres', -32.5, 'Entertainment', 'acc-credit', '#alex');
  push(26, 'Steam', -19.99, 'Entertainment', 'acc-credit');
  push(13, 'CVS Pharmacy', -18.5, 'Pharmacy', 'acc-credit');
  push(5, 'Square *Vendor', -22.4, null, 'acc-credit', '#work');
  push(18, 'Venmo', -30, null, 'acc-check', '#alex');
  const savingsXferOut = 'tx-demo-xfer-out';
  const savingsXferIn = 'tx-demo-xfer-in';
  push(4, 'Transfer : to High-Yield Savings', -500, 'Transfer', 'acc-check', '', { transferId: savingsXferIn, transferredId: 'acc-save' });
  tx[tx.length - 1].id = savingsXferOut;
  push(4, 'Transfer : from Everyday Checking', 500, 'Transfer', 'acc-save', '', { transferId: savingsXferOut, transferredId: 'acc-check' });
  tx[tx.length - 1].id = savingsXferIn;
  push(9, 'Transfer from Mom', -120, null, 'acc-check', 'renamed payee without Actual identity');
  push(10, 'Wire Fee', -35, 'Shopping', 'acc-check', 'category Transfer name does not prove movement', { categoryOverride: true });
  tx[tx.length - 1].category = 'Transfer';
  tx[tx.length - 1].categoryId = catId('Transfer');
  push(6, 'Split purchase', -150, null, 'acc-credit', 'mixed split', {
    id: 'tx-demo-split-parent',
    subtransactions: [
      { id: 'tx-demo-split-exp', amount: -100, categoryId: catId('Shopping'), notes: 'merchandise' },
      { id: 'tx-demo-split-xfer', amount: -50, categoryId: catId('Transfer'), transferId: 'tx-demo-split-remote', notes: 'savings leg' },
    ],
  });
  tx.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  for (const row of tx) {
    row.transfer = hasActualTransferIdentity(actualRowFromDemoTransaction(row).transaction);
  }
  _txns = tx;
  return tx;
}

const demoState = {
  goals: null,
  manualAssets: [
    { id: 'manual-car', name: 'Demo Car', value: 14500, kind: 'asset', updated: ymd(daysAgo(1)) },
    { id: 'manual-loan', name: 'Personal Loan', value: 3200, kind: 'liability', updated: ymd(daysAgo(1)) },
  ],
  rules: [{ id: 'rule-demo-coffee', match: 'Blue Bottle', categoryId: catId('Coffee'), categoryName: 'Coffee', created: ymd(daysAgo(4)) }],
  events: [
    { slug: 'cabo', name: 'Cabo Weekend', start: ymd(daysAgo(12)), members: ['alex', 'sam', 'jordan'], group: 'Demo Splitwise Group', created: ymd(daysAgo(20)), taggedCount: 2 },
    { slug: 'tahoe-trip', name: 'Tahoe Trip', start: ymd(daysAgo(22)), members: ['alex', 'sam'], group: 'Demo Tahoe', created: ymd(daysAgo(28)), taggedCount: 1 },
  ],
  receipts: [{ id: 'receipt-demo-1', txnId: 'tx-5', mime: 'image/png', size: 1280, ocrText: 'Demo receipt total 15.49', ocrLines: ['Netflix', 'Total 15.49'], amount: 15.49, date: ymd(daysAgo(8)), source: 'demo', uploadedAt: new Date().toISOString() }],
  links: [],
  dismissedSuggestions: new Set(),
  reconEnabled: true,
  reconDone: {},
};

function currentGoals() {
  if (!demoState.goals) demoState.goals = goals();
  return demoState.goals;
}
function manualAssets() {
  const items = demoState.manualAssets.map((m) => ({ ...m }));
  const assets = round2(items.filter((m) => m.kind === 'asset').reduce((s, m) => s + m.value, 0));
  const liabilities = round2(items.filter((m) => m.kind === 'liability').reduce((s, m) => s + m.value, 0));
  return { items, assets, liabilities, net: round2(assets - liabilities) };
}
function investments() {
  const holdings = [
    { symbol: 'VTI', name: 'Vanguard Total Stock Market', account: 'Brokerage', assetClass: 'US Stocks', quantity: 82.4, price: 310.25, value: 25564.6, costBasis: 21800, gainLoss: 3764.6, gainLossPct: 17.3 },
    { symbol: 'VXUS', name: 'Vanguard Total International', account: 'Brokerage', assetClass: 'International', quantity: 72.1, price: 69.25, value: 4992.93, costBasis: 4680, gainLoss: 312.93, gainLossPct: 6.7 },
    { symbol: 'BND', name: 'Vanguard Total Bond', account: 'Roth IRA', assetClass: 'Bonds', quantity: 52, price: 72.4, value: 3764.8, costBasis: 3900, gainLoss: -135.2, gainLossPct: -3.5 },
  ];
  const totals = {
    value: round2(holdings.reduce((s, h) => s + h.value, 0)),
    costBasis: round2(holdings.reduce((s, h) => s + (h.costBasis || 0), 0)),
    gainLoss: round2(holdings.reduce((s, h) => s + (h.gainLoss || 0), 0)),
  };
  const byAssetClass = {};
  const byAccount = {};
  for (const h of holdings) {
    byAssetClass[h.assetClass] = round2((byAssetClass[h.assetClass] || 0) + h.value);
    byAccount[h.account] = round2((byAccount[h.account] || 0) + h.value);
  }
  const debts = [
    { id: 'debt-student', name: 'Student Loan', balance: 8400, apr: 5.8, minPayment: 175, dueDate: addDays(financeAnchor(), 18), strategy: 'avalanche', months: 54, totalInterest: 1320, payoffDate: addDays(financeAnchor(), 54 * 30) },
    { id: 'debt-auto', name: 'Auto Loan', balance: 6200, apr: 4.2, minPayment: 240, dueDate: addDays(financeAnchor(), 9), strategy: 'snowball', months: 28, totalInterest: 410, payoffDate: addDays(financeAnchor(), 28 * 30) },
  ];
  const debtTotals = { balance: round2(debts.reduce((s, d) => s + d.balance, 0)), minPayment: round2(debts.reduce((s, d) => s + d.minPayment, 0)), weightedApr: 5.1 };
  return { generatedAt: new Date().toISOString(), holdings, totals, allocation: { byAssetClass, byAccount }, debts, debtTotals };
}
function forecast(days = 90) {
  const start = financeAnchor();
  const horizonDays = Math.min(180, Math.max(30, Number(days) || 90));
  const end = addDays(start, horizonDays);
  const allAccounts = accounts();
  const cash = allAccounts.filter((account) => account.role === 'operating_cash');
  const startBalance = round2(cash.reduce((sum, account) => sum + account.balance, 0));
  const recurringData = recurring();
  const incomeData = income();
  const upcoming = bills();
  const graphTxnInputs = buildGraphTransactionInputs(
    transactions().map((t) => actualRowFromDemoTransaction(t)),
    demoCategoryInfo(),
    {
      windowStart: start,
      windowEnd: end,
      accountRolesById: Object.fromEntries(allAccounts.map((account) => [account.id, account.role])),
    },
  );
  const graphInputs = assembleObligationGraphInputs({
    financeDate: start,
    windowStart: start,
    windowEnd: end,
    accounts: allAccounts,
    accountOverrides: {
      'acc-credit': {
        creditLiabilityCoverage: 'current_balance',
        paymentRecurringKey: 'sapphire card payment',
        fundingAccountId: 'acc-check',
      },
    },
    recurring: recurringData,
    income: incomeData,
    bills: { bills: upcoming.bills.filter((bill) => bill.dueDate <= end) },
    budgets: { supported: false },
    reimb: { totalOwed: 0 },
    operatingAccountIds: cash.map((account) => account.id),
    transfers: graphTxnInputs.transfers,
    economicTransactions: graphTxnInputs.economicTransactions,
  });
  const graph = buildObligationGraph(graphInputs);
  const graphEvents = graph.completeness?.complete
    ? forecastCashEventsFromGraph(graph, { windowStart: start, windowEnd: end })
    : [];
  const events = graphEvents.map((event) => ({
    date: event.date,
    label: event.label,
    amount: round2(event.amountCents / 100),
    kind: event.kind,
    sourceId: event.sourceId || null,
    provenance: event.provenance || 'inferred',
  })).sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
  const byDate = new Map();
  for (const event of events) {
    const cents = Math.round(event.amount * 100);
    const cur = byDate.get(event.date) || { date: event.date, inflow: 0, outflow: 0 };
    if (cents >= 0) cur.inflow = round2(cur.inflow + event.amount);
    else cur.outflow = round2(cur.outflow + Math.abs(event.amount));
    byDate.set(event.date, cur);
  }
  const points = [];
  let running = startBalance;
  const step = Math.max(1, Math.round(horizonDays / 12));
  for (let d = 0; d <= horizonDays; d += step) {
    const date = addDays(start, d);
    for (const event of events) {
      if (event.date > addDays(start, d - step) && event.date <= date) running = round2(running + event.amount);
    }
    const dayTotals = byDate.get(date) || { inflow: 0, outflow: 0 };
    points.push({ date, balance: running, inflow: dayTotals.inflow, outflow: dayTotals.outflow });
  }
  if (points.length === 0 || points[points.length - 1].date !== end) {
    points.push({ date: end, balance: running, inflow: 0, outflow: 0 });
  }
  const lowest = points.reduce((a, p) => (p.balance < a.balance ? p : a), points[0]);
  const warnings = [];
  if (!graph.completeness?.complete) {
    warnings.push('Obligation graph incomplete; scheduled cash events withheld.');
  }
  if (lowest.balance < 1000) warnings.push('Projected cash gets low this period.');
  return {
    generatedAt: new Date().toISOString(),
    range: { start, end, days: horizonDays },
    startBalance,
    endingBalance: points[points.length - 1].balance,
    lowest: { date: lowest.date, balance: lowest.balance },
    totals: {
      inflow: round2(events.filter((event) => event.amount > 0).reduce((sum, event) => sum + event.amount, 0)),
      outflow: round2(Math.abs(events.filter((event) => event.amount < 0).reduce((sum, event) => sum + event.amount, 0))),
    },
    points,
    events,
    assumptions: {
      liquidAccounts: cash.map((account) => ({ id: account.id, name: account.name })),
      obligationGraph: graphSummary(graph),
      graphDriven: true,
      genericBudgetTarget: 0,
      genericBudget: {
        target: 0,
        remaining: 0,
        complete: true,
        incompleteReasons: [],
      },
      billsExcludedFromGenericBudget: true,
      reimbursementsIncluded: false,
    },
    warnings,
  };
}
function reports() {
  const sp = spending();
  const tx = transactions();
  return {
    generatedAt: new Date().toISOString(),
    month: currentMonth(),
    saved: [{ id: 'demo-monthly', title: 'Monthly Review', subtitle: 'Demo summary ready' }],
    monthlyReview: { income: sp.current.totalIncome, spend: sp.current.totalSpend, net: round2(sp.current.totalIncome - sp.current.totalSpend), transactionCount: tx.length, largest: insights().largestCharges.slice(0, 3), uncategorized: tx.filter((t) => !t.category).slice(0, 3) },
    categoryTrends: Object.entries(sp.current.spending).slice(0, 6).map(([name, spend]) => ({ name, spend, pct: Math.round((spend / Math.max(1, sp.current.totalSpend)) * 100) })),
    merchantTrends: insights().topMerchants,
    tagSummary: tags().tags,
    cashFlow: trends(12).months,
  };
}
function review() {
  const tx = transactions();
  const uncategorized = tx.find((t) => !t.category && !t.transfer);
  const large = tx.find((t) => !t.transfer && Math.abs(t.amount) > 1000 && t.amount < 0);
  const tasks = [
    uncategorized ? { id: 'review-uncat', kind: 'uncategorized', priority: 95, title: 'Categorize transaction', subtitle: 'Needs a category', action: 'categorize', amount: Math.abs(uncategorized.amount), date: uncategorized.date, transaction: uncategorized } : null,
    large ? { id: 'review-large', kind: 'large_charge', priority: 85, title: 'Large charge', subtitle: 'Review unusually large spending', action: 'open_transaction', amount: Math.abs(large.amount), date: large.date, transaction: large } : null,
    { id: 'review-reconcile', kind: 'reconciliation', priority: 70, title: 'Close last month', subtitle: 'Monthly reconciliation is pending', action: 'open_reconcile', amount: 0, date: null, month: currentMonth() },
  ].filter(Boolean);
  return { generatedAt: new Date().toISOString(), month: currentMonth(), count: tasks.length, counts: { uncategorized: uncategorized ? 1 : 0, large_charge: large ? 1 : 0, reconciliation: 1 }, tasks };
}
function events() { return { events: demoState.events.map((e) => ({ ...e, members: [...e.members] })) }; }
function rules() { return { rules: demoState.rules.map((r) => ({ ...r })), catalog: [{ label: 'Streaming services', type: 'subscription' }, { label: 'Coffee shops', type: 'merchant' }] }; }
function merchantHistory({ payee = '', months = 12 } = {}) {
  const m = Math.min(36, Math.max(1, Number(months) || 12));
  const catInfo = demoCategoryInfo();
  const out = [];
  const anchorMonth = currentMonth();
  for (let i = m - 1; i >= 0; i--) {
    const key = shiftMonth(anchorMonth, -i);
    const items = transactions()
      .filter((t) => t.payee.toLowerCase() === String(payee).toLowerCase() && t.date.slice(0, 7) === key)
      .flatMap((t) => classifyTransactionLeaves(actualRowFromDemoTransaction(t).transaction, catInfo, { accountId: t.accountId })
        .filter((lf) => leafCountsAsRealSpend(lf))
        .map((lf) => ({ id: lf.id, date: t.date, payee: t.payee, amount: lf.amount / 100, category: lf.reason?.startsWith('category:') ? lf.reason.slice('category:'.length) : 'Uncategorized' })));
    out.push({ month: key, total: round2(items.reduce((s, t) => s + Math.abs(t.amount), 0)), count: items.length, items });
  }
  const all = out.flatMap((x) => x.items);
  const total = round2(all.reduce((s, t) => s + Math.abs(t.amount), 0));
  return { payee, count: all.length, total, avg: all.length ? round2(total / all.length) : 0, monthsSeen: out.filter((x) => x.count).length, months: out };
}
function transactionDetail(id) {
  const t = transactions().find((x) => x.id === id) || transactions()[0];
  return { ...t, imported: t.imported !== false, isSplit: !!t.isSplit, legs: t.legs || [] };
}
function reconciliation(month = currentMonth()) {
  const items = transactions().filter((t) => t.date.slice(0, 7) === month).slice(0, 10).map((t, i) => ({ id: t.id, date: t.date, payee: t.payee, amount: t.amount, category: t.category || 'Uncategorized', account: t.account, accountId: t.accountId, reconciled: i < 2 }));
  const done = !!demoState.reconDone[month];
  const reconciledCount = done ? items.length : items.filter((i) => i.reconciled).length;
  return { enabled: demoState.reconEnabled, month, done, doneAt: done ? new Date().toISOString() : null, total: items.length, reconciledCount, remaining: items.length - reconciledCount, items: done ? items.map((i) => ({ ...i, reconciled: true })) : items };
}
function reconcilePending() {
  const month = currentMonth();
  const r = reconciliation(month);
  return { enabled: demoState.reconEnabled, pending: r.done ? null : month, total: r.total, reconciledCount: r.reconciledCount, remaining: r.remaining };
}
function repaymentSuggestions() {
  const inflow = { id: 'tx-repay-demo', date: ymd(daysAgo(4)), payee: 'Venmo Alex', amount: 142.5 };
  const expense = { id: 'tx-expense-demo', date: ymd(daysAgo(20)), payee: 'Tahoe cabin share', amount: -112.5 };
  const suggestions = demoState.dismissedSuggestions.has('demo-sugg-alex') ? [] : [{ id: 'demo-sugg-alex', inflow, person: 'alex', owed: 142.5, allocations: [{ expense, amount: 112.5 }], matched: 112.5, remainder: 30, kind: 'over', score: 93, reason: 'Incoming Venmo looks like Alex paying back shared trip expenses.', createdAt: new Date().toISOString() }];
  return { suggestions, count: suggestions.length, generatedAt: new Date().toISOString(), range: { from: ymd(daysAgo(60)), to: financeAnchor() } };
}

function receipts(txnId) {
  return { receipts: demoState.receipts.filter((r) => !txnId || r.txnId === txnId).map((r) => ({ ...r })) };
}

function reimbursementExport() {
  const links = [{
    linkKey: 'tx-repay-demo:tx-expense-demo',
    inflow: { id: 'tx-repay-demo', date: ymd(daysAgo(4)), payee: 'Venmo Alex', amount: 142.5, accountId: 'acc-checking', account: 'Checking' },
    expense: { id: 'tx-expense-demo', date: ymd(daysAgo(20)), payee: 'Tahoe cabin share', amount: -112.5, accountId: 'acc-credit', account: 'Credit Card' },
    allocationCents: 11250,
    amount: 112.5,
    person: 'alex',
    version: 1,
  }];
  return projectAllocationLedger({
    links,
    liveById: {
      'tx-repay-demo': { id: 'tx-repay-demo', date: links[0].inflow.date, payee: 'Venmo Alex', amountCents: 14250, accountId: 'acc-checking', accountName: 'Checking' },
      'tx-expense-demo': { id: 'tx-expense-demo', date: links[0].expense.date, payee: 'Tahoe cabin share', amountCents: -11250, accountId: 'acc-credit', accountName: 'Credit Card' },
    },
    activeSagas: [],
    provenance: { actualGeneration: 0, release: null, linksSidecarDigest: 'demo' },
  });
}

function reimbLinks(id) {
  const links = demoState.links.filter((l) => !id || l.inflow.id === id || l.expense.id === id);
  return {
    asInflow: links.filter((l) => !id || l.inflow.id === id).map((l) => ({ ...l.expense, allocated: l.allocated })),
    asExpense: links.filter((l) => !id || l.expense.id === id).map((l) => ({ ...l.inflow, allocated: l.allocated })),
  };
}

function saveGoal(input = {}) {
  const list = currentGoals();
  const id = input.id || `goal-demo-${Date.now()}`;
  const cur = input.accountId ? accounts().find((a) => a.id === input.accountId)?.balance || 0 : 0;
  const row = { id, name: input.name || 'Demo Goal', target: Number(input.target) || 1000, accountId: input.accountId || null, deadline: input.deadline || null, current: round2(Math.max(0, cur)), pct: Math.round((Math.max(0, cur) / Math.max(1, Number(input.target) || 1000)) * 100) };
  const idx = list.findIndex((g) => g.id === id);
  if (idx >= 0) list[idx] = row; else list.push(row);
  return { ok: true, id };
}
function deleteGoal(id) { demoState.goals = currentGoals().filter((g) => g.id !== id); return { ok: true, removed: 1 }; }
function saveManualAsset(input = {}) {
  const id = input.id || `manual-demo-${Date.now()}`;
  const row = { id, name: input.name || 'Demo asset', value: round2(Number(input.value) || 0), kind: input.kind === 'liability' ? 'liability' : 'asset', updated: financeAnchor() };
  const idx = demoState.manualAssets.findIndex((m) => m.id === id);
  if (idx >= 0) demoState.manualAssets[idx] = row; else demoState.manualAssets.push(row);
  return { ok: true, id };
}
function deleteManualAsset(id) { demoState.manualAssets = demoState.manualAssets.filter((m) => m.id !== id); return { ok: true, removed: 1 }; }
function saveRule(input = {}) {
  const id = `rule-demo-${Date.now()}`;
  const row = { id, match: input.match || 'Demo', categoryId: input.categoryId || catId('Shopping'), categoryName: input.categoryName || categoryById(input.categoryId)?.name || 'Shopping', created: financeAnchor() };
  demoState.rules.push(row);
  return { ok: true, id, applied: 1 };
}
function deleteRule(id) { demoState.rules = demoState.rules.filter((r) => r.id !== id); return { ok: true, removed: 1 }; }
function saveEvent(input = {}) {
  const slug = input.slug || String(input.name || 'demo-event').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `event-${Date.now()}`;
  const event = { slug, name: input.name || 'Demo Event', start: input.start || financeAnchor(), members: String(input.members || '').split(',').map((s) => s.trim()).filter(Boolean), group: input.group || '', created: financeAnchor(), taggedCount: 0 };
  const idx = demoState.events.findIndex((e) => e.slug === slug);
  if (idx >= 0) demoState.events[idx] = event; else demoState.events.push(event);
  return { ok: true, event };
}
function deleteEvent(slug) { demoState.events = demoState.events.filter((e) => e.slug !== slug); return { ok: true, removed: 1 }; }
function createTransaction(input = {}) {
  const account = accounts().find((a) => a.id === input.accountId) || accounts()[0];
  const cat = categoryById(input.categoryId);
  const row = { id: `tx-${_nextTxn++}`, parentId: null, isLeg: false, date: input.date || financeAnchor(), payee: input.payee || 'Manual transaction', account: account.name, accountId: account.id, cleared: true, amount: round2(Number(input.amount) || 0), category: cat?.name || null, categoryId: cat?.id || null, notes: input.notes || '', imported: false };
  transactions().unshift(row);
  return { ok: true, id: row.id };
}
function updateTransaction(id, patch = {}) {
  const t = transactions().find((x) => x.id === id);
  if (!t) return { ok: true, mode: 'demo' };
  if (patch.categoryId !== undefined) { const c = categoryById(patch.categoryId); t.categoryId = c?.id || null; t.category = c?.name || null; }
  if (patch.notes !== undefined) t.notes = patch.notes;
  if (patch.payee !== undefined) t.payee = patch.payee;
  if (patch.date !== undefined) t.date = patch.date;
  return { ok: true, mode: 'demo', date: t.date };
}
function splitTransaction(id, legs = []) {
  const t = transactions().find((x) => x.id === id);
  if (!t) return { ok: true, legs: 0 };
  t.isSplit = true;
  t.splitCount = legs.length;
  t.legs = legs.map((l, i) => ({ id: l.id || `${id}-leg-${i + 1}`, amount: l.amount, categoryId: l.categoryId || null, category: categoryById(l.categoryId)?.name || null, name: l.name || '', notes: l.notes || '' }));
  return { ok: true, legs: t.legs.length };
}
function unsplitTransaction(id, categoryId) {
  const t = transactions().find((x) => x.id === id);
  if (t) { t.isSplit = false; t.splitCount = undefined; t.legs = []; if (categoryId !== undefined) updateTransaction(id, { categoryId }); }
  return { ok: true };
}
function deleteTransaction(id) { _txns = transactions().filter((t) => t.id !== id); return { ok: true, removed: 1 }; }
function addReimbLink(body = {}) { demoState.links.push({ inflow: body.inflow, expense: body.expense, allocated: Math.min(Math.abs(body.inflow?.amount || 0), Math.abs(body.expense?.amount || 0)) }); return { ok: true, id: 'demo-link' }; }
function deleteReimbLink(body = {}) { demoState.links = demoState.links.filter((l) => l.inflow.id !== body.inflowId || l.expense.id !== body.expenseId); return { ok: true, removed: 1 }; }
function confirmRepayment(id) { demoState.dismissedSuggestions.add(id); return { ok: true, linked: 1, inflowId: 'tx-repay-demo' }; }
function dismissRepayment(id) { demoState.dismissedSuggestions.add(id); return { ok: true, dismissed: id }; }
function setReconcileItem({ month, id, reconciled }) { return { ok: true, id, month, reconciled }; }
function setReconcileMonth({ month, done }) { demoState.reconDone[month || currentMonth()] = !!done; return { ok: true }; }
function setReconcileEnabled({ enabled }) { demoState.reconEnabled = !!enabled; return { ok: true }; }
function addReceipt(body = {}) { const r = { id: `receipt-demo-${Date.now()}`, txnId: body.txnId, mime: body.mime || 'image/png', size: 1000, ocrText: body.ocrText || 'Demo receipt', ocrLines: body.ocrLines || [], amount: body.amount ?? null, date: body.date ?? null, source: body.source || 'demo', uploadedAt: new Date().toISOString() }; demoState.receipts.push(r); return r; }
function deleteReceipt(id) { demoState.receipts = demoState.receipts.filter((r) => r.id !== id); return { ok: true, removed: 1 }; }

module.exports = {
  accounts, transactions, spending, trends, budgets, reimbursement, insights, categories, recurring, bills, income,
  goals: currentGoals, tags, manualAssets, investments, forecast, reports, review, today, events, rules, merchantHistory,
  transactionDetail, reconciliation, reconcilePending, repaymentSuggestions, receipts, reimbLinks, reimbursementExport,
  saveGoal, deleteGoal, saveManualAsset, deleteManualAsset, saveRule, deleteRule, saveEvent, deleteEvent,
  createTransaction, updateTransaction, splitTransaction, unsplitTransaction, deleteTransaction,
  addReimbLink, deleteReimbLink, confirmRepayment, dismissRepayment, setReconcileItem, setReconcileMonth,
  setReconcileEnabled, addReceipt, deleteReceipt,
};
