#!/usr/bin/env node
/*
 * finance-digest.js — DETERMINISTIC daily finance figures for the Telegram morning digest.
 *
 * READ-ONLY. Computes every number exactly so the LLM only FORMATS this output and never
 * does arithmetic. All amounts are integer cents internally; printed as dollars.
 *
 * Classification (mirrors CONTEXT.md):
 *   - income      : category groups with is_income (or named "Income")            -> excluded from spend
 *   - mm          : "Money Movement" group, or categories Transfers / Investments / Credit Card Payment,
 *                   plus account-to-account transfers                              -> excluded from spend
 *   - reimb       : the "Reimbursement" category (peer debts)                      -> excluded from spend
 *   - spend       : everything else (Dining, Groceries, Bills & Utilities, ...)   -> REAL spending
 *   - uncat       : no category and not a transfer                                 -> flagged, excluded from spend
 *
 * Env (via run.sh + .actual.env): ACTUAL_SERVER_URL, ACTUAL_PASSWORD, ACTUAL_SYNC_ID, FIX_DATA_DIR
 * Optional: DIGEST_DEBUG=1 prints the category classification audit.
 *
 * Output: clean, labeled, filter-safe lines with EXACT dollar amounts.
 */
const api = require('@actual-app/api');
const { addDays, FINANCE_TIME_ZONE, todayYMD } = require('./lib/date-only');
const {
  buildToolCategoryInfo,
  classifiedLeavesForAccounts,
  incompleteTransferLeaves,
} = require('./lib/transfer-classification');

