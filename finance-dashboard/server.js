const express = require('express');
const NodeCache = require('node-cache');
const path = require('path');
const session = require('express-session');
const fs = require('fs');
const crypto = require('crypto');

const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const app = express();
const cache = new NodeCache({ stdTTL: 300 }); // 5 min cache

// Defense-in-depth: the Actual API occasionally rejects a batch write out-of-band
// (a promise that escapes the awaited call). Without a handler Node promotes that to
// an uncaught exception and the whole finance service dies. Log and keep serving;
// the resilient budget loader + systemd still handle genuinely fatal states.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', (err && err.stack) || err);
});

const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || `http://localhost:${process.env.PORT || 5007}`;
const RP_NAME = process.env.WEBAUTHN_RP_NAME || 'DarkFinances';
const RP_ID = process.env.WEBAUTHN_RP_ID || (() => {
  try { return new URL(PUBLIC_ORIGIN).hostname; }
  catch (_) { return 'localhost'; }
})();
const ORIGIN = process.env.WEBAUTHN_ORIGIN || PUBLIC_ORIGIN;
const PASSKEY_USER_NAME = process.env.PASSKEY_USER_NAME || 'owner';
const PASSKEY_USER_DISPLAY_NAME = process.env.PASSKEY_USER_DISPLAY_NAME || PASSKEY_USER_NAME;
const CREDS_FILE = path.join(__dirname, 'passkey-credentials.json');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

function loadCreds() {
  if (!fs.existsSync(CREDS_FILE)) return [];
  return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
}
function saveCreds(creds) {
  fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2));
}

app.set('trust proxy', 1);
app.use(express.json({ limit: '25mb' })); // receipts upload raw image bytes as base64
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: 'auto', httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'none' },
}));

// SELFTEST (default OFF) bypasses passkey auth for local endpoint verification only.
const SELFTEST = process.env.SELFTEST === '1';

function requireAuth(req, res, next) {
  if (SELFTEST) return next();
  if (req.session && req.session.authenticated) return next();
  res.redirect('/login');
}

// Auth routes
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/auth/status', (req, res) => {
  const creds = loadCreds();
  res.json({ registered: creds.length > 0, authenticated: !!req.session.authenticated });
});

// Registration (disabled after initial setup)
app.post('/auth/register/start', (req, res) => res.status(403).json({ error: 'Registration closed' }));
app.post('/auth/register/finish', (req, res) => res.status(403).json({ error: 'Registration closed' }));
app.post('/auth/register/start_DISABLED', async (req, res) => {
  const creds = loadCreds();
  const userId = crypto.randomBytes(16);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userID: userId,
    userName: PASSKEY_USER_NAME,
    userDisplayName: PASSKEY_USER_DISPLAY_NAME,
    attestationType: 'none',
    excludeCredentials: creds.map(c => ({ id: Buffer.from(c.credentialID, 'base64url'), type: 'public-key' })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  req.session.regChallenge = options.challenge;
  res.json(options);
});

app.post('/auth/register/finish_DISABLED', async (req, res) => {
  try {
    const verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge: req.session.regChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });
    if (!verification.verified) return res.status(400).json({ error: 'Verification failed' });
    const { credential } = verification.registrationInfo;
    const creds = loadCreds();
    creds.push({
      credentialID: credential.id,
      credentialPublicKey: Buffer.from(credential.publicKey).toString('base64'),
      counter: credential.counter,
      transports: req.body.response?.transports || [],
    });
    saveCreds(creds);
    req.session.authenticated = true;
    delete req.session.regChallenge;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Authentication
app.post('/auth/login/start', async (req, res) => {
  const creds = loadCreds();
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: 'required',
    allowCredentials: creds.map(c => ({ id: c.credentialID, transports: c.transports })),
  });
  req.session.authChallenge = options.challenge;
  res.json(options);
});

