// demoData.js — fully synthetic dataset for "Demo Mode".
// Returns the same shapes as dataModule.js but never touches Actual or real data,
// so the dashboard / app can be shown to other people safely. Dates are computed
// relative to "today" on each call so the demo always looks current.

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const monthKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
const round2 = (n) => Math.round(n * 100) / 100;
function daysAgo(n) { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return d; }
function addDays(dateStr, days) { const [y, m, dd] = dateStr.split('-').map(Number); const d = new Date(y, m - 1, dd); d.setDate(d.getDate() + days); return ymd(d); }
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const recurKey = (p) => (p || '').toLowerCase().replace(/[#*]?\d{3,}/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// ---- Accounts -------------------------------------------------------------
const ACCOUNTS = [
  { id: 'acc-check', name: 'Everyday Checking', offbudget: false, balance: 4820.55 },
  { id: 'acc-save', name: 'High-Yield Savings', offbudget: false, balance: 18450.00 },
  { id: 'acc-credit', name: 'Sapphire Card', offbudget: false, balance: -1240.30 },
  { id: 'acc-invest', name: 'Brokerage', offbudget: true, balance: 32160.75 },
  { id: 'acc-roth', name: 'Roth IRA', offbudget: true, balance: 21300.00 },
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
];
const catId = (name) => 'cat-' + name.toLowerCase().replace(/[^a-z]+/g, '-');
const categories = () => CATS.map(([name, group]) => ({ id: catId(name), name, group }));

// ---- Recurring / Subscriptions -------------------------------------------
function buildSub(payee, category, amount, daysSinceLast, occ, priceFrom) {
  const last = ymd(daysAgo(daysSinceLast));
  const history = [];
  for (let k = occ - 1; k >= 0; k--) history.push({ date: addDays(last, -k * 30), amount: priceFrom && k >= 2 ? priceFrom : amount });
  const priceChange = priceFrom && priceFrom !== amount
    ? { from: round2(priceFrom), to: round2(amount), pct: Math.round(((amount - priceFrom) / priceFrom) * 100) } : null;
  return {
    key: recurKey(payee), payee, category, cadence: 'monthly', amount: round2(amount), monthlyEquivalent: round2(amount),
    isBill: /rent|mortgage|phone|internet|cable|utilit|electric|water|\bgas\b|sewer|trash|insuranc|\bloan/i.test(category),
    occurrences: occ, firstCharged: history[0].date, lastCharged: last, nextRenewal: addDays(last, 30),
    priceChange, status: 'active', hidden: false, history,
  };
}
function activeSubs() {
  return [
    buildSub('Skyline Apartments', 'Rent', 2100, 2, 12),
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
  const today = ymd(new Date());
  const within = [];
  for (const it of activeSubs()) {
    if (!it.isBill) continue; // bills view = true bills only (rent/utilities/phone/internet)
    const diff = (new Date(it.nextRenewal) - new Date(today)) / 86400000;
    if (diff >= 0 && diff <= 45) within.push({ id: `${it.key}|${it.nextRenewal}`, key: it.key, payee: it.payee, amount: it.amount, dueDate: it.nextRenewal, category: it.category, cadence: it.cadence, paid: false, paidDate: null, matched: null });
  }
  within.sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
  return { bills: within, total: round2(within.reduce((s, b) => s + b.amount, 0)), count: within.length, unpaidCount: within.length, horizonDays: 45 };
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
function spending() {
  const cur = { Rent: 2100, Groceries: 512.34, Dining: 328.9, Coffee: 58.5, Gas: 132.2, Rideshare: 46.8, Electric: 94.4, Internet: 69.99, Phone: 85, Streaming: 27.48, Software: 54.99, Cloud: 2.99, Shopping: 243.1, Electronics: 129, Gym: 24.99, Pharmacy: 18.5, Entertainment: 64.99 };
  const prev = { Rent: 2100, Groceries: 478.1, Dining: 286.4, Coffee: 61.2, Gas: 118.5, Rideshare: 33.0, Electric: 88.2, Internet: 69.99, Phone: 85, Streaming: 27.48, Software: 54.99, Cloud: 2.99, Shopping: 312.7, Gym: 24.99, Pharmacy: 42.1, Entertainment: 39.99 };
  const sum = (o) => round2(Object.values(o).reduce((s, x) => s + x, 0));
  return {
    current: { spending: cur, totalSpend: sum(cur), totalIncome: 6538.2 },
    prev: { spending: prev, totalSpend: sum(prev), totalIncome: 6500 },
    month: monthKey(new Date()),
  };
}

// ---- Trends (up to 36 months) ---------------------------------------------
function trends(n = 12) {
  const now = new Date();
  const out = [];
  let nw = 59000;
  for (let i = 35; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const rnd = mulberry32(1000 + i);
    const income = 6500 + (i % 6 === 0 ? 1600 : 0) + Math.round(rnd() * 80);
    const spend = 4300 + Math.round(rnd() * 1100);
    const net = income - spend;
    nw += net * 0.22 + (rnd() * 240 - 60);
    out.push({ month: monthKey(d), netWorth: round2(nw), spend: round2(spend), income: round2(income), net: round2(net) });
  }
  return { months: out.slice(36 - Math.min(36, Math.max(3, n))) };
}

// ---- Budgets --------------------------------------------------------------
function bcat(name, budgeted, spent) { return { id: catId(name), name, budgeted, spent, balance: round2(budgeted - spent), pct: budgeted ? Math.round((spent / budgeted) * 100) : null, over: spent > budgeted }; }
function bgroup(name, cats) {
  return { id: 'grp-' + name.toLowerCase().replace(/[^a-z]+/g, '-'), name, budgeted: round2(cats.reduce((s, c) => s + c.budgeted, 0)), spent: round2(cats.reduce((s, c) => s + c.spent, 0)), categories: cats };
}
function budgets() {
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
  return { month: monthKey(new Date()), supported: true, totalBudgeted: round2(groups.reduce((s, g) => s + g.budgeted, 0)), totalSpent: round2(groups.reduce((s, g) => s + g.spent, 0)), groups };
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
    range: { from: ymd(daysAgo(150)), to: ymd(new Date()) },
    totalOwed: 255.0, debtorCount: 2, owes, people: [], events, expected: [], buckets: {},
  };
}

// ---- Insights -------------------------------------------------------------
function insights() {
  return {
    month: monthKey(new Date()),
    largestCharges: [
      { id: 'lc-1', date: ymd(daysAgo(2)), payee: 'Skyline Apartments', amount: -2100, category: 'Rent', account: 'Everyday Checking', accountId: 'acc-check', categoryId: null, notes: '', isLeg: false, parentId: null },
      { id: 'lc-2', date: ymd(daysAgo(17)), payee: 'Apple Store', amount: -129, category: 'Electronics', account: 'Sapphire Card', accountId: 'acc-credit', categoryId: null, notes: '', isLeg: false, parentId: null },
      { id: 'lc-3', date: ymd(daysAgo(9)), payee: 'City Power & Light', amount: -94.4, category: 'Electric', account: 'Everyday Checking', accountId: 'acc-check', categoryId: null, notes: '', isLeg: false, parentId: null },
      { id: 'lc-4', date: ymd(daysAgo(6)), payee: 'Verizon Wireless', amount: -85, category: 'Phone', account: 'Sapphire Card', accountId: 'acc-credit', categoryId: null, notes: '', isLeg: false, parentId: null },
      { id: 'lc-5', date: ymd(daysAgo(12)), payee: 'Adobe Creative Cloud', amount: -54.99, category: 'Software', account: 'Sapphire Card', accountId: 'acc-credit', categoryId: null, notes: '', isLeg: false, parentId: null },
    ],
    uncategorized: [
      { date: ymd(daysAgo(5)), payee: 'Square *Vendor', amount: -22.4 },
      { date: ymd(daysAgo(18)), payee: 'Venmo', amount: -30 },
    ],
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
function transactions() {
  if (_txns) return _txns;
  const rnd = mulberry32(42);
  const tx = [];
  let id = 1;
  const acctName = (accId) => (ACCOUNTS.find((a) => a.id === accId) || ACCOUNTS[0]).name;
  const push = (daysBack, payee, amount, cat, accId) => {
    tx.push({ id: 'tx-' + id++, parentId: null, isLeg: false, date: ymd(daysAgo(daysBack)), payee, account: acctName(accId), accountId: accId, cleared: true, amount: round2(amount), category: cat, categoryId: cat ? catId(cat) : null, notes: '' });
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
  for (let w = 0; w < 8; w++) push(3 + w * 7 + Math.floor(rnd() * 2), groc[w % groc.length], -(40 + Math.round(rnd() * 80)), 'Groceries', 'acc-credit');
  for (let i = 0; i < 14; i++) push(Math.floor(rnd() * 55), 'Blue Bottle Coffee', -(4 + Math.round(rnd() * 4)), 'Coffee', 'acc-credit');
  const din = ['Chipotle', 'Sushi Ya', 'Olive Garden', 'Thai Basil', 'Shake Shack'];
  for (let i = 0; i < 12; i++) push(Math.floor(rnd() * 58), din[i % din.length], -(14 + Math.round(rnd() * 32)), 'Dining', 'acc-credit');
  for (let i = 0; i < 6; i++) push(4 + i * 9, 'Shell', -(34 + Math.round(rnd() * 26)), 'Gas', 'acc-credit');
  for (let i = 0; i < 4; i++) push(Math.floor(rnd() * 50), 'Uber', -(11 + Math.round(rnd() * 20)), 'Rideshare', 'acc-credit');
  push(7, 'Amazon', -64.3, 'Shopping', 'acc-credit');
  push(21, 'Amazon', -38.99, 'Shopping', 'acc-credit');
  push(17, 'Apple Store', -129, 'Electronics', 'acc-credit');
  push(11, 'AMC Theatres', -32.5, 'Entertainment', 'acc-credit');
  push(26, 'Steam', -19.99, 'Entertainment', 'acc-credit');
  push(13, 'CVS Pharmacy', -18.5, 'Pharmacy', 'acc-credit');
  push(5, 'Square *Vendor', -22.4, null, 'acc-credit');
  push(18, 'Venmo', -30, null, 'acc-check');
  tx.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  _txns = tx;
  return tx;
}

module.exports = { accounts, transactions, spending, trends, budgets, reimbursement, insights, categories, recurring, bills, income, goals, tags };