const c2 = (cents) => (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (cents) => (cents < 0 ? '-$' : '$') + c2(cents);

const MM_CAT = /^(transfers?|investments?|credit\s*card\s*payments?|cc\s*payments?)$/i;
const REIMB_CAT = /^reimbursement$/i;

(async () => {
  await api.init({ dataDir: process.env.FIX_DATA_DIR, serverURL: process.env.ACTUAL_SERVER_URL, password: process.env.ACTUAL_PASSWORD });
  await api.downloadBudget(process.env.ACTUAL_SYNC_ID);

  const today = todayYMD();
  const yesterday = addDays(today, -1);
  const monthStart = today.slice(0, 8) + '01';

  const groups = await api.getCategoryGroups();
  const catInfo = buildToolCategoryInfo(groups);
  const nameOf = (id) => (id && catInfo[id] ? catInfo[id].name : '(uncategorized)');

  const payees = await api.getPayees();
  const pn = {}; for (const p of payees) pn[p.id] = p.name || '';
  const accounts = await api.getAccounts();

  const balances = [];
  const transactionsByAccountId = new Map();
  for (const a of accounts) {
    transactionsByAccountId.set(a.id, await api.getTransactions(a.id, '2000-01-01', today));
  }
  const payeeNameFor = (t) => pn[t.payee] || '';
  const allLeaves = classifiedLeavesForAccounts(accounts, transactionsByAccountId, catInfo, payeeNameFor);
  const yLeaves = allLeaves.filter((entry) => entry.date === yesterday);
  const mLeaves = allLeaves.filter((entry) => entry.date >= monthStart && entry.date <= today);
  for (const a of accounts) {
    const tx = transactionsByAccountId.get(a.id) || [];
    let bal = 0;
    for (const t of tx) bal += t.amount;
    balances.push({ name: a.name, offbudget: !!a.offbudget, bal });
  }

  const isReal = (e) => e.onbudget && (e.kind === 'spend' || (e.kind === 'uncat' && e.amount < 0));
  const catKey = (e) => (e.kind === 'uncat' ? 'Uncategorized' : (e.kind === 'transfer' ? 'Transfer' : (e.catId ? nameOf(e.catId) : '(uncategorized)')));

  const yShow = yLeaves.filter((e) => e.onbudget);
  const yReal = yLeaves.filter(isReal);
  const yRealCents = -yReal.reduce((s, e) => s + e.amount, 0);

  const mReal = mLeaves.filter(isReal);
  const mRealCents = -mReal.reduce((s, e) => s + e.amount, 0);
  const byCat = {};
  for (const e of mReal) byCat[catKey(e)] = (byCat[catKey(e)] || 0) + e.amount;
  const catRows = Object.entries(byCat).map(([name, cents]) => ({ name, spent: -cents })).filter((r) => Math.abs(r.spent) >= 1).sort((a, b) => b.spent - a.spent);

  const mmByName = {};
  for (const e of mLeaves.filter((e) => e.kind === 'mm' || e.kind === 'reimb' || e.kind === 'transfer')) {
    const catName = e.kind === 'transfer' ? 'Transfer' : (e.catId ? nameOf(e.catId) : '(uncategorized)');
    const k = mmByName[catName] || (mmByName[catName] = { out: 0, inn: 0, net: 0 });
    k.net += e.amount; if (e.amount < 0) k.out += -e.amount; else k.inn += e.amount;
  }

  const uncats = mLeaves.filter((e) => e.onbudget && e.kind === 'uncat');
  const largest = [...mReal].filter((e) => e.amount < 0).sort((a, b) => a.amount - b.amount).slice(0, 3);
  const incomplete = incompleteTransferLeaves(mLeaves);

  const out = [];
  out.push(`FINANCE DIGEST (deterministic; numbers are EXACT - format verbatim, do not recompute)`);
  out.push(`generated=${today} tz=${FINANCE_TIME_ZONE} yesterday=${yesterday} mtd=${monthStart}..${today}`);
  out.push('');
  out.push(`[YESTERDAY ${yesterday}] real_spend=${money(yRealCents)} txns=${yShow.length}`);
  for (const e of yShow.sort((a, b) => a.amount - b.amount)) {
    const catName = catKey(e);
    out.push(`- ${e.payee || '(no payee)'} | ${accounts.find((a) => a.id === e.accountId)?.name || ''} | ${money(e.amount)} | ${catName}${e.kind !== 'spend' && e.kind !== 'uncat' ? ' [' + e.kind + ']' : ''}`);
  }
  out.push('');
  out.push(`[BALANCES]`);
  for (const b of balances.sort((x, y) => (x.offbudget === y.offbudget ? y.bal - x.bal : x.offbudget ? 1 : -1))) {
    out.push(`- ${b.name} | ${money(b.bal)} | ${b.offbudget ? 'off-budget' : 'on-budget'}`);
  }
  out.push('');
  out.push(`[MTD REAL SPENDING] total=${money(mRealCents)} (excludes Money Movement, Income, Reimbursement)`);
  for (const r of catRows) out.push(`- ${r.name} | ${money(r.spent)}`);
  out.push('');
  out.push(`[MONEY MOVEMENT MTD] (separate, NOT spending)`);
  for (const [name, k] of Object.entries(mmByName).sort((a, b) => b[1].out - a[1].out)) {
    out.push(`- ${name} | out=${money(k.out)} | in=${money(k.inn)} | net=${money(k.net)}`);
  }
  out.push('');
  out.push(`[UNCATEGORIZED MTD] count=${uncats.length}`);
  for (const e of uncats.sort((a, b) => a.amount - b.amount)) {
    out.push(`- ${e.date} | ${e.payee || '(no payee)'} | ${accounts.find((a) => a.id === e.accountId)?.name || ''} | ${money(e.amount)}`);
  }
  out.push('');
  out.push(`[FLAGS] largest real-spend charges MTD`);
  if (largest.length) {
    for (const e of largest) out.push(`- ${e.date} | ${e.payee || '(no payee)'} | ${money(e.amount)} | ${catKey(e)}`);
  } else out.push('- none');
  if (incomplete.length) {
    out.push('');
    const reasons = [...new Set(incomplete.map((leaf) => leaf.transferReason || leaf.reason).filter(Boolean))].sort();
    out.push(`[INCOMPLETE TRANSFER IDENTITY] count=${incomplete.length} reasons=${reasons.join(',')}`);
  }

  if (process.env.DIGEST_DEBUG) {
    out.push('');
    out.push('[CATEGORY CLASSIFICATION AUDIT]');
    const kinds = {};
    for (const id in catInfo) { const { name, kind } = catInfo[id]; (kinds[kind] = kinds[kind] || new Set()).add(name); }
    for (const k of Object.keys(kinds)) out.push(`- ${k}: ${[...kinds[k]].join(', ')}`);
  }

  console.log(out.join('\n'));
  await api.shutdown();
  if (process.env.DIGEST_STRICT === '1' && incomplete.length) process.exit(2);
})().catch((e) => { console.error('DIGEST_ERR', (e && e.stack) || e); process.exit(1); });
