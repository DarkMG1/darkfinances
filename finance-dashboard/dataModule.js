'use strict';
/*
 * dataModule.js — single source of truth for all Actual Budget reads/computations.
 *
 * Shared by the Express API (web dashboard + native app). Keeps the Actual API
 * lifecycle (init / downloadBudget / sync) in one place and exposes pure-ish data
 * getters. HTTP-layer caching lives in server.js; this module just computes.
 *
 * Classification mirrors the finance digest tooling:
 *   income | mm (money movement) | reimb (peer debts) | spend (real) | uncat
 *
 * Env: ACTUAL_SERVER_URL, ACTUAL_PASSWORD, ACTUAL_SYNC_ID, ACTUAL_DATA_DIR
 */

const fs = require('fs');
const path = require('path');
const ACTUAL_API_PATH = process.env.ACTUAL_API_PATH || '@actual-app/api';
const api = require(ACTUAL_API_PATH);

// Sidecar JSON for per-user state Actual Budget can't hold (subscription
// overrides, savings goals). Lives next to this module; the systemd service
// user owns ~/finance-dashboard so these are writable.
const OVERRIDES_PATH = process.env.RECURRING_OVERRIDES_PATH || path.join(__dirname, 'recurring-overrides.json');
const GOALS_PATH = process.env.GOALS_PATH || path.join(__dirname, 'goals.json');
const BILLS_PAID_PATH = process.env.BILLS_PAID_PATH || path.join(__dirname, 'bills-paid.json');
// Optional richer budgeting metadata keyed by category id or category name.
const BUDGET_SETTINGS_PATH = process.env.BUDGET_SETTINGS_PATH || path.join(__dirname, 'budget-settings.json');
// "Who owes me" ground truth (Splitwise expected amounts, trips, debtor name
// patterns). Editable by deployment tooling or the user without a code change.
const OWES_CONFIG_PATH = process.env.OWES_CONFIG_PATH || path.join(__dirname, 'owes-config.json');
// Authoritative "who owes me" snapshot (Splitwise pairwise truth) produced by
// actual-tools/owes-snapshot.js. The dashboard READS this; it never recomputes
// per-person trip debts from line items (that approach always drifted — see
// the project reimbursement docs). Missing file => fall back to the legacy baseline.
const OWES_TRUTH_PATH = process.env.OWES_TRUTH_PATH || path.join(__dirname, 'owes-truth.json');
// Venmo debts imported from a statement CSV (actual-tools/venmo-import.js). Same
// { bySlug: { slug: [{event, amount}] } } shape as owes-truth, merged into
// who-owes-me alongside Splitwise. Absent => Venmo simply contributes nothing.
const VENMO_TRUTH_PATH = process.env.VENMO_TRUTH_PATH || path.join(__dirname, 'venmo-truth.json');
// Events / trips: user-created groupings (name, members, Splitwise group) that a
// transaction tag (#ev-<slug>) ties into. owes-snapshot.js reads this same file so
// a trip created in the app auto-pulls its Splitwise group into who-owes-me.
const EVENTS_PATH = process.env.EVENTS_PATH || path.join(__dirname, 'events.json');
// Manual reimbursement links: maps a repayment inflow (e.g. a Zelle payback) to
// the expense(s) it repays. Actual has no native txn-to-txn link, so we store
// display snapshots of both sides here.
const REIMB_LINKS_PATH = process.env.REIMB_LINKS_PATH || path.join(__dirname, 'reimb-links.json');
// Auto-matcher: suggested repayment→expense matches awaiting your confirmation,
// plus a dismissed set so we never re-surface ones you've waved off.
const REIMB_SUGGEST_PATH = process.env.REIMB_SUGGEST_PATH || path.join(__dirname, 'reimb-suggest.json');
// Optional deployment-specific cutoffs. By default the app behaves normally:
// direct reimbursement debt scans all history, and suggestions start Jan 1 of
// the current year. Personal deployments can set these env vars to hide already
// settled historical rows.
const REIMB_SUGGEST_FROM = process.env.REIMB_SUGGEST_FROM || `${new Date().getFullYear()}-01-01`;
const REIMB_LEDGER_FROM = process.env.REIMB_LEDGER_FROM || '2000-01-01';
const REIMB_LEDGER_CUTOFF_ACTIVE = !!process.env.REIMB_LEDGER_FROM;
// Phantom pending cleanup: a strike ledger of pending imported charges we've seen
// (so aged-out deletes only fire after we've watched one linger), plus an audit log
// of everything the cleanup has removed.
const PHANTOM_SEEN_PATH = process.env.PHANTOM_SEEN_PATH || path.join(__dirname, 'phantom-seen.json');
const PHANTOM_LOG_PATH = process.env.PHANTOM_LOG_PATH || path.join(__dirname, 'phantom-log.json');
// Receipts: metadata index (per transaction) + a directory of the raw image files,
// so scanned receipts survive an app reinstall (server is the durable copy).
const RECEIPTS_PATH = process.env.RECEIPTS_PATH || path.join(__dirname, 'receipts.json');
const RECEIPTS_DIR = process.env.RECEIPTS_DIR || path.join(__dirname, 'receipts');
// Categorization rules ("always categorize payee X as Y"). Applied to
// uncategorized transactions on create + on each SimpleFIN refresh.
const RULES_PATH = process.env.RULES_PATH || path.join(__dirname, 'rules.json');
// Per-account display overrides (rename / hide) — never touches Actual itself.
const ACCOUNT_OVERRIDES_PATH = process.env.ACCOUNT_OVERRIDES_PATH || path.join(__dirname, 'account-overrides.json');
// User-entered assets/liabilities that live outside Actual (car, home, cash,
// crypto) and roll into net worth.
const MANUAL_ASSETS_PATH = process.env.MANUAL_ASSETS_PATH || path.join(__dirname, 'manual-assets.json');
const INVESTMENT_HOLDINGS_PATH = process.env.INVESTMENT_HOLDINGS_PATH || path.join(__dirname, 'investment-holdings.json');
const DEBT_PLANNER_PATH = process.env.DEBT_PLANNER_PATH || path.join(__dirname, 'debt-planner.json');
// Monthly reconciliation: opt-in month-end review where each expense is checked
// off and then the whole month is closed. Stores the enabled flag + per-month,
// per-transaction reconcile marks so the app can nag until a month is cleared.
const RECON_PATH = process.env.RECON_PATH || path.join(__dirname, 'reconciliation.json');
function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fallback; }
}
function writeJsonSafe(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

const config = {
  dataDir: process.env.ACTUAL_DATA_DIR || '/tmp/actual-dashboard-cache',
  serverURL: process.env.ACTUAL_SERVER_URL,
  password: process.env.ACTUAL_PASSWORD,
  syncId: process.env.ACTUAL_SYNC_ID,
};

// ---------------------------------------------------------------------------
// API lifecycle
// ---------------------------------------------------------------------------
let apiReady = false;
let initPromise = null;

async function initApi() {
  if (apiReady) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await loadBudgetResilient();
    apiReady = true;
  })();
  return initPromise;
}

// Self-heal a diverged/corrupt local cache. An Actual `out-of-sync` dataDir
// previously crash-looped the service forever. The Actual API can't re-init
// cleanly within one process, so we don't retry in-process: we wipe the cache
// (it's just a reconstructable mirror of the Actual server at config.serverURL)
// and exit, letting systemd restart us once with a clean dir and a single fresh
// download. A genuinely unreachable server simply keeps retrying until it's back.
async function loadBudgetResilient() {
  try {
    await api.init({ dataDir: config.dataDir, serverURL: config.serverURL, password: config.password });
    await api.downloadBudget(config.syncId);
  } catch (e) {
    console.error('Budget load failed; wiping cache and restarting clean:', (e && e.message) || e);
    try { await fs.promises.rm(config.dataDir, { recursive: true, force: true }); } catch (_) {}
    try { await fs.promises.mkdir(config.dataDir, { recursive: true }); } catch (_) {}
    process.exit(1);
  }
}

async function withApi(fn) {
  await initApi();
  return fn(api);
}

// Pull the latest changes from the Actual server into the local cache. Used by a
// periodic timer in server.js so the dashboard never serves stale post-sync data.
async function syncNow() {
  await initApi();
  await api.sync();
}

// Manual "Sync with bank": fetch fresh transactions from linked banks (SimpleFIN)
// then pull deltas. Resilient — even if the bank fetch fails (provider down), we
// still sync the ledger and report the warning instead of throwing.
async function bankSync() {
  await initApi();
  let warning = null;
  try {
    await api.runBankSync();
  } catch (e) {
    warning = (e && e.message) || 'bank fetch failed';
  }
  await api.sync().catch(() => {});
  return { ok: !warning, warning, at: new Date().toISOString() };
}