app.post('/auth/login/finish', async (req, res) => {
  try {
    const creds = loadCreds();
    const credId = req.body.id;
    const cred = creds.find(c => c.credentialID === credId);
    if (!cred) return res.status(400).json({ error: 'Credential not found' });
    const verification = await verifyAuthenticationResponse({
      response: req.body,
      expectedChallenge: req.session.authChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: cred.credentialID,
        publicKey: Buffer.from(cred.credentialPublicKey, 'base64'),
        counter: cred.counter,
        transports: cred.transports,
      },
    });
    if (!verification.verified) return res.status(400).json({ error: 'Verification failed' });
    cred.counter = verification.authenticationInfo.newCounter;
    saveCreds(creds);
    req.session.authenticated = true;
    delete req.session.authChallenge;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// All Actual Budget reads/computations live in the shared data module so the web
// dashboard, the JSON API, and the native app all use one source of truth.
const data = require('./dataModule');

// Fully synthetic dataset used by "Demo Mode" (showcasing without exposing real
// finances). It never touches Actual; the middleware below short-circuits any
// request flagged demo (header X-Demo-Mode:1 or ?demo=1) before the resolvers run.
const demo = require('./demoData');
function isDemo(req) { return req.get('X-Demo-Mode') === '1' || req.query.demo === '1' || req.query.demo === 'true'; }
function demoMiddleware(v1mode) {
  return (req, res, next) => {
    if (!isDemo(req)) return next();
    if (!v1mode && req.path.startsWith('/api/v1')) return next(); // let the v1 router envelope it
    const send = (payload) => res.json(v1mode ? { data: payload } : payload);
    const p = req.path.replace(/^\/api\/v1\//, '').replace(/^\/api\//, '').replace(/^\//, '');
    if (req.method === 'POST' || req.method === 'DELETE') {
      if (p.startsWith('goals')) return send({ ok: true, id: 'demo-' + Date.now() });
      if (p.includes('/category') || p.includes('/notes')) return send({ ok: true, mode: 'demo' });
      if (p.includes('/override')) return send({ ok: true, key: req.params.key || 'demo' });
      return send({ ok: true });
    }
    if (p === 'report.csv') {
      const esc = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
      const lines = ['Monthly report (DEMO),sample', '', 'Date,Payee,Account,Category,Amount,Notes'];
      for (const t of demo.transactions()) lines.push([t.date, esc(t.payee), esc(t.account), esc(t.category || ''), t.amount, esc(t.notes || '')].join(','));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="finance-demo.csv"');
      return res.send(lines.join('\n'));
    }
    switch (p) {
      case 'ping': return send({ ok: true, ts: Date.now() });
      case 'accounts': return send(demo.accounts());
      case 'transactions': {
        let r = demo.transactions();
        const { category, start, end } = req.query;
        if (category) r = r.filter((t) => (t.category || '').toLowerCase() === String(category).toLowerCase());
        if (start) r = r.filter((t) => t.date >= start);
        if (end) r = r.filter((t) => t.date <= end);
        return send(r);
      }
      case 'spending': return send(demo.spending());
      case 'trends': return send(demo.trends(parseInt(req.query.months, 10) || 12));
      case 'budgets': return send(demo.budgets());
      case 'reimbursement': return send(demo.reimbursement());
      case 'review': return send({ generatedAt: new Date().toISOString(), month: new Date().toISOString().slice(0, 7), count: 0, counts: {}, tasks: [] });
      case 'insights': return send(demo.insights());
      case 'categories': return send(demo.categories());
      case 'recurring': return send(demo.recurring());
      case 'bills': return send(demo.bills());
      case 'forecast': return send({ generatedAt: new Date().toISOString(), range: { start: new Date().toISOString().slice(0, 10), end: new Date().toISOString().slice(0, 10), days: 30 }, startBalance: 0, endingBalance: 0, lowest: { date: new Date().toISOString().slice(0, 10), balance: 0 }, totals: { inflow: 0, outflow: 0 }, points: [], events: [], warnings: [] });
      case 'income': return send(demo.income());
      case 'search': {
        const needle = (req.query.q || '').toLowerCase().trim();
        const all = demo.transactions();
        const r = needle ? all.filter((t) =>
          (t.payee || '').toLowerCase().includes(needle) ||
          (t.category || '').toLowerCase().includes(needle) ||
          (t.account || '').toLowerCase().includes(needle) ||
          (t.notes || '').toLowerCase().includes(needle)) : all;
        return send({ transactions: r.slice(0, 200), total: r.length, truncated: r.length > 200 });
      }
      case 'tags': return send(demo.tags());
      case 'rules': return send({ rules: [] });
      case 'manual-assets': return send({ items: [], assets: 0, liabilities: 0, net: 0 });
      case 'investments': return send({ generatedAt: new Date().toISOString(), holdings: [], totals: { value: 0, costBasis: 0, gainLoss: 0 }, allocation: { byAssetClass: {}, byAccount: {} }, debts: [], debtTotals: { balance: 0, minPayment: 0, weightedApr: 0 } });
      case 'reports': return send({ generatedAt: new Date().toISOString(), month: new Date().toISOString().slice(0, 7), saved: [], monthlyReview: { income: 0, spend: 0, net: 0, transactionCount: 0, largest: [], uncategorized: [] }, categoryTrends: [], merchantTrends: [], tagSummary: [], cashFlow: [] });
      case 'goals': return send(demo.goals());
      case 'owes-config': return send({ expected: {}, debtorPatterns: {}, tripStart: {}, swNet: [], settledExt: [] });
      case 'reimb-links': return send(req.query.id ? { asInflow: [], asExpense: [] } : { links: [] });
      default: {
        if (DEMO_ONLY) return send({ ok: true, demo: true });
        return next();
      }
    }
  };
}

function cached(key, fn, ttl = 300) {
  const hit = cache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  return fn().then(d => { cache.set(key, d, ttl); return d; });
}

// Hot cache keys the app + dashboard hit on load. Keys MUST match the strings the
// resolvers compute for their default params so a warmed entry is actually reused.
// Keeping these warm means a sync/refresh (or process start) never forces the next
// request to recompute the heavy 18-month aggregations from scratch.
const WARM_TARGETS = [
  { key: 'accounts', ttl: 300, fn: () => data.getAccounts() },
  { key: 'spending-current', ttl: 180, fn: () => data.getSpending({ month: undefined }) },
  { key: 'trends-12', ttl: 600, fn: () => data.getTrends({ months: 12 }) },
  { key: 'trends-60', ttl: 600, fn: () => data.getTrends({ months: 60 }) },
  { key: 'recurring-18', ttl: 600, fn: () => data.getRecurring({ window: 18 }) },
  { key: 'income-12', ttl: 600, fn: () => data.getIncome({ window: 12 }) },
  { key: 'bills-45', ttl: 600, fn: () => data.getBills({ days: 45 }) },
  { key: 'reimb-d-d-false', ttl: 300, fn: () => data.getReimbursement({}) },
  { key: 'categories', ttl: 300, fn: () => data.getCategories() },
];
async function warmCache() {
  await Promise.allSettled(
    WARM_TARGETS.map(async ({ key, ttl, fn }) => {
      try {
        cache.set(key, await fn(), ttl);
      } catch (e) {
        console.error(`warmCache ${key} failed:`, e.message);
      }
    })
  );
}

// Session-only gate for the web app + static assets. /api/v1/* runs its own
// (session-OR-token) auth below so native clients can use a bearer token.
app.use((req, res, next) => {
  if (req.path.startsWith('/login') || req.path.startsWith('/auth/') || req.path.startsWith('/api/v1')) return next();
  requireAuth(req, res, next);
});

app.use(express.static(path.join(__dirname, 'public')));

// Demo mode for the legacy web API (runs after the passkey gate above).
app.use(demoMiddleware(false));

// ---- Endpoint resolvers (shared by legacy /api and versioned /api/v1) -------
const monthOf = (req) => req.query.month;
const resolvers = {
  accounts: () => cached('accounts', () => data.getAccounts()),
  transactions: (req) => {
    const { accountId, start, end, category } = req.query;
    const collapse = req.query.collapse === '1' || req.query.collapse === 'true';
    const startDate = start || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const endDate = end || new Date().toISOString().slice(0, 10);
    const key = `txns-${accountId || 'all'}-${startDate}-${endDate}-${category || 'all'}-${collapse ? 'c' : 'x'}`;
    return cached(key, () => data.getTransactions({ accountId, start: startDate, end: endDate, category, collapse }), 120);
  },
  txnById: (req) => {
    const { id } = req.params;
    const { accountId, date } = req.query;
    return data.getTransactionById({ id, accountId, date });
  },
  merchantHistory: (req) => {
    const { payee, months } = req.query;
    return cached(`mhist-${(payee || '').toLowerCase()}-${months || 12}`, () => data.getMerchantHistory({ payee, months: months ? Number(months) : 12 }), 180);
  },
  spending: (req) => cached(`spending-${monthOf(req) || 'current'}`, () => data.getSpending({ month: monthOf(req) }), 180),
  trends: (req) => {
    const months = Math.min(60, Math.max(3, parseInt(req.query.months, 10) || 12));
    return cached(`trends-${months}`, () => data.getTrends({ months }), 600);
  },
  budgets: (req) => cached(`budgets-${monthOf(req) || 'current'}`, () => data.getBudgets({ month: monthOf(req) }), 300),
  reimbursement: (req) => {
    const { from, to } = req.query;
    const openOnly = req.query.openOnly === '1' || req.query.openOnly === 'true';
    return cached(`reimb-${from || 'd'}-${to || 'd'}-${openOnly}`, () => data.getReimbursement({ from, to, openOnly }), 300);
  },
  review: (req) => cached(`review-${monthOf(req) || 'current'}`, () => data.getReview({ month: monthOf(req) }), 120),
  reimbursementLedger: (req) => cached(`reimb-ledger-${monthOf(req) || 'current'}`, () => data.getReimbursementLedger({ month: monthOf(req) }), 180),
  repaymentSuggestions: (req) => {
    const { from, to } = req.query;
    return cached(`reimb-suggest-${from || 'd'}-${to || 'd'}`, () => data.suggestRepayments({ from, to }), 120);
  },
  insights: (req) => cached(`insights-${monthOf(req) || 'current'}`, () => data.getInsights({ month: monthOf(req) }), 300),
  categories: () => cached('categories', () => data.getCategories()),
  recurring: (req) => {
    const window = Math.min(36, Math.max(6, parseInt(req.query.window, 10) || 18));
    if (req.query.debug === '1') return data.getRecurring({ window, debug: true, minDates: Math.max(1, parseInt(req.query.minDates, 10) || 3) });
    return cached(`recurring-${window}`, () => data.getRecurring({ window }), 600);
  },
  bills: (req) => {
    const days = Math.min(120, Math.max(7, parseInt(req.query.days, 10) || 45));
    return cached(`bills-${days}`, () => data.getBills({ days }), 600);
  },
  forecast: (req) => {
    const days = Math.min(180, Math.max(30, parseInt(req.query.days, 10) || 90));
    return cached(`forecast-${days}`, () => data.getForecast({ days }), 300);
  },
  income: (req) => {
    const window = Math.min(24, Math.max(6, parseInt(req.query.window, 10) || 12));
    return cached(`income-${window}`, () => data.getIncome({ window }), 600);
  },
  search: (req) => {
    const q = (req.query.q || '').toString();
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const { start, end } = req.query;
    return cached(`search-${q}-${start || ''}-${end || ''}-${limit}`, () => data.searchTransactions({ q, start, end, limit }), 120);
  },
  goals: () => cached('goals', () => data.getGoals(), 120),
  tags: () => cached('tags', () => data.getTags(), 120),
  rules: () => cached('rules', () => Promise.resolve({ ...data.getRules(), catalog: data.getCatalogDisplay() }), 120),
  manualAssets: () => cached('manual-assets', () => Promise.resolve(data.getManualAssets()), 120),
  investments: () => cached('investments', () => Promise.resolve(data.getInvestments()), 120),
  reports: (req) => cached(`reports-${monthOf(req) || 'current'}`, () => data.getReports({ month: monthOf(req) }), 300),
};

async function setRecurring(req) {
  const { key } = req.params;
  const { status, hidden, forced, isBill, cancellation } = req.body || {};
  const result = data.setRecurringOverride({ key, status, hidden, forced, isBill, cancellation });
  cache.flushAll();
  return result;
}
async function markRecurring(req) {
  const { payee, isBill } = req.body || {};
  const result = data.markRecurring({ payee, isBill });
  cache.flushAll();
  return result;
}
async function splitTxn(req) {
  const { id } = req.params;
  const { accountId, date, legs } = req.body || {};
  const result = await data.splitTransaction({ id, accountId, date, legs });
  await data.syncNow().catch(() => {});
  cache.flushAll();
  return result;
}
async function unsplitTxn(req) {
  const { id } = req.params;
  const { accountId, date, categoryId } = req.body || {};
  const result = await data.removeSplit({ id, accountId, date, categoryId });
  await data.syncNow().catch(() => {});
  cache.flushAll();
  return result;
}
async function setPayeeH(req) {
  const { id } = req.params;
  const { payee, isLeg, parentId, accountId, date } = req.body || {};
  const result = await data.setPayee({ id, payee, isLeg, parentId, accountId, date });
  await data.syncNow().catch(() => {});
  cache.flushAll();
  return result;
}
async function bankSyncH() {
  const result = await data.bankSync();
  await data.applyRules().catch(() => {}); // categorize anything newly pulled
  await data.sweepReimbursementTags().catch(() => {}); // file configured reimbursement tags into Reimbursement
  const phantom = await data.cleanupPhantoms().catch((e) => ({ error: e.message }));
  await data.syncNow().catch(() => {}); // persist any phantom deletes to the Actual server
  cache.flushAll();
  return { ...result, phantom };
}
async function phantomCleanupH(req) {
  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
  const num = (name) => req.query[name] != null ? Number(req.query[name]) : undefined;
  const r = await data.cleanupPhantoms({
    dryRun,
    window: num('window'),
    agedDays: num('agedDays'),
    observeDays: num('observeDays'),
    holdAgedDays: num('holdAgedDays'),
    holdObserveDays: num('holdObserveDays'),
  });
  if (!dryRun) { await data.syncNow().catch(() => {}); cache.flushAll(); }
  return r;
}
const phantomLogH = (req) => Promise.resolve(data.getPhantomLog({ limit: Number(req.query.limit) || 100 }));
// Receipts
async function addReceiptH(req) { return data.addReceipt(req.body || {}); }
const receiptsH = (req) => Promise.resolve(data.getReceipts({ txnId: req.query.txnId }));
async function deleteReceiptH(req) { return data.deleteReceipt({ id: req.params.id }); }
// Raw image stream (auth already enforced by the router). expo-image sends the
// token via headers, so this just serves the file bytes with the right type.
function receiptImageH(req, res) {
  try {
    const f = data.getReceiptFile({ id: req.params.id });
    if (!f) return res.status(404).json({ error: 'not found' });
    res.type(f.mime || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.sendFile(f.path);
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
async function sweepReimbH(req) {
  const { tags, from, to } = (req && req.body) || {};
  const result = await data.sweepReimbursementTags({ tags, from, to });
  await data.syncNow().catch(() => {});
  cache.flushAll();
  return result;
}
async function deleteTxn(req) {
  const { id } = req.params;
  const { accountId, date } = req.query;
  const result = await data.deleteTransaction({ id, accountId, date });
  await data.syncNow().catch(() => {}); // persist the delete back to the Actual server
  cache.flushAll(); // removing a transaction shifts balances/spending/insights
  return result;
}
async function saveRuleH(req) {
  const result = await data.saveRule(req.body || {});
  cache.flushAll();
  return result;
}
async function deleteRuleH(req) {
  const result = data.deleteRule({ id: req.params.id });
  cache.flushAll();
  return result;
}
async function applyRulesH() {
  const result = await data.applyRules();
  cache.flushAll();
  return result;
}
async function syncSharesH() {
  const result = await data.syncSplitwiseShareExpenses();
  cache.flushAll();
  return result;
}
async function eventsH() {
  return cached('events', () => data.getEvents(), 60);
}
async function saveEventH(req) {
  const result = data.saveEvent(req.body || {});
  cache.del('events');
  return result;
}
async function deleteEventH(req) {
  const result = data.deleteEvent({ slug: req.params.slug });
  cache.del('events');
  return result;
}
async function setAccountOverrideH(req) {
  const { id } = req.params;
  const { name, hidden } = req.body || {};
  const result = data.setAccountOverride({ id, name, hidden });
  cache.del('accounts');
  return result;
}
async function saveManualAssetH(req) {
  const result = data.saveManualAsset(req.body || {});
  cache.del('manual-assets');
  return result;
}
async function deleteManualAssetH(req) {
  const result = data.deleteManualAsset({ id: req.params.id });
  cache.del('manual-assets');
  return result;
}
async function setNotes(req) {
  const { id } = req.params;
  const { notes, isLeg, parentId, accountId, date } = req.body || {};
  const result = await data.setTransactionNotes({ id, notes, isLeg, parentId, accountId, date });
  await data.syncNow().catch(() => {});
  cache.flushAll();
  return result;
}
async function setDateH(req) {
  const { id } = req.params;
  const { date, isLeg } = req.body || {};
  const result = await data.setTransactionDate({ id, date, isLeg });
  await data.syncNow().catch(() => {});
  cache.flushAll();
  return result;
}
async function saveGoal(req) {
  const result = data.saveGoal(req.body || {});
  cache.del('goals');
  return result;
}
async function deleteGoal(req) {
  const result = data.deleteGoal(req.params.id);
  cache.del('goals');
  return result;
}

async function setCategory(req) {
  const { id } = req.params;
  const { categoryId, isLeg, parentId, accountId, date } = req.body || {};
  const result = await data.setTransactionCategory({ id, categoryId, isLeg, parentId, accountId, date });
  await data.syncNow().catch(() => {}); // persist the write back to the Actual server
  cache.flushAll();
  return result;
}
// Manual refresh: pull the latest deltas from the Actual server, clear stale
// HTTP cache, then immediately re-warm the hot keys so the UI repopulates fast.
async function doRefresh() {
  await data.syncNow().catch((e) => console.error('refresh sync failed:', e.message));
  // A pending split that posted at a new amount: absorb the delta into its master leg.
  await data.reconcileSplits().catch((e) => console.error('split reconcile failed:', e.message));
  // Auto-categorize any newly-pulled transactions that match a saved rule.
  await data.applyRules().catch((e) => console.error('applyRules failed:', e.message));
  // Mirror my share of friend-paid Splitwise items into the spend ledger.
  await data.syncSplitwiseShareExpenses().catch((e) => console.error('splitwise share sync failed:', e.message));
  cache.flushAll();
  await warmCache();
  return { ok: true };
}

async function markBill(req) {
  const { id, key, dueDate, paid } = req.body || {};
  const result = data.setBillPaid({ id, key, dueDate, paid });
  cache.flushAll(); // bills are cached per horizon
  return result;
}

async function setOwes(req) {
  const result = data.setOwesConfig(req.body || {});
  cache.flushAll(); // reimbursement aggregations depend on this config
  return result;
}

async function createTxn(req) {
  const result = await data.createTransaction(req.body || {});
  cache.flushAll(); // a new transaction shifts balances/spending/insights
  return result;
}

async function setBudget(req) {
  const { month, categoryId, amount } = req.body || {};
  const result = await data.setBudgetAmount({ month, categoryId, amount });
  await data.syncNow().catch(() => {}); // persist the write back to the Actual server
  cache.flushAll(); // budget targets feed budgets + insights
  return result;
}

const reimbLinks = (req) => Promise.resolve(data.getReimbLinks({ id: req.query.id }));
async function addLink(req) {
  const r = data.addReimbLink(req.body || {});
  cache.flushAll(); // suggestions net against links
  return r;
}
async function confirmRepaymentH(req) {
  const r = await data.confirmRepayment({ id: req.params.id, from: req.query.from, to: req.query.to });
  await data.syncNow().catch(() => {}); // persist the inflow's new category to the Actual server
  cache.flushAll();
  return r;
}
async function dismissRepaymentH(req) {
  const r = data.dismissRepayment({ id: req.params.id, inflowId: req.body && req.body.inflowId });
  cache.flushAll();
  return r;
}
async function delLink(req) {
  const inflowId = (req.body && req.body.inflowId) || req.query.inflowId;
  const expenseId = (req.body && req.body.expenseId) || req.query.expenseId;
  const r = data.deleteReimbLink({ inflowId, expenseId });
  cache.flushAll();
  return r;
}

// Reconciliation — read fresh (not cached) so checkboxes reflect instantly.
const reconciliationH = (req) => data.getReconciliation({ month: monthOf(req) });
const reconcilePendingH = () => data.getReconcilePending();
const setReconItemH = (req) => Promise.resolve(data.setReconcileItem(req.body || {}));
const setReconMonthH = (req) => Promise.resolve(data.setReconcileMonth(req.body || {}));
const setReconEnabledH = (req) => Promise.resolve(data.setReconcileEnabled(req.body || {}));

// Monthly CSV export (raw text/csv, used by web download + app share sheet).
function csvEscape(v) { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
async function reportCsv(req, res) {
  try {
    const rep = await data.getMonthlyReport({ month: req.query.month });
    const net = Math.round((rep.summary.totalIncome - rep.summary.totalSpend) * 100) / 100;
    const lines = [
      `Monthly report,${rep.month}`,
      `Total income,${rep.summary.totalIncome}`,
      `Total spend,${rep.summary.totalSpend}`,
      `Net,${net}`,
      '',
      'Date,Payee,Account,Category,Amount,Notes',
    ];
    for (const t of rep.transactions) {
      lines.push([t.date, csvEscape(t.payee), csvEscape(t.account), csvEscape(t.category || ''), t.amount, csvEscape(t.notes || '')].join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="finance-${rep.month}.csv"`);
    res.send(lines.join('\n'));
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// Raw responders for the legacy web API; enveloped {data}/{error} responders for v1.
const raw = (fn) => async (req, res) => { try { res.json(await fn(req)); } catch (e) { res.status(500).json({ error: e.message }); } };
const env = (fn) => async (req, res) => { try { res.json({ data: await fn(req) }); } catch (e) { res.status(500).json({ error: e.message }); } };

// ---- Legacy unversioned API (web dashboard, passkey session) ----------------
app.get('/api/accounts', raw(resolvers.accounts));
app.get('/api/transactions', raw(resolvers.transactions));
app.post('/api/transactions', raw(createTxn));
app.get('/api/spending', raw(resolvers.spending));
app.get('/api/trends', raw(resolvers.trends));
app.get('/api/budgets', raw(resolvers.budgets));
app.post('/api/budgets', raw(setBudget));
app.get('/api/reimbursement', raw(resolvers.reimbursement));
app.get('/api/reimbursement-ledger', raw(resolvers.reimbursementLedger));
app.get('/api/insights', raw(resolvers.insights));
app.get('/api/merchant-history', raw(resolvers.merchantHistory));
app.get('/api/categories', raw(resolvers.categories));
app.get('/api/recurring', raw(resolvers.recurring));
app.get('/api/bills', raw(resolvers.bills));
app.get('/api/income', raw(resolvers.income));
app.get('/api/search', raw(resolvers.search));
app.get('/api/tags', raw(resolvers.tags));
app.get('/api/report.csv', reportCsv);
app.get('/api/goals', raw(resolvers.goals));
app.get('/api/transactions/:id', raw(resolvers.txnById));
app.post('/api/transactions/:id/category', raw(setCategory));
app.post('/api/transactions/:id/notes', raw(setNotes));
app.post('/api/transactions/:id/date', raw(setDateH));
app.post('/api/transactions/:id/payee', raw(setPayeeH));
app.post('/api/transactions/:id/split', raw(splitTxn));
app.post('/api/transactions/:id/unsplit', raw(unsplitTxn));
app.delete('/api/transactions/:id', raw(deleteTxn));
app.post('/api/bank-sync', raw(bankSyncH));
app.post('/api/reimbursements/sweep', raw(sweepReimbH));
app.post('/api/phantom/cleanup', raw(phantomCleanupH));
app.get('/api/phantom/log', raw(phantomLogH));
app.post('/api/receipts', raw(addReceiptH));
app.get('/api/receipts', raw(receiptsH));
app.get('/api/receipts/:id/image', receiptImageH);
app.delete('/api/receipts/:id', raw(deleteReceiptH));
app.get('/api/rules', raw(resolvers.rules));
app.post('/api/rules', raw(saveRuleH));
app.post('/api/rules/apply', raw(applyRulesH));
app.delete('/api/rules/:id', raw(deleteRuleH));
app.post('/api/accounts/:id/override', raw(setAccountOverrideH));
app.get('/api/manual-assets', raw(resolvers.manualAssets));
app.post('/api/manual-assets', raw(saveManualAssetH));
app.delete('/api/manual-assets/:id', raw(deleteManualAssetH));
app.post('/api/recurring/:key/override', raw(setRecurring));
app.post('/api/recurring/mark', raw(markRecurring));
app.post('/api/bills/paid', raw(markBill));
app.get('/api/owes-config', raw(async () => data.getOwesConfig()));
app.post('/api/owes-config', raw(setOwes));
app.get('/api/reimb-links', raw(reimbLinks));
app.post('/api/reimb-links', raw(addLink));
app.delete('/api/reimb-links', raw(delLink));
app.get('/api/repayments/suggestions', raw(resolvers.repaymentSuggestions));
app.post('/api/repayments/:id/confirm', raw(confirmRepaymentH));
app.post('/api/repayments/:id/dismiss', raw(dismissRepaymentH));
app.get('/api/reconciliation', raw(reconciliationH));
app.get('/api/reconciliation/pending', raw(reconcilePendingH));
app.post('/api/reconciliation/item', raw(setReconItemH));
app.post('/api/reconciliation/month', raw(setReconMonthH));
app.post('/api/reconciliation/enabled', raw(setReconEnabledH));
app.post('/api/goals', raw(saveGoal));
app.delete('/api/goals/:id', raw(deleteGoal));
app.post('/api/refresh', raw(async () => doRefresh()));

// ---- Versioned API for native clients: session OR bearer token + CORS -------
const API_TOKEN = process.env.FINANCE_API_TOKEN || '';
function tokenOk(presented) {
  if (!API_TOKEN || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(API_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function v1Auth(req, res, next) {
  if (isDemo(req)) return next(); // public sample data only; demoMiddleware handles the response.
  if (req.session && req.session.authenticated) return next(); // browser (passkey)
  const headerTok = req.get('X-Finance-Token') || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (tokenOk(headerTok)) return next(); // native app (token)
  return res.status(401).json({ error: 'UNAUTHENTICATED' });
}

const v1 = express.Router();
v1.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.get('Origin') || '*');
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Finance-Token, X-Demo-Mode');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
v1.use(v1Auth);
v1.use(demoMiddleware(true)); // demo mode for native clients (after token/session auth)
v1.get('/ping', env(async () => ({ ok: true, ts: Date.now() })));
v1.get('/accounts', env(resolvers.accounts));
v1.get('/transactions', env(resolvers.transactions));
v1.post('/transactions', env(createTxn));
v1.get('/spending', env(resolvers.spending));
v1.get('/trends', env(resolvers.trends));
v1.get('/budgets', env(resolvers.budgets));
v1.post('/budgets', env(setBudget));
v1.get('/reimbursement', env(resolvers.reimbursement));
v1.get('/review', env(resolvers.review));
v1.get('/reimbursement-ledger', env(resolvers.reimbursementLedger));
v1.get('/insights', env(resolvers.insights));
v1.get('/merchant-history', env(resolvers.merchantHistory));
v1.get('/categories', env(resolvers.categories));
v1.get('/recurring', env(resolvers.recurring));
v1.get('/bills', env(resolvers.bills));
v1.get('/forecast', env(resolvers.forecast));
v1.get('/income', env(resolvers.income));
v1.get('/search', env(resolvers.search));
v1.get('/tags', env(resolvers.tags));
v1.get('/report.csv', reportCsv);
v1.get('/goals', env(resolvers.goals));
v1.get('/transactions/:id', env(resolvers.txnById));
v1.post('/transactions/:id/category', env(setCategory));
v1.post('/transactions/:id/notes', env(setNotes));
v1.post('/transactions/:id/date', env(setDateH));
v1.post('/transactions/:id/payee', env(setPayeeH));
v1.post('/transactions/:id/split', env(splitTxn));
v1.post('/transactions/:id/unsplit', env(unsplitTxn));
v1.delete('/transactions/:id', env(deleteTxn));
v1.post('/bank-sync', env(bankSyncH));
v1.post('/reimbursements/sweep', env(sweepReimbH));
v1.post('/phantom/cleanup', env(phantomCleanupH));
v1.get('/phantom/log', env(phantomLogH));
v1.post('/receipts', env(addReceiptH));
v1.get('/receipts', env(receiptsH));
v1.get('/receipts/:id/image', receiptImageH); // raw bytes (auth via router)
v1.delete('/receipts/:id', env(deleteReceiptH));
v1.get('/rules', env(resolvers.rules));
v1.post('/rules', env(saveRuleH));
v1.post('/rules/apply', env(applyRulesH));
v1.delete('/rules/:id', env(deleteRuleH));
v1.post('/splitwise/sync-shares', env(syncSharesH));
v1.get('/events', env(eventsH));
v1.post('/events', env(saveEventH));
v1.delete('/events/:slug', env(deleteEventH));
v1.post('/accounts/:id/override', env(setAccountOverrideH));
v1.get('/manual-assets', env(resolvers.manualAssets));
v1.get('/investments', env(resolvers.investments));
v1.get('/reports', env(resolvers.reports));
v1.post('/manual-assets', env(saveManualAssetH));
v1.delete('/manual-assets/:id', env(deleteManualAssetH));
v1.post('/recurring/:key/override', env(setRecurring));
v1.post('/recurring/mark', env(markRecurring));
v1.post('/bills/paid', env(markBill));
v1.get('/owes-config', env(async () => data.getOwesConfig()));
v1.post('/owes-config', env(setOwes));
v1.get('/reimb-links', env(reimbLinks));
v1.post('/reimb-links', env(addLink));
v1.delete('/reimb-links', env(delLink));
v1.get('/repayments/suggestions', env(resolvers.repaymentSuggestions));
v1.post('/repayments/:id/confirm', env(confirmRepaymentH));
v1.post('/repayments/:id/dismiss', env(dismissRepaymentH));
v1.get('/reconciliation', env(reconciliationH));
v1.get('/reconciliation/pending', env(reconcilePendingH));
v1.post('/reconciliation/item', env(setReconItemH));
v1.post('/reconciliation/month', env(setReconMonthH));
v1.post('/reconciliation/enabled', env(setReconEnabledH));
v1.post('/goals', env(saveGoal));
v1.delete('/goals/:id', env(deleteGoal));
v1.post('/refresh', env(async () => doRefresh()));
app.use('/api/v1', v1);

// ---- Freshness: keep the local Actual cache in sync with the server ---------
const SYNC_INTERVAL_MS = 10 * 60 * 1000; // every 10 min
async function periodicSync() {
  try {
    await data.syncNow();
    cache.flushAll();
    await warmCache(); // repopulate hot keys so the next request isn't a cold recompute
  } catch (e) {
    console.error('Periodic sync failed:', e.message);
  }
}

const PORT = parseInt(process.env.PORT, 10) || 5007;
const DEMO_ONLY = process.env.DEMO_ONLY === '1';
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Finance dashboard running on http://127.0.0.1:${PORT}`);
  if (DEMO_ONLY) {
    console.log('Demo-only mode enabled; skipping Actual startup sync');
    return;
  }
  data.initApi()
    .then(async () => {
      await warmCache(); // pre-warm once at startup so the first page loads are fast
      setInterval(periodicSync, SYNC_INTERVAL_MS);
    })
    .catch(e => console.error('Initial API load failed:', e.message));
});