// Force a full re-download on next access (used by /api/refresh).
function resetApi() {
  apiReady = false;
  initPromise = null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const todayYMD = () => ymd(new Date());
const d2 = (cents) => Math.round(cents) / 100; // integer cents -> dollars (number)
const round2 = (n) => Math.round(n * 100) / 100;
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return ymd(d);
}
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = arr.reduce((s, x) => s + x, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

// Recurring cadence buckets keyed by typical day-period; the classifier maps a
// median inter-charge gap into one of these named cadences (null = irregular).
const CADENCE_DAYS = { weekly: 7, biweekly: 14, semimonthly: 15.22, monthly: 30.44, bimonthly: 60.88, quarterly: 91.3, semiannual: 182.6, annual: 365.25 };
function classifyCadence(gap) {
  if (gap >= 5 && gap <= 9) return 'weekly';
  if (gap >= 12 && gap <= 14) return 'biweekly';
  // Twice-a-month payroll (e.g. 15th + month-end) alternates ~13–17 day gaps,
  // landing in the dead zone between biweekly and monthly. Treat 15–18 as
  // semimonthly so a paycheck isn't dropped as "irregular".
  if (gap >= 15 && gap <= 18) return 'semimonthly';
  if (gap >= 25 && gap <= 35) return 'monthly';
  if (gap >= 55 && gap <= 70) return 'bimonthly';
  if (gap >= 80 && gap <= 100) return 'quarterly';
  if (gap >= 170 && gap <= 200) return 'semiannual';
  if (gap >= 330 && gap <= 400) return 'annual';
  return null;
}
// Normalize a payee into a stable subscription key (drops store numbers / punctuation).
function recurringKey(payee) {
  return (payee || '')
    .toLowerCase()
    .replace(/[#*]?\d{3,}/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
// Month names (full + 3-letter) for stripping date stamps out of income payees.
const MONTH_RX = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/gi;
// Income-specific key. Banks stamp interest/payroll with the month or a per-deposit
// id, which fragments them under recurringKey. Collapse interest to one stream and
// strip month names so monthly income groups instead of splitting 12 ways.
function incomeKey(payee, note) {
  const s = (payee || '').toLowerCase();
  if (/\binterest\b/.test(s)) return 'interest';
  // Payroll/ACH deposits arrive with inconsistent payee text per deposit (e.g.
  // "GMC" one cycle, "Salary Payroll E Vendor Dirdps" the next) but carry a
  // stable ACH originator id ("PPD ID: 9GM-DIRDPS"). Group by that id so a
  // paycheck collapses into one stream instead of fragmenting into one-offs.
  const ppd = ((note || '').match(/ppd id:\s*([a-z0-9-]+)/i) || [])[1];
  if (ppd) return `ppd:${ppd.toLowerCase()}`;
  return recurringKey(s.replace(MONTH_RX, ' '));
}
// Generic ACH/payroll boilerplate that makes a deposit's payee text unhelpful.
const PAYROLL_NOISE = /payroll|vendor|salary|dirdps|direct dep|division|\bpmt\b|\bppd\b|\bach\b|\bdep\b/i;
// Pick the cleanest display name among a grouped stream's varied payee strings:
// fewest boilerplate words wins, then the shorter one (so "GMC" beats
// "Salary Payroll E Vendor Dirdps").
function bestPayeeLabel(names) {
  const list = [...new Set((names || []).filter(Boolean))];
  if (!list.length) return 'Income';
  return list
    .map((n) => ({ n, noise: (n.match(new RegExp(PAYROLL_NOISE, 'gi')) || []).length, len: n.length }))
    .sort((a, b) => a.noise - b.noise || a.len - b.len)[0].n;
}

// Categories that read as genuine bills/subscriptions — these may legitimately
// swing in amount month to month (utilities especially), so we relax the
// amount-consistency gate for them.
const BILL_CAT = /(util|electric|power|energy|\bgas\b|water|sewer|trash|internet|cable|phone|mobile|wireless|insuranc|rent|mortgage|\bloan|subscription|membership|fitness|gym|\bhealth|software|hosting|cloud|stream|donat|charit)/i;
// Strict "must-pay bill" categories (a due date you owe): housing, utilities,
// connectivity, insurance, loans. Excludes discretionary recurring spend
// (streaming/software/gym/cloud) which we treat as subscriptions instead. Drives
// the Bills view vs the Subscriptions view so the two don't overlap.
const BILL_DUE_CAT = /(util|electric|power|energy|\bgas\b|water|sewer|trash|internet|cable|phone|mobile|wireless|insuranc|rent|mortgage|\bloan)/i;
// Categories that are essentially never recurring subscriptions — discretionary
// spend that merely happens at the same merchant repeatedly (dining, coffee…).
const BLOCK_CAT = /(dining|restaurant|fast.?food|coffee|caf|grocer|\bfood|snack|\bbar\b|alcohol|\bdrink|rideshare|uber|lyft|taxi|\bfuel|gas station|shopping|clothing|apparel|retail|merch|amazon|walmart|\btarget\b|travel|hotel|lodging|flight|airfare|parking|\btoll|pharmacy|convenience|fun money|spending money|personal care)/i;

// Normalizing month range; handles negative / overflow month indices.
function monthRange(year, monthIdx) {
  const startD = new Date(year, monthIdx, 1);
  const endD = new Date(year, monthIdx + 1, 0);
  return { start: ymd(startD), end: ymd(endD), key: `${startD.getFullYear()}-${pad2(startD.getMonth() + 1)}` };
}
function firstOfThisMonth() {
  const n = new Date();
  return ymd(new Date(n.getFullYear(), n.getMonth(), 1));
}

// ---------------------------------------------------------------------------
// Category classification
// ---------------------------------------------------------------------------
function envRegex(name, fallback) {
  const src = process.env[name];
  if (!src) return fallback;
  try { return new RegExp(src, 'i'); }
  catch (e) {
    console.warn(`[config] ignoring invalid ${name}: ${e.message}`);
    return fallback;
  }
}
const INCOME_GROUP = envRegex('INCOME_GROUP_PATTERN', /^income$/i);
const MONEY_MOVEMENT_GROUP = envRegex('MONEY_MOVEMENT_GROUP_PATTERN', /money\s*movement/i);
const MM_CAT = envRegex('MONEY_MOVEMENT_CATEGORY_PATTERN', /^(transfers?|investments?|credit\s*card\s*payments?|cc\s*payments?)$/i);
const REIMB_CAT = envRegex('REIMBURSEMENT_CATEGORY_PATTERN', /^reimbursement$/i);
const TRANSFER_PAYEE = envRegex('TRANSFER_PAYEE_PATTERN', /^transfer\s*:?\s*(to|from)\b|\btransfer (to|from)\b/i);
// Peer settle-ups (Splitwise/Venmo/etc.) frequently import as "Other Income",
// which inflates real income. They're a payback (money movement), not earnings,
// so they get refiled under Reimbursement — see refileSettleUps().
const SETTLE_UP_PAYEE = envRegex('SETTLE_UP_PAYEE_PATTERN', /splitwise|venmo|cash\s?app|zelle|paypal/i);

function buildCatInfo(groups) {
  const catInfo = {}; // id -> { name, group, kind, isIncome, isMovement }
  for (const g of groups) {
    const incomeGroup = g.is_income === true || INCOME_GROUP.test(g.name || '');
    const mmGroup = MONEY_MOVEMENT_GROUP.test(g.name || '');
    for (const c of g.categories || []) {
      let kind = 'spend';
      if (incomeGroup) kind = 'income';
      else if (REIMB_CAT.test(c.name || '')) kind = 'reimb';
      else if (mmGroup || MM_CAT.test(c.name || '')) kind = 'mm';
      catInfo[c.id] = { name: c.name, group: g.name, kind, isIncome: incomeGroup, isMovement: mmGroup };
    }
  }
  return catInfo;
}

// Flatten a transaction into classified leaves (split-aware). Drops parent shells.
function leavesOf(t, parentTransfer) {
  if (t.is_parent && Array.isArray(t.subtransactions) && t.subtransactions.length) {
    return t.subtransactions.map((s, i) => ({
      amount: s.amount, catId: s.category, notes: s.notes, transfer: !!s.transfer_id,
      id: s.id || `${t.id}-${i}`, parentId: t.id, isLeg: true,
    }));
  }
  if (!t.is_parent) return [{
    amount: t.amount, catId: t.category, notes: t.notes, transfer: parentTransfer,
    id: t.id, parentId: null, isLeg: false,
  }];
  return [];
}

// ---------------------------------------------------------------------------
// Core getters (mirror legacy endpoints)
// ---------------------------------------------------------------------------
async function getAccounts() {
  return withApi(async (api) => {
    // Hide the "Splitwise" spend-attribution ledger: its expenses count as spend
    // (read straight from Actual), but it isn't real cash, so it must stay out of
    // the account list + the app's net-worth sum.
    const accounts = (await api.getAccounts()).filter((a) => !a.closed && (a.name || '').toLowerCase() !== SW_ACCOUNT_NAME.toLowerCase());
    const overrides = readJsonSafe(ACCOUNT_OVERRIDES_PATH, {});
    return Promise.all(
      accounts.map(async (a) => {
        const ov = overrides[a.id] || {};
        return {
          id: a.id,
          name: ov.name || a.name, // display rename (Actual name untouched)
          offbudget: !!a.offbudget,
          balance: (await api.getAccountBalance(a.id)) / 100,
          hidden: !!ov.hidden,
        };
      })
    );
  });
}

function setAccountOverride({ id, name, hidden } = {}) {
  if (!id) throw new Error('id required');
  const overrides = readJsonSafe(ACCOUNT_OVERRIDES_PATH, {});
  const cur = overrides[id] || {};
  if (name !== undefined) {
    const trimmed = (name || '').trim();
    if (trimmed) cur.name = trimmed;
    else delete cur.name; // empty resets to the Actual name
  }
  if (hidden !== undefined) {
    if (hidden) cur.hidden = true;
    else delete cur.hidden;
  }
  if (Object.keys(cur).length) overrides[id] = cur;
  else delete overrides[id];
  writeJsonSafe(ACCOUNT_OVERRIDES_PATH, overrides);
  return { ok: true, id, override: overrides[id] || null };
}

// ---------------------------------------------------------------------------
// Manual (off-Actual) assets & liabilities that roll into net worth
// ---------------------------------------------------------------------------
function getManualAssets() {
  const store = readJsonSafe(MANUAL_ASSETS_PATH, { items: [] });
  const items = Array.isArray(store.items) ? store.items : [];
  const assets = round2(items.filter((i) => i.kind !== 'liability').reduce((s, i) => s + (Number(i.value) || 0), 0));
  const liabilities = round2(items.filter((i) => i.kind === 'liability').reduce((s, i) => s + (Number(i.value) || 0), 0));
  return { items, assets, liabilities, net: round2(assets - liabilities) };
}

function saveManualAsset({ id, name, value, kind } = {}) {
  const nm = (name || '').trim();
  const val = Math.abs(Number(value) || 0);
  if (!nm) throw new Error('name required');
  if (!val) throw new Error('value must be greater than 0');
  const k = kind === 'liability' ? 'liability' : 'asset';
  const store = readJsonSafe(MANUAL_ASSETS_PATH, { items: [] });
  if (!Array.isArray(store.items)) store.items = [];
  const now = todayYMD();
  if (id) {
    const item = store.items.find((i) => i.id === id);
    if (!item) throw new Error('asset not found');
    Object.assign(item, { name: nm, value: val, kind: k, updated: now });
  } else {
    id = 'm' + Date.now().toString(36);
    store.items.push({ id, name: nm, value: val, kind: k, updated: now });
  }
  writeJsonSafe(MANUAL_ASSETS_PATH, store);
  return { ok: true, id };
}

function deleteManualAsset({ id } = {}) {
  if (!id) throw new Error('id required');
  const store = readJsonSafe(MANUAL_ASSETS_PATH, { items: [] });
  const before = (store.items || []).length;
  store.items = (store.items || []).filter((i) => i.id !== id);
  writeJsonSafe(MANUAL_ASSETS_PATH, store);
  return { ok: true, removed: before - store.items.length };
}

function payoffProjection(debt) {
  const balance = Math.max(0, Number(debt.balance) || 0);
  const apr = Math.max(0, Number(debt.apr) || 0);
  const payment = Math.max(0, Number(debt.minPayment) || 0);
  if (!balance || !payment) return { months: null, totalInterest: null, payoffDate: null };
  let bal = balance;
  let interest = 0;
  let months = 0;
  const monthlyRate = apr / 100 / 12;
  while (bal > 0.005 && months < 600) {
    const charge = bal * monthlyRate;
    if (payment <= charge && monthlyRate > 0) return { months: null, totalInterest: null, payoffDate: null };
    interest += charge;
    bal = Math.max(0, bal + charge - payment);
    months++;
  }
  return { months, totalInterest: round2(interest), payoffDate: addDays(todayYMD(), Math.round(months * 30.44)) };
}

function getInvestments() {
  const hStore = readJsonSafe(INVESTMENT_HOLDINGS_PATH, { holdings: [] }) || {};
  const dStore = readJsonSafe(DEBT_PLANNER_PATH, { debts: [] }) || {};
  const holdings = (Array.isArray(hStore.holdings) ? hStore.holdings : []).map((h) => {
    const quantity = Number(h.quantity) || 0;
    const price = Number(h.price) || 0;
    const value = round2(Number(h.value) || quantity * price);
    const costBasis = h.costBasis == null ? null : round2(Number(h.costBasis) || 0);
    const gainLoss = costBasis == null ? null : round2(value - costBasis);
    const gainLossPct = costBasis && costBasis > 0 ? round2((gainLoss / costBasis) * 100) : null;
    return {
      symbol: h.symbol || '',
      name: h.name || h.symbol || 'Holding',
      account: h.account || 'Investments',
      assetClass: h.assetClass || 'Unclassified',
      quantity,
      price,
      value,
      costBasis,
      gainLoss,
      gainLossPct,
    };
  }).filter((h) => h.value > 0);
  const byAssetClass = {};
  const byAccount = {};
  for (const h of holdings) {
    byAssetClass[h.assetClass] = round2((byAssetClass[h.assetClass] || 0) + h.value);
    byAccount[h.account] = round2((byAccount[h.account] || 0) + h.value);
  }
  const debts = (Array.isArray(dStore.debts) ? dStore.debts : []).map((d) => {
    const projection = payoffProjection(d);
    return {
      id: d.id || slugify(d.name || 'debt'),
      name: d.name || 'Debt',
      balance: round2(Number(d.balance) || 0),
      apr: Number(d.apr) || 0,
      minPayment: round2(Number(d.minPayment) || 0),
      dueDate: d.dueDate || null,
      strategy: d.strategy || 'avalanche',
      ...projection,
    };
  }).filter((d) => d.balance > 0).sort((a, b) => b.apr - a.apr || a.balance - b.balance);
  const debtBalance = debts.reduce((s, d) => s + d.balance, 0);
  return {
    generatedAt: new Date().toISOString(),
    holdings,
    totals: {
      value: round2(holdings.reduce((s, h) => s + h.value, 0)),
      costBasis: round2(holdings.reduce((s, h) => s + (h.costBasis || 0), 0)),
      gainLoss: round2(holdings.reduce((s, h) => s + (h.gainLoss || 0), 0)),
    },
    allocation: { byAssetClass, byAccount },
    debts,
    debtTotals: {
      balance: round2(debtBalance),
      minPayment: round2(debts.reduce((s, d) => s + d.minPayment, 0)),
      weightedApr: debtBalance ? round2(debts.reduce((s, d) => s + d.apr * d.balance, 0) / debtBalance) : 0,
    },
  };
}

// collapse=true renders each split as ONE parent row (for account/activity lists);
// collapse=false explodes splits into their legs (for category/merchant/tag drill-downs).
async function getTransactions({ accountId, start, end, category, collapse } = {}) {
  return withApi(async (api) => {
    const startDate = start || firstOfThisMonth();
    const endDate = end || todayYMD();
    const wantCat = category ? String(category).toLowerCase() : null;
    const accountsFull = await api.getAccounts();
    const acctMap = Object.fromEntries(accountsFull.map((a) => [a.id, a.name]));
    const targetAccts = accountId
      ? accountsFull.filter((a) => a.id === accountId)
      : accountsFull.filter((a) => !a.closed);
    const categories = await api.getCategories();
    const catMap = Object.fromEntries(categories.map((c) => [c.id, c.name]));
    const payees = await api.getPayees();
    const payeeMap = Object.fromEntries(payees.map((p) => [p.id, p.name]));

    let all = [];
    for (const acct of targetAccts) {
      const txns = await api.getTransactions(acct.id, startDate, endDate);
      for (const t of txns) {
        const parentPayee = payeeMap[t.payee] || t.imported_payee || '';
        const base = {
          date: t.date,
          payee: parentPayee,
          account: acctMap[acct.id] || acct.id,
          accountId: acct.id,
          cleared: t.cleared,
          imported: !!t.imported_id, // bank-imported rows aren't user-deletable (see delete guard)
        };
        const subs = Array.isArray(t.subtransactions) ? t.subtransactions : [];
        if (t.is_parent && subs.length) {
          if (collapse) {
            // One row for the whole split; the app shows a split glyph + "N".
            all.push({
              ...base,
              id: t.id,
              parentId: null,
              isLeg: false,
              isSplit: true,
              splitCount: subs.length,
              amount: t.amount / 100,
              category: 'Split',
              categoryId: null,
              notes: t.notes || '',
            });
          } else {
            subs.forEach((s, i) =>
              all.push({
                ...base,
                // a named leg shows its own payee; otherwise it inherits the parent's
                payee: (s.payee && payeeMap[s.payee]) || parentPayee,
                id: s.id || `${t.id}-${i}`,
                parentId: t.id,
                isLeg: true,
                amount: s.amount / 100,
                category: catMap[s.category] || null,
                categoryId: s.category || null,
                notes: s.notes || t.notes || '',
              })
            );
          }
        } else if (!t.is_parent) {
          all.push({
            ...base,
            id: t.id,
            parentId: null,
            isLeg: false,
            amount: t.amount / 100,
            category: catMap[t.category] || null,
            categoryId: t.category || null,
            notes: t.notes || '',
          });
        }
      }
    }
    if (wantCat === 'uncategorized') all = all.filter((t) => !t.category);
    else if (wantCat) all = all.filter((t) => (t.category || '').toLowerCase() === wantCat);
    all.sort((a, b) => b.date.localeCompare(a.date));
    return all;
  });
}

// Create a transaction (manual add). Writes to the REAL Actual budget. Amount is
// in dollars (negative = expense, positive = income); resolves/creates the payee
// by name. addTransactions (not importTransactions) so Actual's import dedup
// can't silently drop a legitimate manual entry.
async function createTransaction({ accountId, amount, payee, date, categoryId, notes } = {}) {
  return withApi(async (api) => {
    if (!accountId) throw new Error('accountId required');
    const amt = Number(amount);
    if (!isFinite(amt) || amt === 0) throw new Error('a non-zero amount is required');
    const name = (payee || '').trim();
    let payeeId;
    if (name) {
      try {
        const payees = await api.getPayees();
        const found = payees.find((p) => (p.name || '').toLowerCase() === name.toLowerCase());
        payeeId = found ? found.id : await api.createPayee({ name });
      } catch (_) { /* payee best-effort; keep the name in notes below if unresolved */ }
    }
    const txn = {
      date: date || todayYMD(),
      amount: Math.round(amt * 100), // dollars -> integer cents
      payee: payeeId || undefined,
      category: categoryId || undefined,
      notes: notes || (payeeId ? undefined : name) || undefined,
      cleared: false,
    };
    const res = await api.addTransactions(accountId, [txn], { learnCategories: false, runTransfers: false });
    await syncNow().catch(() => {}); // persist the write back to the Actual server
    const id = Array.isArray(res) ? res[0] : res && Array.isArray(res.added) ? res.added[0] : null;
    return { ok: true, id: id || null };
  });
}

function summarize(leaves, catInfo) {
  const spending = {};
  let totalSpend = 0;
  let totalIncome = 0;
  for (const t of leaves) {
    const meta = catInfo[t.catId];
    const kind = meta ? meta.kind : 'uncat';
    if (kind === 'mm' || kind === 'reimb') continue; // not spending
    const amt = t.amount / 100;
    if (kind === 'income') {
      totalIncome += amt;
      continue;
    }
    // Uncategorized inflows are almost always income/transfers that simply
    // haven't been filed under an Income category — never let them net against
    // (and deflate) real spending. Categorized refunds still net per-category.
    if (kind === 'uncat' && amt > 0) continue;
    const name = meta ? meta.name : 'Uncategorized';
    totalSpend += -amt;
    spending[name] = (spending[name] || 0) - amt;
  }
  for (const k of Object.keys(spending)) if (Math.abs(spending[k]) < 0.005) delete spending[k];
  return { spending, totalSpend, totalIncome };
}

async function onBudgetLeaves(api, start, end, catInfo) {
  const accounts = (await api.getAccounts()).filter((a) => !a.closed && !a.offbudget);
  const out = [];
  for (const acct of accounts) {
    const txns = await api.getTransactions(acct.id, start, end);
    for (const t of txns) for (const lf of leavesOf(t, false)) out.push(lf);
  }
  return out;
}

async function getSpending({ month } = {}) {
  return withApi(async (api) => {
    const now = new Date();
    let year, mIdx;
    if (month) {
      const [Y, M] = month.split('-').map(Number);
      year = Y;
      mIdx = M - 1;
    } else {
      year = now.getFullYear();
      mIdx = now.getMonth();
    }
    const cur = monthRange(year, mIdx);
    const prev = monthRange(year, mIdx - 1);
    const isCurrent = year === now.getFullYear() && mIdx === now.getMonth();
    const curEnd = isCurrent ? todayYMD() : cur.end;

    const groups = await api.getCategoryGroups();
    const catInfo = buildCatInfo(groups);
    const [current, previous] = await Promise.all([
      onBudgetLeaves(api, cur.start, curEnd, catInfo),
      onBudgetLeaves(api, prev.start, prev.end, catInfo),
    ]);
    return {
      current: summarize(current, catInfo),
      prev: summarize(previous, catInfo),
      month: cur.key,
    };
  });
}

// ---------------------------------------------------------------------------
// Trends — net worth / spend / income by month
// ---------------------------------------------------------------------------
async function getTrends({ months = 12 } = {}) {
  return withApi(async (api) => {
    const groups = await api.getCategoryGroups();
    const catInfo = buildCatInfo(groups);
    const accounts = (await api.getAccounts()).filter((a) => !a.closed);
    const now = new Date();

    const buckets = [];
    for (let i = months - 1; i >= 0; i--) {
      const r = monthRange(now.getFullYear(), now.getMonth() - i);
      buckets.push({ ...r, income: 0, expense: 0 });
    }
    const byKey = Object.fromEntries(buckets.map((b) => [b.key, b]));
    const lastEnd = buckets[buckets.length - 1].end;

    const contributions = []; // {date, amount} parent totals across ALL accounts (net worth)
    for (const a of accounts) {
      const txns = await api.getTransactions(a.id, '2000-01-01', lastEnd);
      // The "Splitwise" account is a spend-attribution ledger (my share of items a
      // friend paid), not real cash — count its expenses toward monthly spend but
      // keep it out of net worth so a growing share balance can't sink it.
      const isSwLedger = (a.name || '').toLowerCase() === SW_ACCOUNT_NAME.toLowerCase();
      for (const t of txns) {
        if (!isSwLedger) contributions.push({ date: t.date, amount: t.amount });
        if (a.offbudget) continue;
        const b = byKey[t.date.slice(0, 7)];
        if (!b) continue;
        for (const lf of leavesOf(t, false)) {
          const meta = catInfo[lf.catId];
          const kind = meta ? meta.kind : 'uncat';
          if (kind === 'mm' || kind === 'reimb') continue;
          if (kind === 'income') b.income += lf.amount;
          else if (kind === 'uncat' && lf.amount > 0) continue; // uncategorized income, not negative spend
          else b.expense += -lf.amount;
        }
      }
    }

    contributions.sort((x, y) => (x.date < y.date ? -1 : 1));
    let idx = 0;
    let run = 0;
    const series = buckets.map((b) => {
      while (idx < contributions.length && contributions[idx].date <= b.end) {
        run += contributions[idx].amount;
        idx++;
      }
      return {
        month: b.key,
        netWorth: d2(run),
        spend: d2(b.expense),
        income: d2(b.income),
        net: d2(b.income - b.expense),
      };
    });
    return { months: series };
  });
}

// ---------------------------------------------------------------------------
// Budgets — Actual budgeted vs actual per category
// ---------------------------------------------------------------------------
function loadBudgetSettings() {
  const raw = readJsonSafe(BUDGET_SETTINGS_PATH, {}) || {};
  return {
    categories: raw.categories && typeof raw.categories === 'object' ? raw.categories : {},
    defaults: raw.defaults && typeof raw.defaults === 'object' ? raw.defaults : {},
  };
}

function monthProgress(m) {
  const [y, mo] = String(m).split('-').map(Number);
  const days = new Date(y, mo, 0).getDate();
  const cur = todayYMD().slice(0, 7);
  const today = Number(todayYMD().slice(8, 10));
  const elapsed = m === cur ? Math.min(today, days) : (m < cur ? days : 0);
  return { days, elapsed: Math.max(1, elapsed || 1) };
}

async function getBudgets({ month } = {}) {
  return withApi(async (api) => {
    const m = month || todayYMD().slice(0, 7);
    const settings = loadBudgetSettings();
    const progress = monthProgress(m);
    let bm;
    try {
      bm = await api.getBudgetMonth(m);
    } catch (e) {
      return { month: m, supported: false, groups: [], totalBudgeted: 0, totalSpent: 0 };
    }
    const groups = [];
    for (const g of bm.categoryGroups || []) {
      if (g.is_income) continue;
      if (MONEY_MOVEMENT_GROUP.test(g.name || '')) continue; // transfers/investments/CC payments aren't spend
      const cats = (g.categories || [])
        .filter((c) => !REIMB_CAT.test(c.name || '')) // peer debts aren't spend
        .map((c) => {
          const meta = { ...settings.defaults, ...(settings.categories[c.id] || {}), ...(settings.categories[c.name] || {}) };
          const budgeted = (c.budgeted || 0) / 100;
          const spent = Math.abs(c.spent || 0) / 100;
          const target = Number(meta.monthlyTarget ?? budgeted) || 0;
          const annualTarget = Number(meta.annualTarget || 0) || null;
          const remaining = round2(Math.max(0, target - spent));
          const projected = progress.elapsed > 0 ? round2((spent / progress.elapsed) * progress.days) : spent;
          const expectedToDate = target > 0 ? round2((target / progress.days) * progress.elapsed) : null;
          const rolloverMode = meta.rolloverMode || 'none';
          const rolloverAmount = rolloverMode === 'none' ? 0 : round2((c.balance || 0) / 100);
          const snoozed = meta.snoozedMonth === m;
          const status = snoozed
            ? 'snoozed'
            : target > 0 && spent > target
              ? 'over'
              : target > 0 && projected > target * 1.05
                ? 'watch'
                : 'on_track';
          return {
            id: c.id,
            name: c.name,
            budgeted,
            spent,
            balance: (c.balance || 0) / 100,
            pct: target > 0 ? Math.min(999, Math.round((spent / target) * 100)) : null,
            over: target > 0 && spent > target,
            target,
            annualTarget,
            remaining,
            projected,
            expectedToDate,
            dailyPace: target > 0 ? round2(target / progress.days) : 0,
            status,
            rolloverMode,
            rolloverAmount,
            trueExpenseCadence: meta.trueExpenseCadence || null,
            snoozedMonth: meta.snoozedMonth || null,
            priority: meta.priority || null,
            linkedGoal: meta.linkedGoal || null,
          };
        })
        .filter((c) => c.budgeted > 0 || c.spent > 0)
        .sort((a, b) => b.spent - a.spent);
      if (!cats.length) continue;
      groups.push({
        id: g.id,
        name: g.name,
        budgeted: cats.reduce((s, c) => s + c.budgeted, 0),
        target: cats.reduce((s, c) => s + c.target, 0),
        spent: cats.reduce((s, c) => s + c.spent, 0),
        remaining: cats.reduce((s, c) => s + c.remaining, 0),
        projected: cats.reduce((s, c) => s + c.projected, 0),
        status: cats.some((c) => c.status === 'over') ? 'over' : cats.some((c) => c.status === 'watch') ? 'watch' : cats.every((c) => c.status === 'snoozed') ? 'snoozed' : 'on_track',
        categories: cats,
      });
    }
    const totalTarget = groups.reduce((s, g) => s + g.target, 0);
    const totalSpent = groups.reduce((s, g) => s + g.spent, 0);
    const totalRemaining = groups.reduce((s, g) => s + g.remaining, 0);
    const totalProjected = groups.reduce((s, g) => s + g.projected, 0);
    return {
      month: m,
      supported: true,
      totalBudgeted: groups.reduce((s, g) => s + g.budgeted, 0),
      totalTarget,
      totalSpent,
      totalRemaining,
      totalProjected,
      daysInMonth: progress.days,
      daysElapsed: progress.elapsed,
      status: totalTarget > 0 && totalSpent > totalTarget ? 'over' : totalTarget > 0 && totalProjected > totalTarget * 1.05 ? 'watch' : 'on_track',
      groups,
    };
  });
}

// Set the monthly budgeted target for a category (dollars -> integer cents).
// Wraps Actual's setBudgetAmount; amount 0 clears the target.
async function setBudgetAmount({ month, categoryId, amount } = {}) {
  if (!categoryId) throw new Error('categoryId required');
  const m = month || todayYMD().slice(0, 7);
  const cents = Math.round(Number(amount) * 100);
  if (!Number.isFinite(cents) || cents < 0) throw new Error('amount must be a number >= 0');
  return withApi(async (api) => {
    await api.setBudgetAmount(m, categoryId, cents);
    return { ok: true, month: m, categoryId, amount: cents / 100 };
  });
}

// ---------------------------------------------------------------------------
// Reimbursement — "who owes me" ledger (port of reimb-report.js, structured)
// ---------------------------------------------------------------------------
// Your roster of people (names/slugs/aliases) lives OUTSIDE the code so this repo
// can be open-sourced without leaking anyone's name. Real values go in
// personal-config.json (gitignored); see personal-config.example.json for the shape.
// Absent => harmless generic placeholders (attribution simply won't match real people
// until you add your own config). loadOwesConfig() also folds in owes-config.json.
const PERSONAL_CONFIG_PATH = process.env.PERSONAL_CONFIG_PATH || path.join(__dirname, 'personal-config.json');
const _roster = readJsonSafe(PERSONAL_CONFIG_PATH, null) || {};
const PEOPLE = new Set(
  (Array.isArray(_roster.people) && _roster.people.length ? _roster.people : ['alex', 'sam', 'jordan', 'taylor'])
    .map((s) => String(s).toLowerCase())
);
const NAME_MAP = (Array.isArray(_roster.nameMap) && _roster.nameMap.length
  ? _roster.nameMap
  : [['alex', 'alex'], ['sam', 'sam'], ['jordan', 'jordan'], ['taylor', 'taylor']]
).map(([a, b]) => [String(a).toLowerCase(), String(b).toLowerCase()]);
let SETTLED_PREPAID;
try { SETTLED_PREPAID = new RegExp(_roster.settledPrepaid || 'a^', 'i'); } catch (_) { SETTLED_PREPAID = /a^/; }
const GROUP_MARKERS = /roommates|others'|others |fronted for group|group-fronted|\bgroup\b/i;

function slugFromName(raw) {
  const low = raw.trim().toLowerCase();
  for (const [sub, slug] of NAME_MAP) if (low.includes(sub)) return slug;
  const first = low.split(/\s+/)[0];
  return PEOPLE.has(first) ? first : null;
}
function attribute(label, notes) {
  const note = notes || '';
  const tags = (note.match(/#[a-z0-9_-]+/gi) || []).map((s) => s.slice(1).toLowerCase());
  if (tags.includes('adj') || /\[sw-adj\]/i.test(note) || /offset:\s*my share/i.test(note))
    return { person: '(self-offset)', event: null, exclude: true, how: 'tag/adj' };
  if (tags.includes('settled') || SETTLED_PREPAID.test(`${label} ${note}`))
    return { person: '(settled-prepaid)', event: null, exclude: true, how: 'settled' };
  const event = (tags.find((t) => t.startsWith('ev-')) || '').replace(/^ev-/, '') || null;
  const tagPerson = tags.find((t) => PEOPLE.has(t));
  if (tagPerson) return { person: tagPerson, event, how: 'tag' };
  const text = `${label} ${note}`;
  let m = text.match(/\b(?:from|to)\s+([A-Za-z][A-Za-z .'-]+?)(?:\s+[A-Z0-9]{6,}|\s*$|\s*\|)/);
  if (m) { const s = slugFromName(m[1]); if (s) return { person: s, event, how: 'zelle' }; }
  const trail = [...text.matchAll(/-\s*([A-Z][a-z]+)\b/g)];
  if (trail.length) { const s = slugFromName(trail[trail.length - 1][1]); if (s) return { person: s, event, how: 'dash' }; }
  const low = text.toLowerCase();
  for (const [sub, slug] of NAME_MAP) if (low.includes(sub)) return { person: slug, event, how: 'map' };
  if (GROUP_MARKERS.test(text)) return { person: '(group/unsplit)', event, how: 'group' };
  return { person: '(unattributed)', event, how: 'none' };
}

// Defaults preserve prior hardcoded behavior when owes-config.json is absent.
// Amounts are in integer cents (e.g. 25488 = $254.88). Debtor patterns are
// stored as strings (case-insensitive) so the config stays plain JSON.
// Generic fallback used only when owes-config.json is absent (public repo). Your
// real amounts/patterns/trips live in the gitignored owes-config.json; see
// owes-config.example.json. Keeping this empty means no personal data ships in code.
const DEFAULT_OWES = {
  expected: {},
  debtorPatterns: {},
  tripStart: {},
  swNet: [],
  settledExt: [],
  autoReimbTags: [],
  eventStatus: {},
  autoDetectExcludeEvents: [],
};

// Read + normalize the editable owes-config (falling back to defaults). Compiles
// debtor patterns to RegExp and teaches the attributor about any newly named
// people so their #tags / name matches are recognized.
function loadOwesConfig() {
  const cfg = readJsonSafe(OWES_CONFIG_PATH, null) || {};
  const expected = cfg.expected && typeof cfg.expected === 'object' ? cfg.expected : DEFAULT_OWES.expected;
  const tripStart = cfg.tripStart && typeof cfg.tripStart === 'object' ? cfg.tripStart : DEFAULT_OWES.tripStart;
  const patterns = cfg.debtorPatterns && typeof cfg.debtorPatterns === 'object' ? cfg.debtorPatterns : DEFAULT_OWES.debtorPatterns;
  const swNet = new Set(Array.isArray(cfg.swNet) ? cfg.swNet : DEFAULT_OWES.swNet);
  const settledExt = new Set(Array.isArray(cfg.settledExt) ? cfg.settledExt : DEFAULT_OWES.settledExt);
  const eventStatus = cfg.eventStatus && typeof cfg.eventStatus === 'object' ? cfg.eventStatus : DEFAULT_OWES.eventStatus;
  const autoDetectExcludeEvents = new Set(
    (Array.isArray(cfg.autoDetectExcludeEvents) ? cfg.autoDetectExcludeEvents : DEFAULT_OWES.autoDetectExcludeEvents)
      .map((s) => String(s).toLowerCase())
  );
  // People whose expenses the user merely fronts (e.g. a roommate's bills).
  // Tagging a charge with one of these auto-files it under Reimbursement on next sync
  // so it leaves personal spending and shows up as owed in Who-Owes-Me.
  const autoReimbTags = (Array.isArray(cfg.autoReimbTags) ? cfg.autoReimbTags : DEFAULT_OWES.autoReimbTags).map((s) => String(s).toLowerCase());
  // Manual per-person trip overrides that WIN over the auto Splitwise snapshot
  // (which can lag or miss a group — e.g. a settle-up that wasn't actually paid).
  // Shape: { slug: [{ event, amount }] }. amount 0 clears that event's debt.
  const manualTrips = cfg.manualTrips && typeof cfg.manualTrips === 'object' ? cfg.manualTrips : {};
  const debtorRe = {};
  for (const [slug, src] of Object.entries(patterns)) {
    try { debtorRe[slug] = new RegExp(src, 'i'); } catch (_) { /* skip invalid pattern */ }
  }
  for (const slug of new Set([...Object.keys(patterns), ...Object.values(expected).flatMap((m) => Object.keys(m)), ...Object.keys(manualTrips)])) {
    PEOPLE.add(slug);
    if (!NAME_MAP.some(([, s]) => s === slug)) NAME_MAP.push([slug, slug]);
  }
  return { expected, debtorRe, tripStart, swNet, settledExt, autoReimbTags, manualTrips, eventStatus, autoDetectExcludeEvents };
}

// Read the authoritative who-owes-me snapshot (Splitwise pairwise). Returns null
// when absent/invalid so callers fall back to the legacy baseline. Shape:
//   { generatedAt, source, events:[...], bySlug:{ slug:[{event,amount}] }, total }
function loadOwesTruth() {
  const t = readJsonSafe(OWES_TRUTH_PATH, null);
  if (!t || typeof t !== 'object' || !t.bySlug || typeof t.bySlug !== 'object') return null;
  const src = String(t.source || '');
  if (src && !/^splitwise-pairwise\b/i.test(src)) {
    return { ...t, warning: 'non-pairwise-snapshot-source' };
  }
  return t;
}
// Venmo sidecar — same shape as owes-truth. Null when absent/invalid.
function loadVenmoTruth() {
  const t = readJsonSafe(VENMO_TRUTH_PATH, null);
  if (!t || typeof t !== 'object' || !t.bySlug || typeof t.bySlug !== 'object') return null;
  return t;
}

// ---------------------------------------------------------------------------
// Events / trips — a named grouping you tag transactions into with #ev-<slug>.
// Stored as a sidecar; owes-snapshot.js reads the same file to wire a trip's
// Splitwise group into the who-owes-me snapshot automatically.
// ---------------------------------------------------------------------------
const slugify = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
function readEvents() {
  const s = readJsonSafe(EVENTS_PATH, { events: [] });
  return { events: s && Array.isArray(s.events) ? s.events : [] };
}
async function getEvents() {
  const { events } = readEvents();
  // Enrich each event with its tagged-charge count + total from the ledger window.
  let tagCounts = {};
  try {
    tagCounts = await withApi(async (api) => {
      const accts = (await api.getAccounts()).filter((a) => !a.closed);
      const from = addDays(todayYMD(), -400);
      const counts = {};
      for (const a of accts) {
        const tx = await api.getTransactions(a.id, from, todayYMD());
        for (const t of tx) {
          const scan = (notes) => { const m = (notes || '').match(/#ev-([a-z0-9-]+)/gi) || []; for (const tag of m) { const slug = tag.slice(4).toLowerCase(); counts[slug] = counts[slug] || { count: 0, spent: 0 }; counts[slug].count++; } };
          scan(t.notes);
          for (const sub of t.subtransactions || []) scan(sub.notes);
        }
      }
      return counts;
    });
  } catch (_) { /* best-effort enrichment */ }
  return {
    events: events
      .slice()
      .sort((a, b) => (b.start || '').localeCompare(a.start || '') || (b.created || '').localeCompare(a.created || ''))
      .map((e) => ({ ...e, taggedCount: (tagCounts[e.slug] || {}).count || 0 })),
  };
}
function saveEvent({ slug, name, start, members, group } = {}) {
  const nm = (name || '').trim();
  if (!nm && !slug) throw new Error('name required');
  const s = slug ? slugify(slug) : slugify(nm);
  if (!s) throw new Error('a valid name/slug is required');
  const store = readEvents();
  const mem = Array.isArray(members)
    ? members.map((m) => slugify(m)).filter(Boolean)
    : String(members || '').split(/[,\n]/).map((m) => slugify(m)).filter(Boolean);
  const existing = store.events.find((e) => e.slug === s);
  const rec = {
    slug: s,
    name: nm || (existing && existing.name) || s,
    start: start || (existing && existing.start) || todayYMD(),
    members: mem.length ? mem : (existing && existing.members) || [],
    group: (group != null ? String(group).trim() : (existing && existing.group)) || '',
    created: (existing && existing.created) || new Date().toISOString(),
  };
  store.events = store.events.filter((e) => e.slug !== s);
  store.events.push(rec);
  writeJsonSafe(EVENTS_PATH, store);
  return { ok: true, event: rec };
}
function deleteEvent({ slug } = {}) {
  if (!slug) throw new Error('slug required');
  const store = readEvents();
  const before = store.events.length;
  store.events = store.events.filter((e) => e.slug !== slugify(slug));
  writeJsonSafe(EVENTS_PATH, store);
  return { ok: true, removed: before - store.events.length };
}

// Raw config for the GET/PUT endpoint (patterns kept as strings).
function getOwesConfig() {
  return readJsonSafe(OWES_CONFIG_PATH, null) || DEFAULT_OWES;
}
function setOwesConfig(next) {
  if (!next || typeof next !== 'object') throw new Error('config object required');
  const clean = {
    expected: next.expected && typeof next.expected === 'object' ? next.expected : DEFAULT_OWES.expected,
    debtorPatterns: next.debtorPatterns && typeof next.debtorPatterns === 'object' ? next.debtorPatterns : DEFAULT_OWES.debtorPatterns,
    tripStart: next.tripStart && typeof next.tripStart === 'object' ? next.tripStart : DEFAULT_OWES.tripStart,
    swNet: Array.isArray(next.swNet) ? next.swNet : DEFAULT_OWES.swNet,
    settledExt: Array.isArray(next.settledExt) ? next.settledExt : DEFAULT_OWES.settledExt,
    autoReimbTags: Array.isArray(next.autoReimbTags) ? next.autoReimbTags : DEFAULT_OWES.autoReimbTags,
    eventStatus: next.eventStatus && typeof next.eventStatus === 'object' ? next.eventStatus : DEFAULT_OWES.eventStatus,
    autoDetectExcludeEvents: Array.isArray(next.autoDetectExcludeEvents) ? next.autoDetectExcludeEvents : DEFAULT_OWES.autoDetectExcludeEvents,
  };
  // Preserve manual trip overrides (not part of the editable form, but must
  // survive a config write from the settings screen).
  const existing = readJsonSafe(OWES_CONFIG_PATH, null) || {};
  const manualTrips = next.manualTrips && typeof next.manualTrips === 'object' ? next.manualTrips : existing.manualTrips;
  if (manualTrips && typeof manualTrips === 'object') clean.manualTrips = manualTrips;
  for (const [slug, src] of Object.entries(clean.debtorPatterns)) {
    try { new RegExp(src, 'i'); } catch (e) { throw new Error(`Bad debtor pattern for ${slug}: ${e.message}`); }
  }
  writeJsonSafe(OWES_CONFIG_PATH, clean);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Reimbursement links — connect a repayment inflow to the expense(s) it repays
// ---------------------------------------------------------------------------
function readReimbLinks() {
  const store = readJsonSafe(REIMB_LINKS_PATH, { links: [] });
  return store && Array.isArray(store.links) ? store : { links: [] };
}
function txnRef(t) {
  if (!t || t.id == null) throw new Error('transaction id required');
  return { id: String(t.id), date: t.date || null, payee: t.payee || '', amount: Number(t.amount) || 0 };
}
// Given a transaction id, return both directions: the expenses an inflow repays
// (asInflow) and the inflows that repaid an expense (asExpense). Each returned ref
// carries `allocated` — the dollars of the repayment applied to that expense (for
// amount-allocated / partial links; falls back to the full amount for legacy links).
function getReimbLinks({ id } = {}) {
  const { links } = readReimbLinks();
  if (!id) return { links };
  const withAlloc = (ref, l) => ({ ...ref, allocated: l.amount != null ? l.amount : Math.abs(ref.amount) });
  return {
    asInflow: links.filter((l) => l.inflow && l.inflow.id === id).map((l) => withAlloc(l.expense, l)),
    asExpense: links.filter((l) => l.expense && l.expense.id === id).map((l) => withAlloc(l.inflow, l)),
  };
}
// Link a repayment inflow to an expense, optionally allocating a specific dollar
// amount (partial repayments) and tagging the person. Re-linking the same pair
// updates the allocation rather than duplicating.
function addReimbLink({ inflow, expense, amount, person } = {}) {
  const inf = txnRef(inflow);
  const exp = txnRef(expense);
  if (inf.id === exp.id) throw new Error('cannot link a transaction to itself');
  const store = readReimbLinks();
  const alloc = amount != null && Number.isFinite(Number(amount)) ? round2(Math.abs(Number(amount))) : null;
  const existing = store.links.find((l) => l.inflow.id === inf.id && l.expense.id === exp.id);
  if (existing) {
    if (alloc != null) existing.amount = alloc;
    if (person) existing.person = person;
  } else {
    store.links.push({ inflow: inf, expense: exp, amount: alloc, person: person || null, createdAt: new Date().toISOString() });
  }
  writeJsonSafe(REIMB_LINKS_PATH, store);
  return { ok: true, inflowId: inf.id, expenseId: exp.id, amount: alloc };
}
function deleteReimbLink({ inflowId, expenseId } = {}) {
  if (!inflowId || !expenseId) throw new Error('inflowId and expenseId required');
  const store = readReimbLinks();
  const before = store.links.length;
  store.links = store.links.filter((l) => !(l.inflow.id === inflowId && l.expense.id === expenseId));
  if (store.links.length !== before) writeJsonSafe(REIMB_LINKS_PATH, store);
  return { ok: true, removed: before - store.links.length };
}

// ---------------------------------------------------------------------------
// Repayment auto-matcher — suggest which incoming payments settle which fronted
// (Reimbursement-category) expenses, per person. You confirm; confirming writes
// amount-allocated links. Trip/Splitwise debts stay owned by the snapshot engine.
// ---------------------------------------------------------------------------
function readReimbSuggest() {
  const s = readJsonSafe(REIMB_SUGGEST_PATH, { confirmed: {}, dismissed: [] });
  return {
    confirmed: s && s.confirmed && typeof s.confirmed === 'object' ? s.confirmed : {},
    dismissed: Array.isArray(s && s.dismissed) ? s.dismissed : [],
  };
}
function writeReimbSuggest(s) { writeJsonSafe(REIMB_SUGGEST_PATH, s); }

// Best-effort provenance allocation of one inflow across a person's outstanding
// fronted expenses (each { id, date, payee, amount<0 dollars, remaining>0 dollars }).
// Total allocated is always capped at the inflow (remainder >= 0). Returns
// { allocations:[{expense,amount}], matched, kind, score, reason } — allocations may
// be [] when there are no clean ledger charges to point at (person-level repayment).
function allocateInflow(inflow, expenses) {
  const pool = expenses.filter((e) => e.remaining > 0.005).sort((a, b) => (a.date < b.date ? -1 : 1));
  const A = round2(inflow.amount);
  const tol = Math.max(1, A * 0.02);
  const refOf = (e) => ({ id: e.id, date: e.date, payee: e.payee, amount: e.amount });
  const outstanding = round2(pool.reduce((s, e) => s + e.remaining, 0));

  // 1. Exact single expense.
  const exact = pool.find((e) => Math.abs(e.remaining - A) <= tol);
  if (exact) {
    const amt = round2(Math.min(exact.remaining, A));
    return { allocations: [{ expense: refOf(exact), amount: amt }], matched: amt, kind: 'exact', score: 0.98,
      reason: `Matches ${exact.payee || 'a charge'} (${exact.date})` };
  }
  // 2. Subset of 2–3 expenses summing ~ A (each capped so the total never exceeds A).
  for (let k = 2; k <= 3 && k <= pool.length; k++) {
    const combo = findSubset(pool, k, A, tol);
    if (combo) {
      let left = A;
      const allocations = [];
      for (const e of combo) { const take = round2(Math.min(e.remaining, left)); if (take > 0.005) { allocations.push({ expense: refOf(e), amount: take }); left = round2(left - take); } }
      const matched = round2(allocations.reduce((s, x) => s + x.amount, 0));
      return { allocations, matched, kind: 'subset', score: 0.9,
        reason: `Covers ${allocations.length} charges (${combo.map((e) => e.payee || '?').join(', ')})` };
    }
  }
  // 3. Greedy — oldest first until the inflow is spent (or charges run out).
  let left = A;
  const allocations = [];
  for (const e of pool) {
    if (left <= 0.005) break;
    const take = round2(Math.min(e.remaining, left));
    if (take <= 0.005) continue;
    allocations.push({ expense: refOf(e), amount: take });
    left = round2(left - take);
  }
  const matched = round2(allocations.reduce((s, x) => s + x.amount, 0));
  const over = A > outstanding + tol;
  const kind = over ? 'over' : allocations.length > 1 ? 'multi' : allocations.length === 1 ? 'partial' : 'person';
  const reason = allocations.length === 0
    ? 'Looks like a repayment — apply toward what they owe'
    : over
      ? `Covers all ${allocations.length} tracked charge${allocations.length === 1 ? '' : 's'}; ${fmtUSD(round2(A - matched))} extra`
      : `Applies to ${allocations.length} charge${allocations.length === 1 ? '' : 's'} (oldest first)`;
  return { allocations, matched, kind, score: allocations.length ? 0.7 : 0.5, reason };
}
function findSubset(pool, k, target, tol, start = 0, chosen = []) {
  if (chosen.length === k) {
    const sum = chosen.reduce((s, e) => s + e.remaining, 0);
    return Math.abs(sum - target) <= tol ? chosen.slice() : null;
  }
  for (let i = start; i < pool.length; i++) {
    const r = findSubset(pool, k, target, tol, i + 1, [...chosen, pool[i]]);
    if (r) return r;
  }
  return null;
}
const fmtUSD = (n) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;

// Compute (and persist nothing but dismissals) suggested repayment matches.
// Only surfaces inflows for people the engine says currently OWE you (so people who
// already squared up / overpaid never generate noise), attributed to that person,
// not yet filed under Reimbursement, not an internal transfer, not already linked
// or dismissed. Expense remaining is net of prior links; allocations are provenance.
async function suggestRepayments({ from, to } = {}) {
  return withApi(async (api) => {
    from = from || REIMB_SUGGEST_FROM;
    to = to || todayYMD();

    // Who currently owes (authoritative net from the tuned engine).
    const reimb = await getReimbursement({ from, to });
    const owedBySlug = {};
    for (const o of reimb.owes || []) owedBySlug[o.slug] = o.owed;

    const groups = await api.getCategoryGroups();
    const catInfo = buildCatInfo(groups);
    let reimbId = null;
    for (const g of groups) for (const c of g.categories || []) if (REIMB_CAT.test(c.name || '')) reimbId = c.id;
    if (!reimbId) throw new Error('Reimbursement category not found');
    const payees = await api.getPayees();
    const pn = {};
    for (const p of payees) pn[p.id] = p.name || '';
    const accts = (await api.getAccounts()).filter((a) => !a.closed);

    const inflows = [];        // candidate repayments
    const expByPerson = {};    // slug -> [{id,date,payee,amount<0,person}]
    for (const a of accts) {
      const tx = await api.getTransactions(a.id, from, to);
      for (const t of tx) {
        const parentPayee = pn[t.payee] || t.imported_payee || '';
        const isSplit = t.is_parent && Array.isArray(t.subtransactions) && t.subtransactions.length;
        const parentTransfer = !!(t.transfer_id || t.transferred_id);
        // Fronted reimbursement expenses (with ids) — the settle-able side.
        const pushExp = (id, amount, notes, payeeName) => {
          const at = attribute(`${payeeName} ${notes || ''}`.trim(), notes || '');
          if (!at.person || at.person.startsWith('(')) return; // must map to a real person
          (expByPerson[at.person] = expByPerson[at.person] || []).push({
            id: String(id), date: t.date, payee: payeeName || '(no payee)', amount: d2(amount), person: at.person,
          });
        };
        if (isSplit) {
          for (const s of t.subtransactions)
            if (s.category === reimbId && s.amount < 0) pushExp(s.id, s.amount, s.notes || t.notes, (s.payee && pn[s.payee]) || parentPayee);
        } else if (t.category === reimbId && t.amount < 0) {
          pushExp(t.id, t.amount, t.notes, parentPayee);
        }
        // Candidate repayment inflows: positive, simple, not income, not already
        // filed under Reimbursement, not an internal transfer.
        if (!isSplit && t.amount > 0 && !parentTransfer) {
          const kind = catInfo[t.category] ? catInfo[t.category].kind : 'uncat';
          if (kind === 'income' || t.category === reimbId) continue;
          const at = attribute(`${parentPayee} ${t.notes || ''}`.trim(), t.notes || '');
          if (!at.person || at.person.startsWith('(')) continue;
          inflows.push({ id: String(t.id), date: t.date, payee: parentPayee || 'Payment', amount: d2(t.amount), person: at.person, notes: t.notes || '' });
        }
      }
    }

    // Net each expense's remaining against amounts already linked to it.
    const { links } = readReimbLinks();
    const allocByExp = {};
    const linkedInflow = new Set();
    for (const l of links) {
      if (l.inflow) linkedInflow.add(l.inflow.id);
      if (l.expense) allocByExp[l.expense.id] = round2((allocByExp[l.expense.id] || 0) + (l.amount != null ? l.amount : Math.abs(l.expense.amount || 0)));
    }
    for (const slug of Object.keys(expByPerson))
      for (const e of expByPerson[slug]) e.remaining = round2(Math.max(0, -e.amount - (allocByExp[e.id] || 0)));

    const { dismissed } = readReimbSuggest();
    const dismissedSet = new Set(dismissed);

    const suggestions = [];
    for (const inf of inflows.sort((a, b) => (a.date < b.date ? 1 : -1))) {
      if (linkedInflow.has(inf.id) || dismissedSet.has(inf.id)) continue;
      const owed = owedBySlug[inf.person];
      if (!(owed > 0.5)) continue; // only suggest for people who actually owe you
      const alloc = allocateInflow(inf, expByPerson[inf.person] || []);
      const tooLargeForCurrentDebt = inf.amount > owed + Math.max(10, owed * 0.2);
      if (alloc.kind === 'over' && tooLargeForCurrentDebt) continue;
      // Reserve the allocated remaining so a later inflow doesn't double-book it.
      for (const a of alloc.allocations) {
        const e = (expByPerson[inf.person] || []).find((x) => x.id === a.expense.id);
        if (e) e.remaining = round2(Math.max(0, e.remaining - a.amount));
      }
      suggestions.push({
        id: `sg_${inf.id}`,
        inflow: { id: inf.id, date: inf.date, payee: inf.payee, amount: inf.amount },
        person: inf.person,
        owed: round2(owed),
        allocations: alloc.allocations,
        matched: alloc.matched,
        remainder: round2(inf.amount - alloc.matched),
        kind: alloc.kind,
        score: alloc.score,
        reason: alloc.reason,
        createdAt: new Date().toISOString(),
      });
    }
    suggestions.sort((a, b) => b.score - a.score || (a.inflow.date < b.inflow.date ? 1 : -1));
    return { suggestions, count: suggestions.length, generatedAt: new Date().toISOString(), range: { from, to } };
  });
}

// Confirm a suggestion: file the inflow under Reimbursement (so it nets against what
// the person owes — the "zero out" flow) and write amount-allocated provenance links.
// Re-derives the suggestion so a stale client can't act on a vanished match.
async function confirmRepayment({ id, from, to } = {}) {
  if (!id) throw new Error('suggestion id required');
  const { suggestions } = await suggestRepayments({ from, to });
  const sg = suggestions.find((s) => s.id === id);
  if (!sg) throw new Error('suggestion no longer valid (already linked or changed) — refresh and retry');
  await setTransactionCategory({ id: sg.inflow.id, categoryId: reimbCategoryId(await withApi((api) => api.getCategoryGroups())) });
  for (const a of sg.allocations) addReimbLink({ inflow: sg.inflow, expense: a.expense, amount: a.amount, person: sg.person });
  const store = readReimbSuggest();
  store.confirmed[id] = { at: new Date().toISOString(), inflowId: sg.inflow.id, allocations: sg.allocations.length };
  writeReimbSuggest(store);
  return { ok: true, categorized: true, linked: sg.allocations.length, inflowId: sg.inflow.id };
}
function reimbCategoryId(groups) {
  for (const g of groups) for (const c of g.categories || []) if (REIMB_CAT.test(c.name || '')) return c.id;
  throw new Error('Reimbursement category not found');
}

// Dismiss a suggestion so its inflow is never re-suggested (until re-enabled).
function dismissRepayment({ id, inflowId } = {}) {
  const infId = inflowId || (id && id.startsWith('sg_') ? id.slice(3) : null);
  if (!infId) throw new Error('inflowId (or sg_ id) required');
  const store = readReimbSuggest();
  if (!store.dismissed.includes(infId)) store.dismissed.push(infId);
  writeReimbSuggest(store);
  return { ok: true, dismissed: infId };
}
// Undo a dismissal (lets a suggestion resurface).
function undismissRepayment({ inflowId } = {}) {
  if (!inflowId) throw new Error('inflowId required');
  const store = readReimbSuggest();
  store.dismissed = store.dismissed.filter((x) => x !== inflowId);
  writeReimbSuggest(store);
  return { ok: true };
}

async function getReimbursement({ from, to, openOnly = false } = {}) {
  return withApi(async (api) => {
    const {
      expected: EXPECTED,
      debtorRe: DEBTOR_RE,
      tripStart: TRIP_START,
      swNet: SW_NET,
      settledExt: SETTLED_EXT,
      manualTrips: MANUAL_TRIPS,
      eventStatus: EVENT_STATUS,
      autoDetectExcludeEvents: AUTO_DETECT_EXCLUDE_EVENTS,
    } = loadOwesConfig();
    // Who-owes-you and the People roster are stable across UI windows, but direct
    // ledger debts before the cutoff are historical/settled outside this system.
    // `from`/`to` only scope the headline summary below.
    const legFrom = REIMB_LEDGER_FROM;
    const legTo = todayYMD();
    const winFrom = from || legFrom;
    const winTo = to || legTo;
    const groups = await api.getCategoryGroups();
    let reimbId = null;
    for (const g of groups) for (const c of g.categories || []) if (REIMB_CAT.test(c.name || '')) reimbId = c.id;
    if (!reimbId) throw new Error('Reimbursement category not found');
    const payees = await api.getPayees();
    const pn = {};
    for (const p of payees) pn[p.id] = p.name;
    const accts = await api.getAccounts();

    const legs = [];
    const inflows = [];
    for (const a of accts) {
      if (a.offbudget) continue;
      const tx = await api.getTransactions(a.id, legFrom, legTo);
      for (const t of tx) {
        const parentPayee = pn[t.payee] || t.imported_payee || '';
        const push = (amount, notes, meta = {}) => {
          const payeeName = meta.payee || parentPayee;
          const label = [payeeName || '', notes || ''].join(' ').replace(/\s+/g, ' ').trim();
          const at = attribute(label, notes || '');
          legs.push({
            id: String(meta.id || t.id),
            parentId: meta.parentId || null,
            isLeg: !!meta.isLeg,
            accountId: a.id,
            account: a.name || '',
            payee: payeeName || '',
            cleared: t.cleared,
            imported: !!t.imported_id,
            categoryId: reimbId,
            date: t.date,
            amount,
            notes: notes || '',
            label: label.slice(0, 80),
            ...at,
          });
        };
        const isSplit = t.subtransactions && t.subtransactions.length;
        if (isSplit) {
          for (const s of t.subtransactions) if (s.category === reimbId) push(s.amount, s.notes || t.notes, {
            id: s.id || t.id,
            parentId: t.id,
            isLeg: true,
            payee: (s.payee && pn[s.payee]) || parentPayee,
          });
        } else if (t.category === reimbId) push(t.amount, t.notes, { id: t.id });
        if (!isSplit && t.amount > 0)
          inflows.push({
            date: t.date,
            amount: t.amount,
            label: `${pn[t.payee] || ''} ${t.notes || ''}`.replace(/\s+/g, ' ').trim(),
            events: ((t.notes || '').match(/#ev-([a-z0-9-]+)/gi) || []).map((tag) => tag.slice(4).toLowerCase()),
          });
      }
    }
    legs.sort((a, b) => (a.date < b.date ? -1 : 1));

    const byP = {};
    for (const l of legs) (byP[l.person] = byP[l.person] || []).push(l);
    const persons = Object.keys(byP).filter((p) => !p.startsWith('('));
    const sumOf = (p) => byP[p].reduce((s, l) => s + l.amount, 0);
    persons.sort((a, b) => sumOf(a) - sumOf(b));

    const people = persons
      .map((p) => {
        const net = sumOf(p);
        const status = net < -50 ? 'owes_you' : net > 50 ? 'over_settled' : 'settled';
        return {
          slug: p,
          net: d2(net),
          status,
          legs: byP[p].map((l) => ({
            id: l.id, parentId: l.parentId, isLeg: l.isLeg, accountId: l.accountId, account: l.account,
            payee: l.payee, cleared: l.cleared, imported: l.imported, categoryId: l.categoryId,
            date: l.date, amount: d2(l.amount), label: l.label, notes: l.notes, event: l.event, how: l.how,
          })),
        };
      })
      .filter((p) => !openOnly || p.status === 'owes_you');

    const owesYou = persons.filter((p) => sumOf(p) < -50);
    const totalOwedCents = owesYou.reduce((s, p) => s + sumOf(p), 0);

    // Event rollup
    const evMap = {};
    for (const l of legs) if (l.event) (evMap[l.event] = evMap[l.event] || []).push(l);
    const events = Object.keys(evMap)
      .map((e) => {
        const items = evMap[e];
        const fronted = items.filter((l) => l.amount < 0).reduce((s, l) => s + l.amount, 0);
        const recovered = items.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0);
        const net = fronted + recovered;
        let status;
        if (EVENT_STATUS[e]) status = EVENT_STATUS[e];
        else if (SETTLED_EXT.has(e)) status = 'settled_ext';
        else if (SW_NET.has(e)) status = 'sw_net';
        else status = net < -50 ? 'open' : net > 50 ? 'over' : 'settled';
        const dates = items.map((l) => l.date).sort();
        const firstDate = dates[0] || null;
        const lastDate = dates[dates.length - 1] || null;
        // Best available "settled on" proxy: the last activity date once the event
        // is no longer open (i.e. the final settle-up payment landed). Open trips
        // have no settled date yet.
        const settledDate = status === 'open' ? null : lastDate;
        return {
          event: e,
          fronted: d2(fronted),
          recovered: d2(recovered),
          net: d2(net),
          status,
          n: items.length,
          firstDate,
          lastDate,
          settledDate,
        };
      })
      .sort((a, b) => a.net - b.net);

    // Expected debtors (Splitwise ground-truth) with untagged-inflow auto-detect
    const expected = [];
    for (const [ev, peopleMap] of Object.entries(EXPECTED)) {
      let eExp = 0, eRecv = 0;
      const rows = [];
      for (const [slug, exp] of Object.entries(peopleMap)) {
        const tagged = legs
          .filter((l) => l.event === ev && l.person === slug && l.amount > 0)
          .reduce((s, l) => s + l.amount, 0);
        const rem0 = exp - tagged;
        let auto = 0;
        const re = DEBTOR_RE[slug];
        const start = TRIP_START[ev];
        if (re && start && rem0 > 0) {
          auto = inflows
            .filter((i) => !i.events.some((ev) => AUTO_DETECT_EXCLUDE_EVENTS.has(ev)) && i.date >= start && re.test(i.label) && i.amount >= 0.4 * rem0 && i.amount <= 1.6 * rem0)
            .reduce((s, i) => s + i.amount, 0);
        }
        const recv = tagged + auto;
        const rem = exp - recv;
        eExp += exp;
        eRecv += recv;
        rows.push({
          slug,
          expected: d2(exp),
          received: d2(recv),
          remaining: d2(rem),
          auto: d2(auto),
          status: rem <= 50 ? 'paid' : recv > 0 ? 'partial' : 'open',
        });
      }
      expected.push({ event: ev, rows, expected: d2(eExp), received: d2(eRecv), remaining: d2(eExp - eRecv) });
    }

    const buckets = {};
    for (const b of ['(group/unsplit)', '(unattributed)', '(self-offset)']) {
      if (!byP[b]) continue;
      const bucketLegs = b === '(group/unsplit)' || b === '(unattributed)'
        ? byP[b].filter((l) => !(l.event || /splitwise/i.test(l.label || '')))
        : byP[b];
      if (!bucketLegs.length) continue;
      buckets[b] = {
        net: d2(bucketLegs.reduce((s, l) => s + l.amount, 0)),
        count: bucketLegs.length,
        legs: bucketLegs.map((l) => ({
          id: l.id, parentId: l.parentId, isLeg: l.isLeg, accountId: l.accountId, account: l.account,
          payee: l.payee, cleared: l.cleared, imported: l.imported, categoryId: l.categoryId,
          date: l.date, amount: d2(l.amount), label: l.label, notes: l.notes,
        })),
      };
    }

    // Combined "who owes me" — AUTHORITATIVE. Trip/group debts come straight from
    // Splitwise's own pairwise balance via the owes-snapshot (see reimbursement docs:
    // NEVER reconstruct per-person trip debts from line items). Personal loans not
    // in any Splitwise group (e.g. a Venmo loan) still come from the ledger. If the
    // snapshot is unavailable we fall back to the legacy `expected` baseline.
    const truth = loadOwesTruth();
    const tripBySlug = {}; // slug -> [{ event, remaining }]
    let owesSource = 'splitwise-snapshot';
    const owesGeneratedAt = truth && truth.generatedAt ? truth.generatedAt : null;
    const owesWarning = truth && truth.warning ? truth.warning : null;
    if (truth) {
      owesSource = truth.source || owesSource;
      for (const [slug, arr] of Object.entries(truth.bySlug))
        tripBySlug[slug] = (Array.isArray(arr) ? arr : [])
          .filter((t) => t && Number(t.amount) > 0.005)
          .map((t) => ({ event: t.event, remaining: round2(Number(t.amount)) }));
    } else {
      owesSource = 'legacy-baseline';
      for (const e of expected)
        for (const r of e.rows)
          if (r.remaining > 0.5) (tripBySlug[r.slug] = tripBySlug[r.slug] || []).push({ event: e.event, remaining: r.remaining });
    }

    // Venmo debts (imported from a statement CSV) merge in as another source, so a
    // trip settled partly on Venmo and partly on Splitwise shows the combined total.
    const venmo = loadVenmoTruth();
    if (venmo) {
      owesSource += '+venmo';
      for (const [slug, arr] of Object.entries(venmo.bySlug)) {
        const list = tripBySlug[slug] || (tripBySlug[slug] = []);
        for (const v of Array.isArray(arr) ? arr : []) {
          const amount = round2(Number(v.amount) || 0);
          if (!(amount > 0.005)) continue;
          const event = v.event || 'Venmo';
          const i = list.findIndex((t) => t.event === event);
          if (i >= 0) list[i].remaining = round2(list[i].remaining + amount);
          else list.push({ event, remaining: amount });
        }
      }
    }

    // Manual overrides win over the auto snapshot (e.g. a Splitwise group that
    // reports settled while the person actually still owes). { slug: [{event,amount}] }.
    if (MANUAL_TRIPS && typeof MANUAL_TRIPS === 'object') {
      for (const [slug, arr] of Object.entries(MANUAL_TRIPS)) {
        if (!Array.isArray(arr)) continue;
        const list = tripBySlug[slug] || [];
        for (const m of arr) {
          if (!m || !m.event) continue;
          const amount = round2(Number(m.amount) || 0);
          const i = list.findIndex((t) => t.event === m.event);
          if (amount > 0.005) {
            if (i >= 0) list[i] = { event: m.event, remaining: amount };
            else list.push({ event: m.event, remaining: amount });
          } else if (i >= 0) list.splice(i, 1);
        }
        if (list.length) { tripBySlug[slug] = list; owesSource = owesSource + '+manual'; } else delete tripBySlug[slug];
      }
    }

    // A person is "Splitwise-governed" if ANY ledger leg is tied to a trip event or
    // a Splitwise expense — then their debt comes ONLY from the authoritative
    // snapshot above (never the ledger), which avoids double-counting cross-tagged
    // settle-ups (e.g. gift fronts netted into a trip payback). People with purely
    // personal, non-Splitwise legs (e.g. a direct loan) keep their ledger net.
    const swGoverned = (p) => (byP[p] || []).some((l) => l.event || /splitwise/i.test(l.label || ''));
    const personalNetOf = (p) => (swGoverned(p) ? 0 : (byP[p] || []).reduce((s, l) => s + l.amount, 0));

    const owesSlugs = new Set([...persons, ...Object.keys(tripBySlug)]);
    const owes = [];
    for (const slug of owesSlugs) {
      if (slug.startsWith('(')) continue;
      const pNet = personalNetOf(slug); // integer cents
      const misc = pNet < -50 ? d2(-pNet) : 0; // dollars
      const trips = tripBySlug[slug] || [];
      const owed = round2(misc + trips.reduce((s, t) => s + t.remaining, 0));
      if (owed <= 0.5) continue;
      const legs = swGoverned(slug)
        ? []
        : (byP[slug] || []).filter((l) => l.amount < 0).map((l) => ({
          id: l.id, parentId: l.parentId, isLeg: l.isLeg, accountId: l.accountId, account: l.account,
          payee: l.payee, cleared: l.cleared, imported: l.imported, categoryId: l.categoryId,
          date: l.date, amount: d2(l.amount), label: l.label, notes: l.notes,
        }));
      owes.push({ slug, owed, misc, trips, legs });
    }
    owes.sort((a, b) => b.owed - a.owed);
    const totalOwedCombined = round2(owes.reduce((s, o) => s + o.owed, 0));

    // Window summary: fronted / paid back scoped to [winFrom, winTo] (MTD, 7d, 30d,
    // lifetime, …) so the user can see e.g. "June's activity" without the all-time
    // pile. `outstanding` here is the window's net (fronted − paid back); the true
    // all-time balance still owed lives in `totalOwed` (drives the People list).
    const inWin = (d) => { const x = d || ''; return x >= winFrom && x <= winTo; };
    const frontedWin = round2(legs.filter((l) => l.amount < 0 && inWin(l.date)).reduce((s, l) => s + -l.amount, 0) / 100);
    const paidBackWin = round2(legs.filter((l) => l.amount > 0 && inWin(l.date)).reduce((s, l) => s + l.amount, 0) / 100);
    const isLifetimeWin = winFrom <= legFrom && winTo >= legTo;
    const summary = {
      fronted: frontedWin,
      paidBack: paidBackWin,
      // Over the lifetime window the meaningful "outstanding" is the real balance
      // still owed; for a bounded window it's that window's net flow.
      outstanding: isLifetimeWin ? totalOwedCombined : round2(frontedWin - paidBackWin),
      window: { from: winFrom, to: winTo },
      lifetime: isLifetimeWin,
    };

    return {
      range: { from: winFrom, to: winTo },
      totalOwed: totalOwedCombined,
      summary,
      ledgerCutoff: REIMB_LEDGER_CUTOFF_ACTIVE ? REIMB_LEDGER_FROM : null,
      debtorCount: owes.length,
      owes,
      owesSource,
      owesGeneratedAt,
      owesWarning,
      people,
      events,
      expected,
      buckets,
      // Surfaced so tagged-but-unmatched repayments are visible instead of
      // silently disappearing into a bucket the UI never renders.
      unattributed: buckets['(unattributed)'] || null,
    };
  });
}

// ---------------------------------------------------------------------------
// Reimbursement LEDGER — the Rocket-Money "zero it out" view. Per person, the
// individual charges you moved to Reimbursement and the paybacks applied to each
// (via the reimb-links store), so every charge reads Outstanding / Partial /
// Settled with a progress-to-zero. Scoped to a month (by the charge/front date),
// plus a trailing 12-month fronted series to drive the month navigator bars.
// This is intentionally ledger-based (what you can act on); the Splitwise
// snapshot in getReimbursement stays the authoritative all-time headline.
// ---------------------------------------------------------------------------
async function getReimbursementLedger({ month } = {}) {
  return withApi(async (api) => {
    const now = new Date();
    let year, mIdx;
    if (month) { const [Y, M] = month.split('-').map(Number); year = Y; mIdx = M - 1; }
    else { year = now.getFullYear(); mIdx = now.getMonth(); }
    const sel = monthRange(year, mIdx);
    const selKey = sel.key;
    const isCurrent = year === now.getFullYear() && mIdx === now.getMonth();
    const selEnd = isCurrent ? todayYMD() : sel.end;

    // Trailing 12 months ending at the current month drive the navigator bars.
    const curY = now.getFullYear(), curM = now.getMonth();
    const windowStart = monthRange(curY, curM - 11).start;
    const windowEnd = todayYMD();

    const groups = await api.getCategoryGroups();
    let reimbId = null;
    for (const g of groups) for (const c of g.categories || []) if (REIMB_CAT.test(c.name || '')) reimbId = c.id;
    if (!reimbId) throw new Error('Reimbursement category not found');
    const payees = await api.getPayees();
    const pn = {};
    for (const p of payees) pn[p.id] = p.name || '';
    const accts = (await api.getAccounts()).filter((a) => !a.offbudget);

    // All reimbursement charges (fronted, amount<0) over the 12-month window.
    const charges = []; // { id, date, payee, notes, amount(dollars<0), person, event }
    const frontedByMonth = {};
    for (const a of accts) {
      const tx = await api.getTransactions(a.id, windowStart, windowEnd);
      for (const t of tx) {
        const parentPayee = pn[t.payee] || t.imported_payee || '';
        const isSplit = t.subtransactions && t.subtransactions.length;
        const pushCharge = (id, amt, notes, payeeName) => {
          if (!(amt < 0)) return;
          const label = `${payeeName || ''} ${notes || ''}`.replace(/\s+/g, ' ').trim();
          const at = attribute(label, notes || '');
          const mk = (t.date || '').slice(0, 7);
          frontedByMonth[mk] = round2((frontedByMonth[mk] || 0) + -d2(amt));
          charges.push({ id: String(id), date: t.date, payee: payeeName || '(no payee)', notes: notes || '', amount: d2(amt), person: at.person, event: at.event || null, accountId: a.id, account: a.name || '' });
        };
        if (isSplit) { for (const s of t.subtransactions) if (s.category === reimbId) pushCharge(s.id, s.amount, s.notes || t.notes, (s.payee && pn[s.payee]) || parentPayee); }
        else if (t.category === reimbId) pushCharge(t.id, t.amount, t.notes, parentPayee);
      }
    }

    // Payback allocations from the links store (amount-allocated / partial aware).
    const { links } = readReimbLinks();
    const allocByExp = {};
    const paymentsByExp = {};
    for (const l of links) {
      if (!l.expense) continue;
      const eid = l.expense.id;
      const amt = l.amount != null ? round2(l.amount) : round2(Math.abs((l.expense && l.expense.amount) || 0));
      allocByExp[eid] = round2((allocByExp[eid] || 0) + amt);
      if (l.inflow) (paymentsByExp[eid] = paymentsByExp[eid] || []).push({ id: String(l.inflow.id), date: l.inflow.date || null, payee: l.inflow.payee || 'Payment', amount: amt });
    }

    const chargeStatus = (fronted, allocated, remaining) =>
      allocated <= 0.005 ? 'outstanding' : remaining <= 0.5 ? 'settled' : 'partial';

    // Build the selected month's charges, grouped by person.
    // Hybrid model: trip/Splitwise-governed charges are owned by the authoritative
    // snapshot (netted per person), so exclude them here to avoid double-showing a
    // gross lump. The ledger keeps only direct, per-month reimbursements (for
    // example a roommate's utility half) that Splitwise doesn't track.
    const swGovernedCharge = (c) => !!c.event || /splitwise/i.test(c.notes || '');
    const byPerson = {};
    for (const c of charges) {
      if (c.date < sel.start || c.date > selEnd) continue;
      if (swGovernedCharge(c)) continue;
      const person = c.person && !c.person.startsWith('(') ? c.person : '(unassigned)';
      const fronted = round2(-c.amount);
      const allocated = round2(Math.min(fronted, allocByExp[c.id] || 0));
      const remaining = round2(Math.max(0, fronted - allocated));
      const payments = (paymentsByExp[c.id] || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
      const status = chargeStatus(fronted, allocated, remaining);
      const settledDate = status === 'settled' && payments.length ? payments[payments.length - 1].date : null;
      (byPerson[person] = byPerson[person] || []).push({
        id: c.id, date: c.date, payee: c.payee, notes: c.notes, event: c.event,
        accountId: c.accountId, account: c.account,
        fronted, allocated, remaining, status, settledDate, payments,
      });
    }

    const people = Object.keys(byPerson)
      .map((person) => {
        const items = byPerson[person].sort((a, b) => (a.date < b.date ? 1 : -1));
        const fronted = round2(items.reduce((s, i) => s + i.fronted, 0));
        const allocated = round2(items.reduce((s, i) => s + i.allocated, 0));
        const remaining = round2(items.reduce((s, i) => s + i.remaining, 0));
        const status = remaining <= 0.5 ? 'settled' : allocated > 0.005 ? 'partial' : 'outstanding';
        return { person, fronted, allocated, remaining, status, count: items.length, charges: items };
      })
      // Named people first (actionable); the group/trip bucket sinks to the
      // bottom. Within each, most still-owed first.
      .sort((a, b) => {
        const ba = a.person.startsWith('(') ? 1 : 0;
        const bb = b.person.startsWith('(') ? 1 : 0;
        if (ba !== bb) return ba - bb;
        return b.remaining - a.remaining || b.fronted - a.fronted || a.person.localeCompare(b.person);
      });

    const totals = {
      fronted: round2(people.reduce((s, p) => s + p.fronted, 0)),
      allocated: round2(people.reduce((s, p) => s + p.allocated, 0)),
      remaining: round2(people.reduce((s, p) => s + p.remaining, 0)),
      outstanding: round2(people.filter((p) => p.status === 'outstanding').reduce((s, p) => s + p.remaining, 0)),
      partial: round2(people.filter((p) => p.status === 'partial').reduce((s, p) => s + p.remaining, 0)),
      settledCount: people.filter((p) => p.status === 'settled').length,
      peopleCount: people.length,
    };

    const months = [];
    for (let k = 0; k < 12; k++) {
      const mk = monthRange(curY, curM - 11 + k).key;
      months.push({ month: mk, spend: round2(frontedByMonth[mk] || 0) });
    }

    return { month: selKey, range: { start: sel.start, end: selEnd }, totals, people, months };
  });
}

// ---------------------------------------------------------------------------
// Monthly reconciliation — opt-in month-end review. List a month's expenses,
// check each off, then close the month. State persists in reconciliation.json.
// ---------------------------------------------------------------------------
function readRecon() {
  const s = readJsonSafe(RECON_PATH, { enabled: false, months: {} });
  return {
    enabled: !!(s && s.enabled),
    months: s && s.months && typeof s.months === 'object' ? s.months : {},
  };
}
function reconMonthState(store, month) {
  const m = store.months[month];
  return {
    done: !!(m && m.done),
    doneAt: (m && m.doneAt) || null,
    items: m && m.items && typeof m.items === 'object' ? m.items : {},
  };
}
function setReconcileEnabled({ enabled } = {}) {
  const store = readRecon();
  store.enabled = !!enabled;
  writeJsonSafe(RECON_PATH, store);
  return { ok: true, enabled: store.enabled };
}

// A month's reviewable expenses: on-budget outflows, minus internal money
// movement (transfers / CC payments / investments) that aren't real spending to
// validate. Splits are listed once as their parent total. Newest first.
async function reconItemsFor(api, month) {
  const [Y, M] = month.split('-').map(Number);
  const { start, end } = monthRange(Y, M - 1);
  const now = new Date();
  const isCurrent = Y === now.getFullYear() && M - 1 === now.getMonth();
  const to = isCurrent ? todayYMD() : end;
  const groups = await api.getCategoryGroups();
  const catInfo = buildCatInfo(groups);
  const payees = await api.getPayees();
  const pn = {};
  for (const p of payees) pn[p.id] = p.name || '';
  const accts = (await api.getAccounts()).filter((a) => !a.offbudget);
  const items = [];
  for (const a of accts) {
    const tx = await api.getTransactions(a.id, start, to);
    for (const t of tx) {
      if (!(t.amount < 0)) continue; // outflows only
      if (t.transfer_id) continue; // internal transfer
      const isSplit = t.subtransactions && t.subtransactions.length;
      const info = t.category ? catInfo[t.category] : null;
      const kind = info ? info.kind : 'spend';
      if (kind === 'mm' || kind === 'income') continue;
      const payee = pn[t.payee] || t.imported_payee || '(no payee)';
      if (TRANSFER_PAYEE.test(payee)) continue;
      const cat = isSplit ? 'Split' : info ? info.name : 'Uncategorized';
      items.push({ id: String(t.id), date: t.date, payee: payee.slice(0, 80), amount: d2(t.amount), category: cat, account: a.name || '', accountId: a.id });
    }
  }
  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return items;
}

async function getReconciliation({ month } = {}) {
  return withApi(async (api) => {
    const now = new Date();
    month = month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const store = readRecon();
    const state = reconMonthState(store, month);
    const rawItems = await reconItemsFor(api, month);
    const items = rawItems.map((it) => ({ ...it, reconciled: !!state.items[it.id] }));
    const reconciledCount = items.filter((it) => it.reconciled).length;
    return {
      enabled: store.enabled,
      month,
      done: state.done,
      doneAt: state.doneAt,
      total: items.length,
      reconciledCount,
      remaining: items.length - reconciledCount,
      items,
    };
  });
}

function setReconcileItem({ month, id, reconciled } = {}) {
  if (!month || !id) throw new Error('month and id required');
  const store = readRecon();
  const m = store.months[month] || (store.months[month] = { done: false, doneAt: null, items: {} });
  if (!m.items || typeof m.items !== 'object') m.items = {};
  if (reconciled) {
    m.items[String(id)] = new Date().toISOString();
  } else {
    delete m.items[String(id)];
    m.done = false; // un-checking an expense reopens a closed month
    m.doneAt = null;
  }
  writeJsonSafe(RECON_PATH, store);
  return { ok: true, month, id: String(id), reconciled: !!reconciled };
}

function setReconcileMonth({ month, done = true } = {}) {
  if (!month) throw new Error('month required');
  const store = readRecon();
  const m = store.months[month] || (store.months[month] = { done: false, doneAt: null, items: {} });
  m.done = !!done;
  m.doneAt = done ? new Date().toISOString() : null;
  writeJsonSafe(RECON_PATH, store);
  return { ok: true, month, done: m.done, doneAt: m.doneAt };
}

// What the app nags about: if enabled, the previous calendar month when it still
// has expenses and hasn't been explicitly closed. Older months stay reachable
// via the reconcile screen's month picker but don't nag.
async function getReconcilePending() {
  return withApi(async (api) => {
    const store = readRecon();
    if (!store.enabled) return { enabled: false, pending: null };
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const state = reconMonthState(store, key);
    if (state.done) return { enabled: true, pending: null };
    const items = await reconItemsFor(api, key);
    if (items.length === 0) return { enabled: true, pending: null };
    const reconciledCount = items.filter((it) => state.items[it.id]).length;
    return { enabled: true, pending: key, total: items.length, reconciledCount, remaining: items.length - reconciledCount };
  });
}

// ---------------------------------------------------------------------------
// Insights — largest charges, uncategorized, recurring/subs, MoM anomalies
// ---------------------------------------------------------------------------
async function getInsights({ month } = {}) {
  return withApi(async (api) => {
    const now = new Date();
    let year, mIdx;
    if (month) {
      const [Y, M] = month.split('-').map(Number);
      year = Y;
      mIdx = M - 1;
    } else {
      year = now.getFullYear();
      mIdx = now.getMonth();
    }
    const target = monthRange(year, mIdx);
    const windowStart = monthRange(year, mIdx - 5).start; // 6-month window incl. target
    const isCurrent = year === now.getFullYear() && mIdx === now.getMonth();
    const targetEnd = isCurrent ? todayYMD() : target.end;

    const groups = await api.getCategoryGroups();
    const catInfo = buildCatInfo(groups);
    const payees = await api.getPayees();
    const pn = {};
    for (const p of payees) pn[p.id] = p.name || '';
    const accounts = (await api.getAccounts()).filter((a) => !a.closed && !a.offbudget);

    // Enriched real-spend leaves over the window {date, payee, month, amount(cents), category}
    const leaves = [];
    for (const a of accounts) {
      const txns = await api.getTransactions(a.id, windowStart, targetEnd);
      for (const t of txns) {
        const payeeName = pn[t.payee] || t.imported_payee || '';
        const parentTransfer = !!(t.transfer_id || t.transferred_id) || TRANSFER_PAYEE.test(payeeName);
        for (const lf of leavesOf(t, parentTransfer)) {
          let kind = catInfo[lf.catId] ? catInfo[lf.catId].kind : 'uncat';
          if (kind === 'uncat' && (lf.transfer || parentTransfer)) kind = 'mm';
          leaves.push({
            date: t.date,
            month: t.date.slice(0, 7),
            payee: payeeName,
            amount: lf.amount,
            kind,
            category: catInfo[lf.catId] ? catInfo[lf.catId].name : kind === 'mm' ? 'Transfer' : 'Uncategorized',
            // identity so consumers (e.g. Largest Charges) can deep-link to the txn
            id: lf.id,
            account: a.name,
            accountId: a.id,
            categoryId: lf.catId || null,
            notes: lf.notes || t.notes || '',
            isLeg: !!lf.isLeg,
            parentId: lf.parentId || null,
            cleared: t.cleared, // false => pending (bank hasn't posted it yet)
          });
        }
      }
    }

    const inMonth = (e) => e.date >= target.start && e.date <= targetEnd;
    const real = (e) => e.kind === 'spend' || e.kind === 'uncat';

    // Largest charges (target month)
    const largestCharges = leaves
      .filter((e) => inMonth(e) && real(e) && e.amount < 0)
      .sort((a, b) => a.amount - b.amount)
      .slice(0, 8)
      .map((e) => ({
        id: e.id,
        date: e.date,
        payee: e.payee || '(no payee)',
        amount: d2(e.amount),
        category: e.category,
        account: e.account,
        accountId: e.accountId,
        categoryId: e.categoryId,
        notes: e.notes,
        isLeg: e.isLeg,
        parentId: e.parentId,
        cleared: e.cleared,
      }));

    // Top merchants (target month) from REAL spend only — this naturally excludes
    // transfers, investments, credit-card payments and reimbursements, so savings
    // moves / brokerage buys / CC payoffs never masquerade as "merchants".
    const merchMap = new Map();
    for (const e of leaves) {
      if (!inMonth(e) || !real(e) || e.amount >= 0) continue;
      const payee = e.payee || '(no payee)';
      const m = merchMap.get(payee) || { payee, total: 0, count: 0, category: e.category };
      m.total += -e.amount;
      m.count += 1;
      merchMap.set(payee, m);
    }
    const topMerchants = [...merchMap.values()]
      .map((m) => ({ payee: m.payee, total: d2(m.total), count: m.count, category: m.category }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 6);

    // Uncategorized (target month)
    const uncategorized = leaves
      .filter((e) => inMonth(e) && e.kind === 'uncat')
      .sort((a, b) => a.amount - b.amount)
      .map((e) => ({ date: e.date, payee: e.payee || '(no payee)', amount: d2(e.amount) }));

    // Recurring / subscriptions: same payee with negative spend in >= 3 distinct months
    const byPayee = {};
    for (const e of leaves) {
      if (!real(e) || e.amount >= 0 || !e.payee) continue;
      const key = e.payee.toLowerCase();
      const rec = (byPayee[key] = byPayee[key] || { payee: e.payee, months: {}, category: e.category });
      rec.months[e.month] = (rec.months[e.month] || 0) + -e.amount; // positive cents per month
    }
    const recurring = Object.values(byPayee)
      .map((r) => {
        const vals = Object.values(r.months).sort((a, b) => a - b);
        const n = vals.length;
        const median = n % 2 ? vals[(n - 1) / 2] : (vals[n / 2 - 1] + vals[n / 2]) / 2;
        return { payee: r.payee, category: r.category, monthsSeen: n, estimated: d2(median) };
      })
      .filter((r) => r.monthsSeen >= 3)
      .sort((a, b) => b.estimated - a.estimated)
      .slice(0, 12);

    // MoM anomalies: target-month per-category spend vs avg of previous 3 full months
    const prevKeys = [1, 2, 3].map((i) => monthRange(year, mIdx - i).key);
    const curByCat = {};
    const prevByCat = {}; // sum over 3 months
    for (const e of leaves) {
      if (!real(e) || e.amount >= 0) continue;
      const amt = -e.amount;
      if (inMonth(e)) curByCat[e.category] = (curByCat[e.category] || 0) + amt;
      else if (prevKeys.includes(e.month)) prevByCat[e.category] = (prevByCat[e.category] || 0) + amt;
    }
    const anomalies = Object.keys(curByCat)
      .map((cat) => {
        const cur = curByCat[cat];
        const avg = (prevByCat[cat] || 0) / 3;
        return { category: cat, current: d2(cur), avg: d2(avg), deltaPct: avg > 0 ? Math.round(((cur - avg) / avg) * 100) : null };
      })
      .filter((a) => a.avg > 0 && a.current > a.avg * 1.5 && a.current - a.avg > 5000)
      .sort((a, b) => b.current - a.current)
      .slice(0, 6);

    return { month: target.key, largestCharges, topMerchants, uncategorized, recurring, anomalies };
  });
}

// Per-merchant spending history for the "See History" view: a contiguous monthly
// series (zero-filled) of real spend for one payee, each bucket carrying its own
// drill-down items. Matches the same real-spend definition as insights so transfers
// / CC payments / investments never show up.
async function getMerchantHistory({ payee, months = 12 } = {}) {
  return withApi(async (api) => {
    const target = (payee || '').trim().toLowerCase();
    const wantNoPayee = !target || target === '(no payee)';
    const now = new Date();
    const year = now.getFullYear();
    const mIdx = now.getMonth();
    const span = Math.max(1, Math.min(60, Number(months) || 12));
    const windowStart = monthRange(year, mIdx - (span - 1)).start;
    const end = todayYMD();

    const groups = await api.getCategoryGroups();
    const catInfo = buildCatInfo(groups);
    const payees = await api.getPayees();
    const pn = {};
    for (const p of payees) pn[p.id] = p.name || '';
    const accounts = (await api.getAccounts()).filter((a) => !a.closed && !a.offbudget);

    // Zero-filled contiguous month buckets across the window.
    const buckets = new Map();
    const order = [];
    for (let i = span - 1; i >= 0; i--) {
      const k = monthRange(year, mIdx - i).key;
      buckets.set(k, { month: k, total: 0, count: 0, items: [] });
      order.push(k);
    }

    let total = 0;
    let count = 0;
    for (const a of accounts) {
      const txns = await api.getTransactions(a.id, windowStart, end);
      for (const t of txns) {
        const payeeName = pn[t.payee] || t.imported_payee || '';
        const parentTransfer = !!(t.transfer_id || t.transferred_id) || TRANSFER_PAYEE.test(payeeName);
        const matches = wantNoPayee ? !payeeName : payeeName.trim().toLowerCase() === target;
        if (!matches) continue;
        for (const lf of leavesOf(t, parentTransfer)) {
          let kind = catInfo[lf.catId] ? catInfo[lf.catId].kind : 'uncat';
          if (kind === 'uncat' && (lf.transfer || parentTransfer)) kind = 'mm';
          const real = kind === 'spend' || kind === 'uncat';
          if (!real || lf.amount >= 0) continue; // spending only (money out)
          const key = t.date.slice(0, 7);
          const b = buckets.get(key);
          if (!b) continue; // outside the window edge
          const dollars = -lf.amount;
          b.total += dollars;
          b.count += 1;
          b.items.push({
            id: lf.id,
            date: t.date,
            payee: payeeName || '(no payee)',
            amount: d2(lf.amount),
            category: catInfo[lf.catId] ? catInfo[lf.catId].name : 'Uncategorized',
            categoryId: lf.catId || null,
            account: a.name,
            accountId: a.id,
            isLeg: !!lf.isLeg,
            parentId: lf.parentId || null,
            cleared: t.cleared,
            notes: lf.notes || t.notes || '',
          });
          total += dollars;
          count += 1;
        }
      }
    }

    const monthsOut = order.map((k) => {
      const b = buckets.get(k);
      b.items.sort((x, y) => (x.date < y.date ? 1 : -1));
      return { month: b.month, total: d2(b.total), count: b.count, items: b.items };
    });
    const monthsSeen = monthsOut.filter((m) => m.count > 0).length;
    return {
      payee: wantNoPayee ? '(no payee)' : payee,
      count,
      total: d2(total),
      avg: count ? d2(total / count) : 0,
      monthsSeen,
      months: monthsOut,
    };
  });
}

// ---------------------------------------------------------------------------
// Write: safe split-aware category change
// ---------------------------------------------------------------------------
async function setTransactionCategory({ id, categoryId, isLeg, parentId, accountId, date }) {
  return withApi(async (api) => {
    if (!isLeg) {
      // Simple, safe path for non-split transactions.
      await api.updateTransaction(id, { category: categoryId || null });
      return { ok: true, mode: 'update' };
    }
    // Split leg: follow the safe-edit rule — rebuild the parent (delete + re-add),
    // preserving imported_id and every other leg. Requires accountId + date to locate.
    if (!parentId || !accountId || !date) throw new Error('parentId, accountId and date required for split legs');
    const txns = await api.getTransactions(accountId, date, date);
    const parent = txns.find((t) => t.id === parentId);
    if (!parent || !Array.isArray(parent.subtransactions)) throw new Error('parent split not found');
    const subs = parent.subtransactions.map((s) => ({
      amount: s.amount,
      category: s.id === id ? categoryId || null : s.category || null,
      notes: s.notes || undefined,
    }));
    const rebuilt = {
      date: parent.date,
      amount: parent.amount,
      payee: parent.payee || undefined,
      notes: parent.notes || undefined,
      cleared: parent.cleared,
      imported_id: parent.imported_id || undefined,
      subtransactions: subs,
    };
    await api.deleteTransaction(parentId);
    await api.addTransactions(accountId, [rebuilt], { learnCategories: false, runTransfers: false });
    return { ok: true, mode: 'rebuild-split' };
  });
}

// ---------------------------------------------------------------------------
// Review inbox — one prioritized daily queue for the app home screen.
// ---------------------------------------------------------------------------
async function getReview({ month } = {}) {
  const m = month || todayYMD().slice(0, 7);
  const start = `${m}-01`;
  const [year, monthNum] = m.split('-').map(Number);
  const end = m === todayYMD().slice(0, 7) ? todayYMD() : monthRange(year, monthNum - 1).end;
  const [txns, insights, recurring, repayments, recon, receipts] = await Promise.all([
    getTransactions({ start, end, collapse: true }),
    getInsights({ month: m }),
    getRecurring({}),
    suggestRepayments({}),
    getReconcilePending(),
    Promise.resolve(getReceipts()),
  ]);

  const tasks = [];
  const seen = new Set();
  const addTxn = (kind, priority, title, subtitle, txn, action = 'open_transaction') => {
    if (!txn || !txn.id || seen.has(`${kind}:${txn.id}`)) return;
    seen.add(`${kind}:${txn.id}`);
    tasks.push({
      id: `${kind}:${txn.id}`,
      kind,
      priority,
      title,
      subtitle,
      action,
      amount: round2(Math.abs(Number(txn.amount) || 0)),
      date: txn.date || null,
      transaction: {
        id: txn.id,
        parentId: txn.parentId || null,
        isLeg: !!txn.isLeg,
        accountId: txn.accountId || '',
        account: txn.account || '',
        payee: txn.payee || '',
        amount: round2(Number(txn.amount) || 0),
        date: txn.date || '',
        category: txn.category || null,
        categoryId: txn.categoryId || null,
        notes: txn.notes || '',
        cleared: txn.cleared !== false,
        imported: !!txn.imported,
      },
    });
  };

  const largeThreshold = Number(process.env.REVIEW_LARGE_CHARGE_THRESHOLD || 200);
  const receiptThreshold = Number(process.env.REVIEW_RECEIPT_THRESHOLD || 75);
  const receiptTxnIds = new Set((receipts.receipts || []).map((r) => String(r.txnId)));
  for (const t of txns) {
    if (!t.category || !String(t.category).trim()) addTxn('uncategorized', 95, 'Categorize transaction', t.payee || 'Uncategorized', t, 'categorize');
    if (t.amount < 0 && Math.abs(t.amount) >= largeThreshold) addTxn('large_charge', 70, 'Review large charge', t.payee || 'Large charge', t);
    if (t.amount < 0 && Math.abs(t.amount) >= receiptThreshold && !receiptTxnIds.has(String(t.id))) addTxn('missing_receipt', 60, 'Attach receipt', t.payee || 'Missing receipt', t, 'open_transaction');
    if (t.cleared === false) addTxn('pending', 35, 'Pending transaction', t.payee || 'Pending', t);
  }

  for (const c of insights.uncategorized || [])
    addTxn('uncategorized', 95, 'Categorize transaction', c.payee || 'Uncategorized', c, 'categorize');

  for (const s of repayments.suggestions || []) {
    const inflow = s.inflow || {};
    if (!inflow.id || seen.has(`repayment:${inflow.id}`)) continue;
    seen.add(`repayment:${inflow.id}`);
    tasks.push({
      id: `repayment:${s.id}`,
      kind: 'repayment',
      priority: 90,
      title: 'Confirm repayment',
      subtitle: `${s.person} · ${s.reason}`,
      action: 'open_reimbursement',
      amount: round2(inflow.amount || 0),
      date: inflow.date || null,
      person: s.person,
    });
  }

  for (const item of recurring.items || []) {
    if (item.priceChange && item.status === 'active') {
      tasks.push({
        id: `price:${item.key}`,
        kind: 'price_change',
        priority: item.priceChange.pct > 0 ? 80 : 45,
        title: item.priceChange.pct > 0 ? 'Subscription price increased' : 'Subscription price dropped',
        subtitle: `${item.payee} · ${item.priceChange.pct > 0 ? '+' : ''}${item.priceChange.pct}%`,
        action: 'open_recurring',
        amount: round2(item.amount),
        date: item.lastCharged || null,
        key: item.key,
      });
    }
  }

  if (recon && recon.pending) {
    tasks.push({
      id: `reconcile:${recon.pending}`,
      kind: 'reconciliation',
      priority: 85,
      title: `Reconcile ${recon.pending}`,
      subtitle: recon.remaining > 0 ? `${recon.remaining} of ${recon.total || 0} expenses left` : 'Ready to close',
      action: 'open_reconcile',
      amount: recon.remaining || 0,
      date: null,
      month: recon.pending,
    });
  }

  tasks.sort((a, b) => b.priority - a.priority || String(b.date || '').localeCompare(String(a.date || '')));
  const counts = {};
  for (const t of tasks) counts[t.kind] = (counts[t.kind] || 0) + 1;
  return { generatedAt: new Date().toISOString(), month: m, count: tasks.length, counts, tasks: tasks.slice(0, 50) };
}

// List of categories for the inline categorize dropdown.
async function getCategories() {
  return withApi(async (api) => {
    const groups = await api.getCategoryGroups();
    const out = [];
    for (const g of groups) {
      if (g.is_income) continue;
      for (const c of g.categories || []) out.push({ id: c.id, name: c.name, group: g.name });
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Recurring & subscriptions engine (cadence, next renewal, price hikes, status)
// ---------------------------------------------------------------------------
async function getRecurring({ window = 18, debug = false, minDates = 3 } = {}) {
  return withApi(async (api) => {
    const now = new Date();
    const startKey = monthRange(now.getFullYear(), now.getMonth() - (window - 1)).start;
    const today = todayYMD();

    const groups = await api.getCategoryGroups();
    const catInfo = buildCatInfo(groups);
    const payees = await api.getPayees();
    const pn = {};
    for (const p of payees) pn[p.id] = p.name || '';
    const accounts = (await api.getAccounts()).filter((a) => !a.closed && !a.offbudget);

    // Gather negative real-spend leaves grouped by normalized payee.
    const byKey = {};
    for (const a of accounts) {
      const txns = await api.getTransactions(a.id, startKey, today);
      for (const t of txns) {
        const payeeName = pn[t.payee] || t.imported_payee || '';
        if (!payeeName) continue;
        const parentTransfer = !!(t.transfer_id || t.transferred_id) || TRANSFER_PAYEE.test(payeeName);
        for (const lf of leavesOf(t, parentTransfer)) {
          let kind = catInfo[lf.catId] ? catInfo[lf.catId].kind : 'uncat';
          if (kind === 'uncat' && (lf.transfer || parentTransfer)) kind = 'mm';
          if (kind === 'mm' || kind === 'reimb' || kind === 'income') continue;
          if (lf.amount >= 0) continue; // outflows only
          const key = recurringKey(payeeName);
          if (!key) continue;
          const rec = (byKey[key] = byKey[key] || {
            key,
            payee: payeeName,
            category: (catInfo[lf.catId] && catInfo[lf.catId].name) || 'Uncategorized',
            charges: [],
          });
          rec.charges.push({ date: t.date, amt: -lf.amount / 100 });
        }
      }
    }

    const overrides = readJsonSafe(OVERRIDES_PATH, {});
    const items = [];
    const candidates = []; // populated only in debug mode
    for (const rec of Object.values(byKey)) {
      const ov = overrides[rec.key] || null;
      // Collapse same-day charges, then require >= 3 distinct dates (>= 2 when the
      // user force-marked this payee as recurring).
      const perDay = {};
      for (const c of rec.charges) perDay[c.date] = (perDay[c.date] || 0) + c.amt;
      const dates = Object.keys(perDay).sort();
      const minReq = ov && ov.forced ? 2 : (debug ? minDates : 3);
      if (dates.length < minReq) continue;
      const amounts = dates.map((d) => perDay[d]);

      const gaps = [];
      for (let i = 1; i < dates.length; i++) gaps.push(daysBetween(dates[i - 1], dates[i]));
      const medianGap = gaps.length ? median(gaps) : 0;
      const meanGap = gaps.length ? gaps.reduce((s, x) => s + x, 0) / gaps.length : 0;
      const cadence = classifyCadence(medianGap);
      const meanAmt = amounts.reduce((s, x) => s + x, 0) / amounts.length;
      const cv = stddev(amounts) / (meanAmt || 1);

      const cat = rec.category || '';
      const blocked = BLOCK_CAT.test(cat);
      const isBillCat = BILL_CAT.test(cat) && !blocked; // broad: amount-variance tolerance only
      const isBill = BILL_DUE_CAT.test(cat) && !blocked; // strict must-pay bill (drives Bills vs Subscriptions split)
      // Real consumer subscriptions/bills are monthly or longer; weekly/biweekly
      // "cadence" almost always means a frequently-visited merchant (coffee, lunch).
      const cadenceOk = !!cadence && CADENCE_DAYS[cadence] >= 25;
      const period = cadence ? CADENCE_DAYS[cadence] : 0;
      // Guard against bursty merchants whose median happens to look monthly but
      // who are really charged far more often than the cadence implies.
      const freqOk = cadenceOk && meanGap >= period * 0.6;
      // Bills (utilities) may swing a lot; discretionary look-alikes must be tight.
      const varOk = isBillCat ? cv <= 0.85 : cv <= 0.4;

      const reasons = [];
      if (blocked) reasons.push('blocked-category');
      if (!cadence) reasons.push('irregular');
      else if (!cadenceOk) reasons.push(`too-frequent(${cadence})`);
      if (cadenceOk && !freqOk) reasons.push('bursty');
      if (!varOk) reasons.push(`amount-variance(${cv.toFixed(2)})`);
      const ok = !blocked && cadenceOk && freqOk && varOk;

      if (debug) {
        candidates.push({
          key: rec.key, payee: rec.payee, category: cat, occurrences: dates.length,
          medianGap: round2(medianGap), meanGap: round2(meanGap), cadence, cv: round2(cv),
          amount: round2(median(amounts)), isBill, blocked, ok, reasons,
          firstCharged: dates[0], lastCharged: dates[dates.length - 1],
          amounts: amounts.map(round2),
        });
      }
      const forced = !!(ov && ov.forced);
      if (!ok && !forced) continue;

      // Forced items may be irregular; fall back to a monthly cadence so we can
      // still project a renewal + monthly-equivalent.
      const effCadence = cadence || (forced ? 'monthly' : cadence);
      const effPeriod = period || (forced ? CADENCE_DAYS.monthly : period);
      const amount = median(amounts);
      const lastCharged = dates[dates.length - 1];
      const nextRenewal = addDays(lastCharged, Math.round(effPeriod));
      const monthlyEquivalent = amount * (30.44 / effPeriod);
      const confidence = Math.max(35, Math.min(99, Math.round(100 - cv * 45 + Math.min(10, dates.length) * 2 + (forced ? -15 : 0))));

      const lastAmt = amounts[amounts.length - 1];
      const prevAmt = amounts[amounts.length - 2];
      let priceChange = null;
      if (prevAmt && Math.abs(lastAmt - prevAmt) / prevAmt > 0.05)
        priceChange = { from: round2(prevAmt), to: round2(lastAmt), pct: Math.round(((lastAmt - prevAmt) / prevAmt) * 100) };

      let status = daysBetween(lastCharged, today) <= effPeriod * 1.8 ? 'active' : 'inactive';
      if (ov && ov.status) status = ov.status; // user override (e.g. cancelled)
      const finalIsBill = ov && typeof ov.isBill === 'boolean' ? ov.isBill : isBill;

      items.push({
        key: rec.key,
        payee: rec.payee,
        category: rec.category,
        cadence: effCadence,
        amount: round2(amount),
        monthlyEquivalent: round2(monthlyEquivalent),
        isBill: finalIsBill, // true bill (utilities/rent/loan/insurance) vs discretionary subscription
        occurrences: dates.length,
        firstCharged: dates[0],
        lastCharged,
        nextRenewal,
        renewalWindow: { start: addDays(nextRenewal, -3), end: addDays(nextRenewal, 3) },
        priceChange,
        confidence,
        firstSeen: dates[0],
        lastAmount: round2(lastAmt || amount),
        previousAmount: prevAmt ? round2(prevAmt) : null,
        providerUrl: `https://www.google.com/search?q=${encodeURIComponent(`${rec.payee} cancel subscription`)}`,
        cancellation: (ov && ov.cancellation) || null,
        status,
        hidden: !!(ov && ov.hidden),
        forced: !!(ov && ov.forced), // user manually marked this recurring
        history: dates.map((d) => ({ date: d, amount: round2(perDay[d]) })),
      });
    }

    if (debug) {
      candidates.sort((a, b) => Number(b.ok) - Number(a.ok) || b.amount - a.amount);
      return { candidates, accepted: candidates.filter((c) => c.ok).length, total: candidates.length };
    }

    items.sort((a, b) => b.monthlyEquivalent - a.monthlyEquivalent);
    const visible = items.filter((i) => !i.hidden);
    const active = visible.filter((i) => i.status === 'active');
    const monthlyTotal = round2(active.reduce((s, i) => s + i.monthlyEquivalent, 0));
    // Split totals so the home Subscriptions card and the Upcoming Bills section
    // don't double-count the same items (bills are projected into getBills).
    const subsActive = active.filter((i) => !i.isBill);
    const billsActive = active.filter((i) => i.isBill);
    const subMonthlyTotal = round2(subsActive.reduce((s, i) => s + i.monthlyEquivalent, 0));
    const billMonthlyTotal = round2(billsActive.reduce((s, i) => s + i.monthlyEquivalent, 0));
    return {
      items: visible,
      monthlyTotal,
      annualTotal: round2(monthlyTotal * 12),
      activeCount: active.length,
      count: visible.length,
      subMonthlyTotal,
      subActiveCount: subsActive.length,
      billMonthlyTotal,
      billActiveCount: billsActive.length,
    };
  });
}

function setRecurringOverride({ key, status, hidden, forced, isBill, cancellation } = {}) {
  if (!key) throw new Error('key required');
  const overrides = readJsonSafe(OVERRIDES_PATH, {});
  const cur = overrides[key] || {};
  if (forced !== undefined) {
    if (forced) cur.forced = true;
    else delete cur.forced;
  }
  if (isBill !== undefined) {
    if (isBill === null) delete cur.isBill; // clear to fall back to auto-detected type
    else cur.isBill = !!isBill;
  }
  if (status !== undefined) {
    if (!status || status === 'active') delete cur.status;
    else cur.status = status; // 'cancelled'
  }
  if (hidden !== undefined) {
    if (hidden) cur.hidden = true;
    else delete cur.hidden;
  }
  if (cancellation !== undefined) {
    const prev = cur.cancellation || {};
    const next = { ...prev, ...cancellation };
    for (const k of Object.keys(next)) {
      if (next[k] === null || next[k] === undefined || next[k] === '') delete next[k];
    }
    if (Object.keys(next).length) cur.cancellation = next;
    else delete cur.cancellation;
  }
  if (Object.keys(cur).length) overrides[key] = cur;
  else delete overrides[key];
  writeJsonSafe(OVERRIDES_PATH, overrides);
  return { ok: true, key, override: overrides[key] || null };
}

// ---------------------------------------------------------------------------
// Recurring income — paycheck/deposit streams + next payday projection.
// Mirrors getRecurring but for income-category inflows.
// ---------------------------------------------------------------------------
async function getIncome({ window = 12 } = {}) {
  return withApi(async (api) => {
    const now = new Date();
    const startKey = monthRange(now.getFullYear(), now.getMonth() - (window - 1)).start;
    const today = todayYMD();

    const groups = await api.getCategoryGroups();
    const catInfo = buildCatInfo(groups);
    const payees = await api.getPayees();
    const pn = {};
    for (const p of payees) pn[p.id] = p.name || '';
    const accounts = (await api.getAccounts()).filter((a) => !a.closed && !a.offbudget);

    const byKey = {};
    for (const a of accounts) {
      const txns = await api.getTransactions(a.id, startKey, today);
      for (const t of txns) {
        const payeeName = pn[t.payee] || t.imported_payee || '';
        if (!payeeName) continue;
        const parentTransfer = !!(t.transfer_id || t.transferred_id) || TRANSFER_PAYEE.test(payeeName);
        for (const lf of leavesOf(t, parentTransfer)) {
          if (lf.transfer || parentTransfer) continue;
          const kind = catInfo[lf.catId] ? catInfo[lf.catId].kind : 'uncat';
          if (kind !== 'income') continue; // income-category leaves only
          if (lf.amount <= 0) continue;     // inflows only
          const key = incomeKey(payeeName, `${t.notes || ''} ${t.imported_payee || ''}`);
          if (!key) continue;
          const rec = (byKey[key] = byKey[key] || {
            key, payee: key === 'interest' ? 'Interest' : payeeName,
            category: (catInfo[lf.catId] && catInfo[lf.catId].name) || 'Income',
            charges: [], names: [],
          });
          rec.names.push(payeeName);
          rec.charges.push({ date: t.date, amt: lf.amount / 100 });
        }
      }
    }

    const streams = [];
    for (const rec of Object.values(byKey)) {
      const perDay = {};
      for (const c of rec.charges) perDay[c.date] = (perDay[c.date] || 0) + c.amt;
      const dates = Object.keys(perDay).sort();
      if (dates.length < 2) continue; // need >=2 deposits to infer a cadence
      const amounts = dates.map((d) => perDay[d]);
      const gaps = [];
      for (let i = 1; i < dates.length; i++) gaps.push(daysBetween(dates[i - 1], dates[i]));
      const cadence = classifyCadence(median(gaps));
      if (!cadence) continue; // irregular deposits aren't a paycheck
      const period = CADENCE_DAYS[cadence];
      const amount = median(amounts);
      const lastPaid = dates[dates.length - 1];
      let nextPay = addDays(lastPaid, Math.round(period));
      let guard = 0;
      while (nextPay < today && guard < 64) { nextPay = addDays(nextPay, Math.round(period)); guard++; }
      const displayPayee = rec.key === 'interest' ? 'Interest' : bestPayeeLabel(rec.names);
      streams.push({
        key: rec.key, payee: displayPayee, category: rec.category, cadence,
        amount: round2(amount),
        monthlyEquivalent: round2(amount * (30.44 / period)),
        occurrences: dates.length,
        lastPaid, nextPay,
        active: daysBetween(lastPaid, today) <= period * 2,
        history: dates.slice(-6).map((d) => ({ date: d, amount: round2(perDay[d]) })),
      });
    }
    streams.sort((a, b) => b.monthlyEquivalent - a.monthlyEquivalent);
    const active = streams.filter((s) => s.active);
    const monthlyTotal = round2(active.reduce((s, x) => s + x.monthlyEquivalent, 0));
    const nextPayday = active.map((s) => s.nextPay).sort()[0] || null;
    const nextStream = nextPayday ? active.find((s) => s.nextPay === nextPayday) : null;
    // `primary` = the dominant paycheck (largest by monthly value). streams is
    // already sorted desc, so active[0] is it. Drives the home headline so it
    // surfaces the real paycheck instead of, say, a tiny interest deposit.
    const primary = active[0] || null;
    return {
      streams,
      activeCount: active.length,
      count: streams.length,
      monthlyTotal,
      annualTotal: round2(monthlyTotal * 12),
      nextPayday,
      nextPaydayAmount: nextStream ? nextStream.amount : null,
      nextPaydayPayee: nextStream ? nextStream.payee : null,
      primaryPayee: primary ? primary.payee : null,
      primaryAmount: primary ? primary.amount : null,
      primaryMonthly: primary ? primary.monthlyEquivalent : null,
      primaryCadence: primary ? primary.cadence : null,
      primaryNextPay: primary ? primary.nextPay : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Upcoming bills — projected from active recurring items (paid-state aware)
// ---------------------------------------------------------------------------
async function getBills({ days = 45 } = {}) {
  const { items } = await getRecurring({});
  const today = todayYMD();
  const horizon = addDays(today, days);
  const paid = readJsonSafe(BILLS_PAID_PATH, {});
  const bills = [];
  for (const it of items) {
    if (it.status !== 'active') continue;
    if (!it.isBill) continue; // bills view = true bills only; subscriptions live in their own screen
    const period = Math.round(CADENCE_DAYS[it.cadence] || 30.44);
    const hist = it.history || [];
    const amtTol = Math.max(2, Math.abs(it.amount) * 0.35); // utilities swing; allow ±35% (min $2)
    let due = it.nextRenewal;
    let guard = 0;
    while (due < today && guard < 64) { due = addDays(due, period); guard++; } // roll overdue forward
    while (due <= horizon && guard < 96) {
      const id = `${it.key}|${due}`;
      // Auto-derive "paid" by matching a real recorded charge to this cycle: a
      // charge in the window leading up to (and just past) the due date with a
      // comparable amount. The lower bound excludes the prior cycle's charge so
      // we don't mis-flag the upcoming occurrence as already paid.
      const lo = addDays(due, -Math.round(period * 0.45));
      const hi = addDays(due, 7);
      const match = hist.find((h) => h.date >= lo && h.date <= hi && Math.abs(Math.abs(h.amount) - Math.abs(it.amount)) <= amtTol);
      const manual = paid[id];
      bills.push({
        id, key: it.key, payee: it.payee, amount: it.amount, dueDate: due,
        category: it.category, cadence: it.cadence,
        paid: !!match || !!manual,
        paidDate: match ? match.date : (manual ? manual.paidDate : null),
        // Present only when linked to a real transaction (vs a manual flag).
        matched: match ? { date: match.date, amount: match.amount } : null,
        variance: match ? round2(Math.abs(match.amount) - Math.abs(it.amount)) : null,
      });
      due = addDays(due, period);
      guard++;
    }
  }
  bills.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const unpaid = bills.filter((b) => !b.paid);
  return {
    bills,
    total: round2(unpaid.reduce((s, b) => s + b.amount, 0)),
    count: bills.length,
    unpaidCount: unpaid.length,
    horizonDays: days,
  };
}

// ---------------------------------------------------------------------------
// Forecast — forward cash balance from known inflows/outflows.
// ---------------------------------------------------------------------------
async function getForecast({ days = 90 } = {}) {
  const horizonDays = Math.min(180, Math.max(30, Number(days) || 90));
  const today = todayYMD();
  const horizon = addDays(today, horizonDays);
  const [accounts, income, bills, budgets, reimb] = await Promise.all([
    getAccounts(),
    getIncome({}),
    getBills({ days: horizonDays }),
    getBudgets({}),
    getReimbursement({}),
  ]);
  const startBalance = round2(accounts.filter((a) => !a.hidden && !a.offbudget && a.balance > 0).reduce((s, a) => s + a.balance, 0));
  const events = [];
  const pushEvent = (date, label, amount, kind) => {
    if (!date || date < today || date > horizon || !Number.isFinite(Number(amount)) || Math.abs(Number(amount)) < 0.005) return;
    events.push({ date, label, amount: round2(Number(amount)), kind });
  };

  for (const s of income.streams || []) {
    if (!s.active) continue;
    let due = s.nextPay;
    const period = Math.round(CADENCE_DAYS[s.cadence] || 30.44);
    let guard = 0;
    while (due < today && guard < 64) { due = addDays(due, period); guard++; }
    while (due <= horizon && guard < 128) {
      pushEvent(due, s.payee || 'Income', Math.abs(s.amount), 'income');
      due = addDays(due, period);
      guard++;
    }
  }
  for (const b of bills.bills || []) if (!b.paid) pushEvent(b.dueDate, b.payee || 'Bill', -Math.abs(b.amount), 'bill');
  if (budgets.totalRemaining > 0) {
    const dailyBudget = round2(budgets.totalRemaining / Math.max(1, budgets.daysInMonth - budgets.daysElapsed + 1));
    for (let i = 0; i <= Math.min(horizonDays, budgets.daysInMonth - budgets.daysElapsed); i++) pushEvent(addDays(today, i), 'Planned budget spend', -dailyBudget, 'budget');
  }
  if (reimb.totalOwed > 0.5) pushEvent(addDays(today, 14), 'Expected reimbursements', reimb.totalOwed, 'reimbursement');

  events.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
  const byDate = new Map();
  for (const e of events) {
    const cur = byDate.get(e.date) || { date: e.date, inflow: 0, outflow: 0, events: [] };
    if (e.amount >= 0) cur.inflow = round2(cur.inflow + e.amount);
    else cur.outflow = round2(cur.outflow + Math.abs(e.amount));
    cur.events.push(e);
    byDate.set(e.date, cur);
  }
  const points = [];
  let balance = startBalance;
  let lowest = { date: today, balance };
  for (let i = 0; i <= horizonDays; i++) {
    const date = addDays(today, i);
    const day = byDate.get(date);
    if (day) balance = round2(balance + day.inflow - day.outflow);
    const p = { date, balance, inflow: day ? day.inflow : 0, outflow: day ? day.outflow : 0 };
    points.push(p);
    if (p.balance < lowest.balance) lowest = { date, balance: p.balance };
  }
  return {
    generatedAt: new Date().toISOString(),
    range: { start: today, end: horizon, days: horizonDays },
    startBalance,
    endingBalance: points[points.length - 1].balance,
    lowest,
    totals: {
      inflow: round2(events.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0)),
      outflow: round2(events.filter((e) => e.amount < 0).reduce((s, e) => s + Math.abs(e.amount), 0)),
    },
    points,
    events: events.slice(0, 200),
    warnings: lowest.balance < 0 ? [`Projected cash drops below $0 on ${lowest.date}`] : [],
  };
}

// Toggle a bill occurrence's paid state. Identified by `${recurringKey}|${dueDate}`.
function setBillPaid({ id, key, dueDate, paid } = {}) {
  const billId = id || (key && dueDate ? `${key}|${dueDate}` : null);
  if (!billId) throw new Error('id (or key + dueDate) required');
  const store = readJsonSafe(BILLS_PAID_PATH, {});
  if (paid === false) delete store[billId];
  else store[billId] = { paidDate: todayYMD() };
  writeJsonSafe(BILLS_PAID_PATH, store);
  return { ok: true, id: billId, paid: paid !== false };
}

// Resolve a free-text payee name to an id (find-or-create). Empty => null.
async function resolvePayeeId(api, name) {
  const n = (name || '').trim();
  if (!n) return null;
  const payees = await api.getPayees();
  const found = payees.find((p) => (p.name || '').toLowerCase() === n.toLowerCase());
  return found ? found.id : await api.createPayee({ name: n });
}

// Fetch one transaction (parent or simple) with its legs, for the split editor and
// detail view. Needs the account + date to locate it cheaply.
async function getTransactionById({ id, accountId, date } = {}) {
  if (!id || !accountId || !date) throw new Error('id, accountId and date required');
  return withApi(async (api) => {
    const [txns, cats, payees, accts] = await Promise.all([
      api.getTransactions(accountId, date, date),
      api.getCategories(),
      api.getPayees(),
      api.getAccounts(),
    ]);
    const catMap = Object.fromEntries(cats.map((c) => [c.id, c.name]));
    const pn = Object.fromEntries(payees.map((p) => [p.id, p.name]));
    const acctName = (accts.find((a) => a.id === accountId) || {}).name || accountId;
    // If they handed us a leg id, resolve to its parent.
    let t = txns.find((x) => x.id === id);
    if (t && t.parent_id) t = txns.find((x) => x.id === t.parent_id) || t;
    if (!t) throw new Error('transaction not found');
    const subs = Array.isArray(t.subtransactions) ? t.subtransactions : [];
    return {
      id: t.id,
      accountId,
      account: acctName,
      date: t.date,
      payee: pn[t.payee] || t.imported_payee || '',
      amount: t.amount / 100,
      category: catMap[t.category] || null,
      categoryId: t.category || null,
      notes: t.notes || '',
      cleared: t.cleared,
      imported: !!t.imported_id,
      isSplit: !!(t.is_parent && subs.length),
      legs: subs.map((s) => ({
        id: s.id,
        amount: s.amount / 100,
        categoryId: s.category || null,
        category: catMap[s.category] || null,
        name: (s.payee && pn[s.payee]) || '',
        notes: s.notes || '',
      })),
    };
  });
}

// Create OR edit a split. `legs` carry SIGNED dollar amounts (matching the parent's
// sign) that must sum to the parent total, plus optional per-leg categoryId / name /
// notes. Two safe paths, both verified against the Actual API:
//   * FIRST split (simple txn): delete + re-add as a parent w/ subs (preserves
//     imported_id); then, if any leg was named, apply names via an in-place parent
//     update (import subs can't carry a payee).
//   * EDIT (already a parent): one in-place updateTransaction({subtransactions}) that
//     reconciles legs BY ID — legs with an id keep it (stable identity for reimb
//     links + receipts), legs without one are added, omitted legs are removed.
// NOTE: converting a *simple* txn via updateTransaction throws async in Actual, hence
// the delete+re-add path for the first split.
async function splitTransaction({ id, accountId, date, legs } = {}) {
  return withApi(async (api) => {
    if (!accountId || !date) throw new Error('accountId and date required');
    if (!Array.isArray(legs) || legs.length < 2) throw new Error('at least 2 legs required');
    const txns = await api.getTransactions(accountId, date, date);
    const target = txns.find((t) => t.id === id);
    if (!target) throw new Error('transaction not found');
    if (target.parent_id) throw new Error('edit the whole split, not a single leg');
    const total = target.amount; // integer cents (sign preserved)

    const norm = legs.map((l) => {
      const cents = Math.round(Number(l.amount) * 100);
      if (!Number.isFinite(cents) || cents === 0) throw new Error('each leg needs a non-zero amount');
      return { id: l.id || null, cents, categoryId: l.categoryId || null, name: (l.name || '').trim(), notes: (l.notes || '').trim() };
    });
    const sum = norm.reduce((s, x) => s + x.cents, 0);
    if (sum !== total) throw new Error(`legs must sum to ${(total / 100).toFixed(2)} (got ${(sum / 100).toFixed(2)})`);
    for (const l of norm) l.payeeId = l.name ? await resolvePayeeId(api, l.name) : null;

    if (target.is_parent) {
      const subs = norm.map((l) => ({
        id: l.id || undefined,
        amount: l.cents,
        category: l.categoryId || null,
        notes: l.notes || undefined,
        payee: l.payeeId || undefined,
      }));
      await api.updateTransaction(target.id, { subtransactions: subs });
      return { ok: true, mode: 'edit', legs: subs.length, id: target.id };
    }

    // First split — delete + re-add (import subs take only amount/category/notes).
    const beforeParents = new Set(txns.filter((t) => t.is_parent).map((t) => t.id));
    const rebuilt = {
      account: accountId,
      date: target.date,
      amount: total,
      payee: target.payee || undefined,
      notes: target.notes || undefined,
      cleared: target.cleared,
      imported_id: target.imported_id || undefined,
      subtransactions: norm.map((l) => ({ amount: l.cents, category: l.categoryId || null, notes: l.notes || undefined })),
    };
    await api.deleteTransaction(id);
    await api.addTransactions(accountId, [rebuilt], { learnCategories: false, runTransfers: false });

    if (norm.some((l) => l.payeeId)) {
      const after = await api.getTransactions(accountId, date, date);
      const p = after.find((t) => t.is_parent && !beforeParents.has(t.id) && Array.isArray(t.subtransactions) && t.subtransactions.length === norm.length);
      if (p) {
        const subs = p.subtransactions.map((s, i) => ({ id: s.id, amount: s.amount, category: s.category || null, notes: norm[i].notes || undefined, payee: norm[i].payeeId || undefined }));
        await api.updateTransaction(p.id, { subtransactions: subs });
      }
    }
    return { ok: true, mode: 'create', legs: norm.length };
  });
}

// When a pending charge you'd already split later POSTS at a different amount, the
// bank updates the parent total but the legs still sum to the old total. Rather than
// force you to re-split, absorb the difference into the master (first/remainder) leg
// so the split stays valid — exactly what you asked for. Idempotent; runs on refresh.
async function reconcileSplitDeltas(api, { months = 3 } = {}) {
  const today = todayYMD();
  const start = addDays(today, -Math.round(30.44 * months));
  const accounts = (await api.getAccounts()).filter((a) => !a.closed);
  let fixed = 0;
  for (const a of accounts) {
    const txns = await api.getTransactions(a.id, start, today);
    for (const t of txns) {
      if (!t.is_parent || !Array.isArray(t.subtransactions) || t.subtransactions.length < 2) continue;
      const subSum = t.subtransactions.reduce((s, x) => s + (x.amount || 0), 0);
      const delta = t.amount - subSum; // integer cents the master must absorb
      if (delta === 0) continue;
      const master = t.subtransactions[0];
      const newMaster = (master.amount || 0) + delta;
      // A 0-amount leg is invalid in Actual, and flipping the master's sign would
      // mean the posted total no longer resembles the original split — skip & log.
      if (newMaster === 0 || Math.sign(newMaster) !== Math.sign(t.amount)) {
        console.error(`[split-delta] ${t.id} needs manual re-split (Δ ${(delta / 100).toFixed(2)})`);
        continue;
      }
      const subs = t.subtransactions.map((s, i) => ({
        id: s.id,
        amount: i === 0 ? newMaster : s.amount,
        category: s.category || null,
        notes: s.notes || undefined,
        payee: s.payee || undefined,
      }));
      try { await api.updateTransaction(t.id, { subtransactions: subs }); fixed++; }
      catch (e) { console.error(`[split-delta] ${t.id} update failed: ${e.message}`); }
    }
  }
  return fixed;
}
// Self-contained wrapper for the refresh pipeline.
async function reconcileSplits() {
  const fixed = await withApi((api) => reconcileSplitDeltas(api));
  if (fixed) await syncNow().catch(() => {});
  return { ok: true, fixed };
}

// Auto-file expenses that someone else actually pays (tagged #<person>) into
// the Reimbursement category, so they drop out of
// personal spending and surface as "owed" in Who-Owes-Me. Idempotent — safe to run
// on every sync. Only negative (real expense) spend/uncat leaves carrying a target
// tag are touched; already-reimbursed / income / transfer leaves are left alone.
async function sweepReimbursementTags({ tags, from, to } = {}) {
  return withApi(async (api) => {
    const cfg = loadOwesConfig();
    const targetTags = (tags && tags.length ? tags : cfg.autoReimbTags || []).map((s) => String(s).toLowerCase());
    const tagSet = new Set(targetTags);
    if (!tagSet.size) return { ok: true, moved: 0, tags: [], items: [] };

    const groups = await api.getCategoryGroups();
    const catInfo = buildCatInfo(groups);
    let reimbId = null;
    for (const g of groups) for (const c of g.categories || []) if (REIMB_CAT.test(c.name || '')) reimbId = c.id;
    if (!reimbId) throw new Error('Reimbursement category not found');

    const start = from || `${new Date().getFullYear()}-01-01`;
    const end = to || todayYMD();
    const accts = (await api.getAccounts()).filter((a) => !a.closed && !a.offbudget);

    const hasTargetTag = (note) =>
      (String(note || '').match(/#[a-z0-9_-]+/gi) || []).some((s) => tagSet.has(s.slice(1).toLowerCase()));
    const isSpendKind = (catId) => {
      const k = catInfo[catId] ? catInfo[catId].kind : 'uncat';
      return k === 'spend' || k === 'uncat';
    };

    const moved = [];
    for (const a of accts) {
      const txns = await api.getTransactions(a.id, start, end);
      for (const t of txns) {
        const isSplit = t.is_parent && Array.isArray(t.subtransactions) && t.subtransactions.length;
        if (isSplit) {
          let changed = false;
          const subs = t.subtransactions.map((s) => {
            const hit = s.amount < 0 && isSpendKind(s.category) && hasTargetTag(s.notes || t.notes);
            if (hit) { changed = true; moved.push({ id: s.id, amount: d2(s.amount), leg: true }); }
            return {
              id: s.id,
              amount: s.amount,
              category: hit ? reimbId : s.category || null,
              notes: s.notes || undefined,
              payee: s.payee || undefined,
            };
          });
          if (changed) await api.updateTransaction(t.id, { subtransactions: subs });
        } else if (!t.is_parent) {
          if (t.amount < 0 && isSpendKind(t.category) && hasTargetTag(t.notes)) {
            await api.updateTransaction(t.id, { category: reimbId });
            moved.push({ id: t.id, amount: d2(t.amount), leg: false });
          }
        }
      }
    }
    return { ok: true, moved: moved.length, tags: targetTags, items: moved };
  });
}

// ---------------------------------------------------------------------------
// Phantom pending cleanup — remove pending bank-imported charges that fell off
// the card (dropped auth holds, or holds that posted as a separate cleared row).
// Deliberately conservative; see the two rules below. Never touches manual rows,
// cleared rows, splits, or anything you've annotated (a note / #keep protects it).
// ---------------------------------------------------------------------------
function readPhantomSeen() {
  const s = readJsonSafe(PHANTOM_SEEN_PATH, { seen: {} });
  return s && s.seen && typeof s.seen === 'object' ? s : { seen: {} };
}
function readPhantomLog() {
  const s = readJsonSafe(PHANTOM_LOG_PATH, { deleted: [] });
  return s && Array.isArray(s.deleted) ? s : { deleted: [] };
}
// Loose merchant match: normalize to lowercase alphanumerics and require one to
// contain the other (handles "KEKES #12 ANN ARBOR" vs "Kekes").
function payeeAlike(a, b) {
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  const short = x.length <= y.length ? x : y;
  const long = x.length <= y.length ? y : x;
  return short.length >= 3 && long.includes(short);
}

async function cleanupPhantoms({ window = 60, agedDays = 14, observeDays = 10, dryRun = false } = {}) {
  return withApi(async (api) => {
    const today = todayYMD();
    const start = addDays(today, -Math.abs(window));
    const payees = await api.getPayees();
    const pn = {};
    for (const p of payees) pn[p.id] = p.name || '';
    const accts = (await api.getAccounts()).filter((a) => !a.closed);

    const store = readPhantomSeen();
    const log = readPhantomLog();
    const nowIso = new Date().toISOString();
    const liveIds = new Set();
    const deleted = [];
    const flaggedAged = [];

    const nameOf = (t) => pn[t.payee] || t.imported_payee || '';
    const hasNote = (t) => {
      const n = String(t.notes || '');
      return n.trim().length > 0; // any user note (incl. #keep) protects the row
    };
    const daysOld = (d) => Math.round((new Date(today) - new Date(d)) / 86400000);

    for (const acct of accts) {
      const txns = await api.getTransactions(acct.id, start, today);
      const pendings = txns.filter((t) => t.imported_id && t.cleared === false && !t.is_parent && !t.parent_id);
      const cleared = txns.filter((t) => t.cleared === true && !t.is_parent);

      for (const p of pendings) {
        const id = String(p.id);
        liveIds.add(id);
        const amt = d2(p.amount);
        const payee = nameOf(p);
        // Strike ledger: remember when we first saw it pending.
        const prev = store.seen[id];
        store.seen[id] = { firstSeen: (prev && prev.firstSeen) || nowIso, lastSeen: nowIso, amount: amt, date: p.date, payee };
        const firstSeenDays = Math.round((new Date(today) - new Date(store.seen[id].firstSeen)) / 86400000);

        // Rule A — superseded: a cleared charge for the same merchant, similar
        // amount, dated on/after the hold => the auth actually posted.
        const magP = Math.abs(amt);
        const superseder = cleared.find((q) => {
          if (q.id === p.id) return false;
          const magQ = Math.abs(d2(q.amount));
          const near = Math.abs(magQ - magP) <= Math.max(2, magP * 0.30);
          return near && q.date >= addDays(p.date, -1) && payeeAlike(payee, nameOf(q));
        });

        let reason = null;
        if (superseder) reason = `superseded by cleared ${nameOf(superseder)} ${d2(superseder.amount)} on ${superseder.date}`;
        else if (!hasNote(p) && daysOld(p.date) >= agedDays && firstSeenDays >= observeDays)
          reason = `dropped hold: pending ${agedDays}d+ (age ${daysOld(p.date)}d, watched ${firstSeenDays}d), no matching posted charge`;

        if (!reason) {
          if (!hasNote(p) && daysOld(p.date) >= agedDays && firstSeenDays < observeDays)
            flaggedAged.push({ id, payee, amount: amt, date: p.date, watchedDays: firstSeenDays, needDays: observeDays });
          continue;
        }

        const rec = { id, account: acct.name, payee, amount: amt, date: p.date, reason, at: nowIso, dryRun: !!dryRun };
        if (!dryRun) {
          await deleteTransaction({ id, allowImported: true });
          log.deleted.push(rec);
          delete store.seen[id];
        }
        deleted.push(rec);
      }
    }

    // Forget ledger entries whose transaction is gone (cleared or removed).
    for (const id of Object.keys(store.seen)) if (!liveIds.has(id) && !deleted.some((d) => d.id === id)) delete store.seen[id];

    if (!dryRun) {
      writeJsonSafe(PHANTOM_SEEN_PATH, store);
      if (log.deleted.length > 500) log.deleted = log.deleted.slice(-500);
      writeJsonSafe(PHANTOM_LOG_PATH, log);
    }
    return { ok: true, dryRun: !!dryRun, deletedCount: deleted.length, deleted, flaggedAged, watching: Object.keys(store.seen).length };
  });
}
function getPhantomLog({ limit = 100 } = {}) {
  const log = readPhantomLog();
  return { deleted: log.deleted.slice(-Math.abs(limit)).reverse(), total: log.deleted.length };
}

// ---------------------------------------------------------------------------
// Receipts — scan a receipt, link it to a transaction, keep the raw image on the
// server (durable) alongside the on-device copy. Metadata lives in receipts.json,
// image bytes in RECEIPTS_DIR/<id>.<ext>.
// ---------------------------------------------------------------------------
function readReceipts() {
  const s = readJsonSafe(RECEIPTS_PATH, { byTxn: {} });
  return s && s.byTxn && typeof s.byTxn === 'object' ? s : { byTxn: {} };
}
const EXT_FOR_MIME = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heic', 'image/webp': 'webp' };
function ensureReceiptsDir() { try { fs.mkdirSync(RECEIPTS_DIR, { recursive: true }); } catch (_) {} }

// Persist a scanned receipt. `imageBase64` is the raw (optionally data-URI-prefixed)
// image; OCR text/lines + a guessed total/date are stored for search + display.
function addReceipt({ txnId, imageBase64, mime, ocrText, ocrLines, amount, date, source } = {}) {
  if (!txnId) throw new Error('txnId required');
  if (!imageBase64) throw new Error('imageBase64 required');
  const cleanB64 = String(imageBase64).replace(/^data:[^;]+;base64,/, '');
  const buf = Buffer.from(cleanB64, 'base64');
  if (!buf.length) throw new Error('empty image');
  if (buf.length > 25 * 1024 * 1024) throw new Error('image too large (max 25MB)');
  const m = (mime || 'image/jpeg').toLowerCase();
  const ext = EXT_FOR_MIME[m] || 'jpg';
  const id = `rcpt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  ensureReceiptsDir();
  fs.writeFileSync(path.join(RECEIPTS_DIR, `${id}.${ext}`), buf);
  const rec = {
    id, txnId: String(txnId), file: `${id}.${ext}`, mime: m, size: buf.length,
    ocrText: typeof ocrText === 'string' ? ocrText.slice(0, 8000) : '',
    ocrLines: Array.isArray(ocrLines) ? ocrLines.slice(0, 200) : [],
    amount: Number.isFinite(Number(amount)) ? round2(Number(amount)) : null,
    date: date || null,
    source: source || 'camera',
    uploadedAt: new Date().toISOString(),
  };
  const store = readReceipts();
  (store.byTxn[rec.txnId] = store.byTxn[rec.txnId] || []).push(rec);
  writeJsonSafe(RECEIPTS_PATH, store);
  return publicReceipt(rec);
}
// Strip server-only fields for API responses (the file name stays internal).
function publicReceipt(r) {
  return { id: r.id, txnId: r.txnId, mime: r.mime, size: r.size, ocrText: r.ocrText, ocrLines: r.ocrLines, amount: r.amount, date: r.date, source: r.source, uploadedAt: r.uploadedAt };
}
function getReceipts({ txnId } = {}) {
  const store = readReceipts();
  if (txnId) return { receipts: (store.byTxn[String(txnId)] || []).map(publicReceipt) };
  const all = [];
  for (const list of Object.values(store.byTxn)) for (const r of list) all.push(publicReceipt(r));
  return { receipts: all };
}
// Resolve a receipt id to its on-disk file for streaming.
function getReceiptFile({ id } = {}) {
  if (!id) return null;
  const store = readReceipts();
  for (const list of Object.values(store.byTxn)) {
    const r = list.find((x) => x.id === id);
    if (r) return { path: path.join(RECEIPTS_DIR, r.file), mime: r.mime };
  }
  return null;
}
function deleteReceipt({ id } = {}) {
  if (!id) throw new Error('id required');
  const store = readReceipts();
  let removed = null;
  for (const [txn, list] of Object.entries(store.byTxn)) {
    const idx = list.findIndex((x) => x.id === id);
    if (idx >= 0) {
      removed = list[idx];
      list.splice(idx, 1);
      if (!list.length) delete store.byTxn[txn];
      break;
    }
  }
  if (removed) {
    try { fs.unlinkSync(path.join(RECEIPTS_DIR, removed.file)); } catch (_) {}
    writeJsonSafe(RECEIPTS_PATH, store);
  }
  return { ok: true, removed: !!removed };
}

// Collapse a split back into a single plain transaction (RM's "remove split").
// delete + re-add as a simple row so we never hit the unsafe in-place unsplit path.
async function removeSplit({ id, accountId, date, categoryId } = {}) {
  return withApi(async (api) => {
    if (!accountId || !date) throw new Error('accountId and date required');
    const txns = await api.getTransactions(accountId, date, date);
    let parent = txns.find((t) => t.id === id);
    if (parent && parent.parent_id) parent = txns.find((t) => t.id === parent.parent_id) || parent;
    if (!parent) throw new Error('transaction not found');
    if (!parent.is_parent) return { ok: true, mode: 'noop' }; // already simple
    const rebuilt = {
      account: accountId,
      date: parent.date,
      amount: parent.amount,
      payee: parent.payee || undefined,
      notes: parent.notes || undefined,
      cleared: parent.cleared,
      category: categoryId || undefined,
      imported_id: parent.imported_id || undefined,
    };
    await api.deleteTransaction(parent.id);
    await api.addTransactions(accountId, [rebuilt], { learnCategories: false, runTransfers: false });
    return { ok: true, mode: 'unsplit' };
  });
}

// Permanently remove a transaction. Deleting a split parent removes its legs too.
// Rocket-Money parity: user-facing deletes are refused for BANK-IMPORTED rows
// (those carry an imported_id) — only manually-added ones can be deleted by hand.
// The automated phantom cleanup passes allowImported=true to remove stale pending
// charges that fell off the feed. The guard only runs when accountId+date are given
// (so it can locate the row); otherwise it trusts the caller (the app hides delete
// for imported rows client-side too).
async function deleteTransaction({ id, accountId, date, allowImported = false } = {}) {
  if (!id) throw new Error('id required');
  return withApi(async (api) => {
    if (!allowImported && accountId && date) {
      const txns = await api.getTransactions(accountId, date, date);
      let t = txns.find((x) => x.id === id);
      if (t && t.parent_id) t = txns.find((x) => x.id === t.parent_id) || t;
      if (t && t.imported_id) {
        throw new Error('Bank-imported transactions can’t be deleted — only ones you added manually.');
      }
    }
    await api.deleteTransaction(id);
    return { ok: true, deleted: id };
  });
}

// Rename a transaction's payee (RM "rename"). Resolves the free-text name to a payee
// (find-or-create); Actual keeps imported_payee + imported_id untouched so the
// original bank description and future matching are preserved. Blank name clears it.
async function setPayee({ id, payee, isLeg, parentId, accountId, date } = {}) {
  return withApi(async (api) => {
    const payeeId = await resolvePayeeId(api, payee);
    if (!isLeg) {
      await api.updateTransaction(id, { payee: payeeId || null });
      return { ok: true, mode: 'update' };
    }
    if (!parentId || !accountId || !date) throw new Error('parentId, accountId and date required for split legs');
    const txns = await api.getTransactions(accountId, date, date);
    const parent = txns.find((t) => t.id === parentId);
    if (!parent || !Array.isArray(parent.subtransactions)) throw new Error('parent split not found');
    const subs = parent.subtransactions.map((s) => ({
      id: s.id,
      amount: s.amount,
      category: s.category || null,
      notes: s.notes || undefined,
      payee: s.id === id ? payeeId || null : s.payee || undefined,
    }));
    await api.updateTransaction(parentId, { subtransactions: subs });
    return { ok: true, mode: 'edit-leg' };
  });
}

// ---------------------------------------------------------------------------
// Categorization rules — auto-apply a category to matching (uncategorized) txns
// ---------------------------------------------------------------------------
function getRules() {
  const store = readJsonSafe(RULES_PATH, { rules: [] });
  return { rules: Array.isArray(store.rules) ? store.rules : [] };
}

// Apply a single rule to uncategorized, non-split txns in a window. Only ever
// fills an EMPTY category, so it can't clobber a manual categorization.
async function applyRuleToTxns(api, rule, { months = 24 } = {}) {
  const today = todayYMD();
  const start = addDays(today, -Math.round(30.44 * months));
  const accounts = (await api.getAccounts()).filter((a) => !a.closed);
  const payees = await api.getPayees();
  const pn = {};
  for (const p of payees) pn[p.id] = p.name || '';
  const needle = (rule.match || '').toLowerCase().trim();
  if (!needle || !rule.categoryId) return 0;
  let applied = 0;
  for (const a of accounts) {
    const txns = await api.getTransactions(a.id, start, today);
    for (const t of txns) {
      if (t.is_parent || t.parent_id) continue; // don't touch splits
      if (t.category) continue; // only uncategorized
      const name = (pn[t.payee] || t.imported_payee || '').toLowerCase();
      if (!name.includes(needle)) continue;
      await api.updateTransaction(t.id, { category: rule.categoryId });
      applied++;
    }
  }
  return applied;
}

async function saveRule({ match, categoryId, categoryName } = {}) {
  const m = (match || '').trim();
  if (!m || !categoryId) throw new Error('match and categoryId required');
  const store = getRules();
  const id = 'r' + Date.now().toString(36);
  const rule = { id, match: m, categoryId, categoryName: categoryName || '', created: todayYMD() };
  // Replace any existing rule with the same match text (case-insensitive).
  store.rules = store.rules.filter((r) => (r.match || '').toLowerCase() !== m.toLowerCase());
  store.rules.push(rule);
  writeJsonSafe(RULES_PATH, store);
  const applied = await withApi((api) => applyRuleToTxns(api, rule));
  await syncNow().catch(() => {});
  return { ok: true, id, applied };
}

function deleteRule({ id } = {}) {
  if (!id) throw new Error('id required');
  const store = getRules();
  const before = store.rules.length;
  store.rules = store.rules.filter((r) => r.id !== id);
  writeJsonSafe(RULES_PATH, store);
  return { ok: true, removed: before - store.rules.length };
}

// Move peer settle-ups (Splitwise/Venmo/Zelle) that imported into an Income
// category over to Reimbursement, so a friend paying you back never counts as
// real income. Only ever touches income-filed inflows whose payee/notes match a
// settle-up service — manual categorizations elsewhere are left alone.
async function refileSettleUps() {
  return withApi(async (api) => {
    const groups = await api.getCategoryGroups();
    const catInfo = buildCatInfo(groups);
    let reimbId = null;
    for (const g of groups) for (const c of g.categories || []) if (REIMB_CAT.test(c.name || '')) reimbId = c.id;
    if (!reimbId) return { ok: false, moved: 0, reason: 'no Reimbursement category' };
    const payees = await api.getPayees();
    const pn = {};
    for (const p of payees) pn[p.id] = p.name || '';
    const accts = (await api.getAccounts()).filter((a) => !a.offbudget && !a.closed);
    let moved = 0;
    for (const a of accts) {
      const tx = await api.getTransactions(a.id, '2000-01-01', todayYMD());
      for (const t of tx) {
        if (t.is_parent || t.parent_id) continue;
        if (!(t.amount > 0)) continue; // paybacks are inflows
        const meta = t.category ? catInfo[t.category] : null;
        if (!meta || meta.kind !== 'income') continue; // only rescue misfiled income
        const hay = `${pn[t.payee] || t.imported_payee || ''} ${t.notes || ''}`;
        if (!SETTLE_UP_PAYEE.test(hay)) continue;
        await api.updateTransaction(t.id, { category: reimbId });
        moved++;
      }
    }
    if (moved) await syncNow().catch(() => {});
    return { ok: true, moved };
  });
}

// ---------------------------------------------------------------------------
// Splitwise share-as-spending. For an expense a friend PAID that I owe a share
// of, no charge ever hits my card — so my real consumption goes uncounted. We
// mirror each such share into Actual as a synthetic expense on a dedicated
// "Splitwise" account, tagged #sw-<expenseId> so re-runs update/prune instead of
// duplicating. A later settle-up I make is money movement (Reimbursement), not a
// second spend — my share is "spent" the moment I consume it. The account is
// on-budget (so the share counts as spend + is drill-downable) but excluded from
// net worth in getTrends, since it's a spend-attribution ledger, not real cash.
// ---------------------------------------------------------------------------
const SW_ACCOUNT_NAME = process.env.SPLITWISE_ACCOUNT_NAME || 'Splitwise';
const SW_CATEGORY_NAME = process.env.SPLITWISE_CATEGORY_NAME || 'Splitwise';
const SW_CAT_KEYWORDS = [
  [/rent|mortgage|lease/i, 'rent'],
  [/util|electric|water|sewage|trash|internet|wifi|phone/i, 'util'],
  [/grocer/i, 'grocer'],
  [/dining|restaurant|dinner|lunch|breakfast|liquor|bar\b/i, 'dining'],
  [/gas\/fuel|fuel|petrol/i, 'gas'],
  [/car|uber|lyft|taxi|transport|parking|toll|bus|train|flight|airfare/i, 'transport'],
  [/hotel|airbnb|lodging|hostel/i, 'travel'],
  [/movie|game|entertain|concert|ticket/i, 'entertain'],
  [/shop|amazon|electronic|target|clothing/i, 'shop'],
];
async function ensureSplitwiseAccount(api) {
  const accts = await api.getAccounts();
  const found = accts.find((a) => (a.name || '').toLowerCase() === SW_ACCOUNT_NAME.toLowerCase());
  if (found) return found.id;
  return api.createAccount({ name: SW_ACCOUNT_NAME, offbudget: false }, 0);
}
async function ensureSplitwiseCategory(api, groups) {
  for (const g of groups) for (const c of g.categories || []) if ((c.name || '').toLowerCase() === SW_CATEGORY_NAME.toLowerCase()) return c.id;
  const spendGroup = groups.find((g) => !g.is_income && !MONEY_MOVEMENT_GROUP.test(g.name || '') && !INCOME_GROUP.test(g.name || '') && (g.categories || []).length);
  if (!spendGroup) return null;
  return api.createCategory({ name: SW_CATEGORY_NAME, group_id: spendGroup.id });
}
function pickSplitwiseCategory(swCatName, spendCats) {
  const n = (swCatName || '').toLowerCase();
  for (const [rx, kw] of SW_CAT_KEYWORDS) {
    if (rx.test(n)) { const hit = spendCats.find((c) => c.name.toLowerCase().includes(kw)); if (hit) return hit.id; }
  }
  return null;
}
async function syncSplitwiseShareExpenses() {
  return withApi(async (api) => {
    const truth = readJsonSafe(OWES_TRUTH_PATH, null);
    const items = truth && Array.isArray(truth.othersPaidItems) ? truth.othersPaidItems : [];
    const acctId = await ensureSplitwiseAccount(api);
    let groups = await api.getCategoryGroups();
    const fallbackCat = await ensureSplitwiseCategory(api, groups);
    if (fallbackCat) groups = await api.getCategoryGroups(); // refresh if we just made it
    const catInfo = buildCatInfo(groups);
    const spendCats = [];
    for (const g of groups) for (const c of g.categories || []) if (catInfo[c.id] && catInfo[c.id].kind === 'spend') spendCats.push({ id: c.id, name: c.name });

    const existing = await api.getTransactions(acctId, '2000-01-01', todayYMD());
    const byTag = {};
    for (const t of existing) { const m = /#sw-(\d+)/.exec(t.notes || ''); if (m) byTag[m[1]] = t; }

    const wanted = new Set();
    let created = 0, updated = 0, pruned = 0;
    for (const it of items) {
      const id = String(it.id);
      const amtCents = -Math.round(Number(it.myShare) * 100);
      if (!(amtCents < 0)) continue;
      wanted.add(id);
      const catId = pickSplitwiseCategory(it.category, spendCats) || fallbackCat || undefined;
      const notes = `${it.desc || 'Splitwise expense'}${it.payer ? ` (paid by ${it.payer})` : ''} #sw-${id}`;
      const ex = byTag[id];
      if (!ex) {
        await api.addTransactions(acctId, [{ date: (it.date || todayYMD()).slice(0, 10), amount: amtCents, category: catId, notes, cleared: true }], { learnCategories: false, runTransfers: false });
        created++;
      } else if (ex.amount !== amtCents || (catId && ex.category !== catId)) {
        await api.updateTransaction(ex.id, { amount: amtCents, category: catId || ex.category || null });
        updated++;
      }
    }
    for (const [id, t] of Object.entries(byTag)) if (!wanted.has(id)) { await api.deleteTransaction(t.id); pruned++; }
    if (created || updated || pruned) await syncNow().catch(() => {});
    return { ok: true, account: SW_ACCOUNT_NAME, items: items.length, created, updated, pruned };
  });
}

// Built-in merchant catalog — the "Rocket Money auto-categorize". Each entry maps
// a payee keyword to a category TYPE; the type is resolved to whichever of YOUR
// Actual categories matches by name, so it adapts to your setup. Applied only to
// still-uncategorized txns AFTER your own rules (which always win).
const MERCHANT_CATALOG = [
  { label: 'Restaurants, coffee & food delivery', rx: /tandoori|pizza|restaurant|grill|kitchen|cafe|coffee|starbucks|dunkin|chipotle|burger|taco|sushi|thai|ramen|bbq|diner|bakery|doordash|uber\s?eats|grubhub|postmates|panera|subway|wendy|\bkfc\b|popeye|deli|bistro|noodle|curry|biryani|domino/i, type: 'dining' },
  { label: 'Gas stations', rx: /\bshell\b|chevron|exxon|\barco\b|mobil|valero|circle k|marathon|speedway|gas station|\bfuel\b/i, type: 'gas' },
  { label: 'Rideshare & transit', rx: /\buber\b|lyft|\btaxi\b|\bcab\b|\bmetro\b|transit|caltrain|\bbart\b|amtrak|parking|\btoll/i, type: 'transport' },
  { label: 'Groceries', rx: /whole foods|trader joe|safeway|kroger|\baldi\b|grocer|sprouts|publix|wegmans|ralphs/i, type: 'groceries' },
  { label: 'Shopping & retail', rx: /amazon|\btarget\b|walmart|best buy|\bebay\b|etsy|ikea|macy|nordstrom|uniqlo/i, type: 'shopping' },
  { label: 'Streaming & subscriptions', rx: /netflix|hulu|disney|spotify|\bhbo\b|youtube\s?premium|prime video|apple music|patreon|icloud|dropbox/i, type: 'subscriptions' },
  { label: 'Movies, games & events', rx: /\bsteam\b|playstation|\bxbox\b|nintendo|\bamc\b|cinema|movie|regal|concert|ticketmaster|stubhub/i, type: 'entertainment' },
  { label: 'Utilities & internet', rx: /comcast|xfinity|at&t|verizon|t-mobile|pg&e|\bdte\b|sewage|electric|\butility\b|internet|\bwifi\b/i, type: 'utilities' },
  { label: 'Health, pharmacy & fitness', rx: /\bcvs\b|walgreens|pharmacy|hospital|clinic|dental|\bdoctor\b|medical|\bgym\b|fitness|equinox/i, type: 'health' },
  { label: 'Travel & hotels', rx: /airbnb|hotel|marriott|hilton|hyatt|expedia|booking\.com|airlines|delta air|united air|southwest air|airfare|\bflight\b/i, type: 'travel' },
  { label: 'Interest, dividends & payroll', rx: /interest|dividend|payroll|direct dep|tax refund/i, type: 'income' },
];
const CATALOG_TYPE_MATCH = {
  dining: /dining|restaurant|food|eat/i,
  gas: /\bgas\b|fuel/i,
  transport: /rideshare|transit|transport|commute|\bcar\b/i,
  groceries: /grocer/i,
  shopping: /shop|amazon|merchandise|retail/i,
  subscriptions: /subscri|streaming/i,
  entertainment: /entertain|movie|game|fun|recreation/i,
  utilities: /util|\bbills?\b/i,
  health: /health|medical|pharma|fitness|wellness/i,
  travel: /travel|trip|vacation|flight|hotel|lodging/i,
  income: /income|interest|paycheck|salary/i,
};
function resolveCatalogCategory(type, groups, catInfo) {
  const rx = CATALOG_TYPE_MATCH[type];
  if (!rx) return null;
  for (const g of groups) {
    const incomeGroup = g.is_income === true || INCOME_GROUP.test(g.name || '');
    for (const c of g.categories || []) {
      if (type === 'income') { if (incomeGroup && rx.test(c.name || '')) return c.id; }
      else { const info = catInfo[c.id]; if (info && info.kind === 'spend' && rx.test(c.name || '')) return c.id; }
    }
  }
  if (type === 'income') for (const g of groups) if (g.is_income === true || INCOME_GROUP.test(g.name || '')) for (const c of g.categories || []) return c.id;
  return null;
}
async function applyBuiltinCatalog(api, { months = 24 } = {}) {
  const today = todayYMD();
  const start = addDays(today, -Math.round(30.44 * months));
  const groups = await api.getCategoryGroups();
  const catInfo = buildCatInfo(groups);
  const typeCat = {};
  for (const type of Object.keys(CATALOG_TYPE_MATCH)) typeCat[type] = resolveCatalogCategory(type, groups, catInfo);
  const accounts = (await api.getAccounts()).filter((a) => !a.closed);
  const payees = await api.getPayees();
  const pn = {};
  for (const p of payees) pn[p.id] = p.name || '';
  let applied = 0;
  for (const a of accounts) {
    const txns = await api.getTransactions(a.id, start, today);
    for (const t of txns) {
      if (t.is_parent || t.parent_id || t.category || t.transfer_id) continue;
      const hay = `${pn[t.payee] || t.imported_payee || ''} ${t.notes || ''}`;
      for (const entry of MERCHANT_CATALOG) {
        if (!entry.rx.test(hay)) continue;
        if (entry.type === 'income' ? !(t.amount > 0) : !(t.amount < 0)) continue; // sign guard
        const cat = typeCat[entry.type];
        if (!cat) break;
        await api.updateTransaction(t.id, { category: cat });
        applied++;
        break;
      }
    }
  }
  return applied;
}
// Read-only view of the catalog for the Rules screen (regex hidden).
function getCatalogDisplay() {
  return MERCHANT_CATALOG.map((c) => ({ label: c.label, type: c.type }));
}

// Re-apply every rule (used on refresh + manual "apply now"). Best-effort.
async function applyRules() {
  const { rules } = getRules();
  let total = 0;
  await withApi(async (api) => {
    for (const r of rules) {
      try { total += await applyRuleToTxns(api, r); } catch (_) { /* keep going */ }
    }
    // Built-in catalog fills anything your rules didn't (yours already won above).
    try { total += await applyBuiltinCatalog(api); } catch (_) { /* best-effort */ }
  });
  // Rescue misfiled peer settle-ups on every refresh so income never inflates.
  try { await refileSettleUps(); } catch (_) { /* best-effort */ }
  if (total) await syncNow().catch(() => {});
  return { ok: true, applied: total };
}

// Force a payee to be treated as recurring even if detection didn't catch it
// (derives the same normalized key the engine uses).
function markRecurring({ payee, isBill } = {}) {
  const key = recurringKey(payee || '');
  if (!key) throw new Error('a valid payee is required');
  return setRecurringOverride({ key, forced: true, isBill });
}

// ---------------------------------------------------------------------------
// Write: safe split-aware notes change (mirrors setTransactionCategory)
// ---------------------------------------------------------------------------
async function setTransactionNotes({ id, notes, isLeg, parentId, accountId, date }) {
  return withApi(async (api) => {
    if (!isLeg) {
      await api.updateTransaction(id, { notes: notes || null });
      return { ok: true, mode: 'update' };
    }
    if (!parentId || !accountId || !date) throw new Error('parentId, accountId and date required for split legs');
    const txns = await api.getTransactions(accountId, date, date);
    const parent = txns.find((t) => t.id === parentId);
    if (!parent || !Array.isArray(parent.subtransactions)) throw new Error('parent split not found');
    const subs = parent.subtransactions.map((s) => ({
      amount: s.amount,
      category: s.category || null,
      notes: s.id === id ? (notes || undefined) : (s.notes || undefined),
    }));
    const rebuilt = {
      date: parent.date,
      amount: parent.amount,
      payee: parent.payee || undefined,
      notes: parent.notes || undefined,
      cleared: parent.cleared,
      imported_id: parent.imported_id || undefined,
      subtransactions: subs,
    };
    await api.deleteTransaction(parentId);
    await api.addTransactions(accountId, [rebuilt], { learnCategories: false, runTransfers: false });
    return { ok: true, mode: 'rebuild-split' };
  });
}

// Move a transaction to a different date. Handy for refunds that post the month
// after the purchase — dating the refund back to the purchase month makes it net
// that month's spending instead of the current one. Split legs inherit their
// parent's date, so only the parent (or a simple txn) can be moved.
async function setTransactionDate({ id, date, isLeg }) {
  if (isLeg) throw new Error('A split leg inherits its parent’s date — move the parent instead.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('date must be YYYY-MM-DD');
  return withApi(async (api) => {
    await api.updateTransaction(id, { date });
    return { ok: true, date };
  });
}

// ---------------------------------------------------------------------------
// Savings goals — sidecar JSON; progress tracks a linked account balance
// ---------------------------------------------------------------------------
async function getGoals() {
  return withApi(async (api) => {
    const goals = readJsonSafe(GOALS_PATH, []);
    const accounts = (await api.getAccounts()).filter((a) => !a.closed);
    const bals = await Promise.all(accounts.map((a) => api.getAccountBalance(a.id)));
    const balById = {};
    accounts.forEach((a, i) => { balById[a.id] = bals[i] / 100; });
    return goals.map((g) => {
      const current = g.accountId && balById[g.accountId] != null ? balById[g.accountId] : (g.current || 0);
      return {
        ...g,
        current: round2(current),
        pct: g.target > 0 ? Math.min(999, Math.round((current / g.target) * 100)) : null,
      };
    });
  });
}

function saveGoal(goal = {}) {
  if (!goal.name || !(goal.target > 0)) throw new Error('name and positive target required');
  const goals = readJsonSafe(GOALS_PATH, []);
  if (goal.id) {
    const i = goals.findIndex((g) => g.id === goal.id);
    if (i >= 0) goals[i] = { ...goals[i], ...goal };
    else goals.push(goal);
  } else {
    goal.id = 'g' + Date.now().toString(36);
    goals.push(goal);
  }
  writeJsonSafe(GOALS_PATH, goals);
  return { ok: true, id: goal.id };
}

function deleteGoal(id) {
  if (!id) throw new Error('id required');
  const goals = readJsonSafe(GOALS_PATH, []).filter((g) => g.id !== id);
  writeJsonSafe(GOALS_PATH, goals);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// All-time transaction search (defaults to a 3-year window) + CSV report data
// ---------------------------------------------------------------------------
async function searchTransactions({ q, start, end, limit = 200 } = {}) {
  const today = todayYMD();
  const startDate = start || addDays(today, -365 * 3);
  const endDate = end || today;
  const all = await getTransactions({ start: startDate, end: endDate });
  const needle = (q || '').toLowerCase().trim();
  const res = needle
    ? all.filter((t) =>
        (t.payee || '').toLowerCase().includes(needle) ||
        (t.category || '').toLowerCase().includes(needle) ||
        (t.account || '').toLowerCase().includes(needle) ||
        (t.notes || '').toLowerCase().includes(needle))
    : all;
  return {
    transactions: res.slice(0, limit),
    total: res.length,
    truncated: res.length > limit,
    range: { start: startDate, end: endDate },
  };
}

// Distinct #hashtags across recent transactions, for tag autocomplete + management.
// Tags live inline in transaction notes (e.g. "#ev-trip #alex"); this aggregates
// them with usage counts so the app can offer reuse instead of duplicates.
async function getTags({ start, end } = {}) {
  const today = todayYMD();
  const startDate = start || addDays(today, -365 * 3);
  const endDate = end || today;
  const all = await getTransactions({ start: startDate, end: endDate });
  const counts = new Map(); // lowercased raw -> { raw, count }
  for (const t of all) {
    const notes = t.notes || '';
    const seen = new Set();
    for (const m of notes.matchAll(/#([A-Za-z0-9][\w-]*)/g)) {
      const raw = m[0];
      const key = raw.toLowerCase();
      if (seen.has(key)) continue; // count each tag at most once per transaction
      seen.add(key);
      const cur = counts.get(key) || { raw, count: 0 };
      cur.count += 1;
      counts.set(key, cur);
    }
  }
  const tags = [...counts.values()]
    .map(({ raw, count }) => {
      const token = raw.slice(1);
      const isEvent = /^ev-/i.test(token);
      return { raw, token, label: isEvent ? token.replace(/^ev-/i, '') : token, kind: isEvent ? 'event' : 'tag', count };
    })
    .sort((a, b) => b.count - a.count || a.token.localeCompare(b.token));
  return { tags };
}

async function getMonthlyReport({ month } = {}) {
  const m = month || todayYMD().slice(0, 7);
  const [Y, M] = m.split('-').map(Number);
  const start = `${m}-01`;
  const end = ymd(new Date(Y, M, 0)); // last day of month
  const [transactions, spending] = await Promise.all([
    getTransactions({ start, end }),
    getSpending({ month: m }),
  ]);
  return { month: m, start, end, transactions, summary: spending.current };
}

async function getReports({ month } = {}) {
  const m = month || todayYMD().slice(0, 7);
  const [monthly, trends, insights, tags] = await Promise.all([
    getMonthlyReport({ month: m }),
    getTrends({ months: 12 }),
    getInsights({ month: m }),
    getTags(),
  ]);
  const merchants = {};
  for (const t of monthly.transactions || []) {
    if (t.amount >= 0) continue;
    const key = t.payee || 'Unknown';
    const cur = merchants[key] || { payee: key, spend: 0, count: 0 };
    cur.spend = round2(cur.spend + Math.abs(t.amount));
    cur.count++;
    merchants[key] = cur;
  }
  const topMerchants = Object.values(merchants).sort((a, b) => b.spend - a.spend).slice(0, 12);
  const categories = (monthly.summary?.categories || []).map((c) => ({
    name: c.name,
    spend: c.spend,
    pct: monthly.summary.totalSpend > 0 ? round2((c.spend / monthly.summary.totalSpend) * 100) : 0,
  }));
  return {
    generatedAt: new Date().toISOString(),
    month: m,
    saved: [
      { id: 'monthly-review', title: 'Monthly review', subtitle: 'Income, spend, top categories, and review tasks' },
      { id: 'merchant-trends', title: 'Merchant trends', subtitle: 'Top merchants for the selected month' },
      { id: 'tag-events', title: 'Tags and events', subtitle: 'Spend grouped by note tags and trips' },
    ],
    monthlyReview: {
      income: monthly.summary?.totalIncome || 0,
      spend: monthly.summary?.totalSpend || 0,
      net: monthly.summary?.net || 0,
      transactionCount: monthly.transactions.length,
      largest: insights.largest || [],
      uncategorized: insights.uncategorized || [],
    },
    categoryTrends: categories,
    merchantTrends: topMerchants,
    tagSummary: tags.tags || [],
    cashFlow: trends.months || [],
  };
}

module.exports = {
  api,
  config,
  initApi,
  withApi,
  syncNow,
  bankSync,
  resetApi,
  getAccounts,
  setAccountOverride,
  getManualAssets,
  getInvestments,
  saveManualAsset,
  deleteManualAsset,
  getTransactions,
  createTransaction,
  getSpending,
  getTrends,
  getBudgets,
  setBudgetAmount,
  getReimbursement,
  getOwesConfig,
  setOwesConfig,
  getReimbLinks,
  addReimbLink,
  deleteReimbLink,
  getReview,
  suggestRepayments,
  confirmRepayment,
  dismissRepayment,
  undismissRepayment,
  getInsights,
  getCategories,
  setTransactionCategory,
  splitTransaction,
  removeSplit,
  sweepReimbursementTags,
  cleanupPhantoms,
  getPhantomLog,
  addReceipt,
  getReceipts,
  getReceiptFile,
  deleteReceipt,
  getReimbursementLedger,
  getReconciliation,
  setReconcileItem,
  setReconcileMonth,
  setReconcileEnabled,
  getReconcilePending,
  getTransactionById,
  getMerchantHistory,
  deleteTransaction,
  setPayee,
  getRules,
  getCatalogDisplay,
  getEvents,
  saveEvent,
  deleteEvent,
  reconcileSplits,
  saveRule,
  deleteRule,
  applyRules,
  refileSettleUps,
  syncSplitwiseShareExpenses,
  getRecurring,
  setRecurringOverride,
  markRecurring,
  getIncome,
  getBills,
  getForecast,
  setBillPaid,
  searchTransactions,
  getTags,
  getMonthlyReport,
  getReports,
  setTransactionNotes,
  setTransactionDate,
  getGoals,
  saveGoal,
  deleteGoal,
};
