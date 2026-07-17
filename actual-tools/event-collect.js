#!/usr/bin/env node
// CONFIRM-gated auto-tagging of incoming event repayments.
// All people, aliases, dates and Splitwise group names live in collection-rules.json.

const fs = require('fs');
const path = require('path');
const api = require('@actual-app/api');
const sw = require('./splitwise-lib');
const { todayYMD } = require('./lib/date-only');

const CONFIRM = process.env.CONFIRM === '1';
const EVENT = process.env.COLLECTION_EVENT;
const CONFIG_PATH = process.env.COLLECTION_RULES_PATH || path.join(__dirname, 'collection-rules.json');
const DATA_DIR = process.env.FIX_DATA_DIR || process.env.ACTUAL_DATA_DIR;
const money = (cents) => `$${(Number(cents) / 100).toFixed(2)}`;

function readRule() {
  if (!EVENT) throw new Error('COLLECTION_EVENT is required');
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const rule = config.events?.[EVENT];
  if (!rule) throw new Error(`No collection rule configured for ${EVENT}`);
  if (!rule.group || !rule.tag || !rule.start || !rule.debtors) throw new Error(`Collection rule ${EVENT} is incomplete`);
  return rule;
}

function compileDebtors(rule, routed) {
  const debtors = {};
  for (const [slug, value] of Object.entries(rule.debtors)) {
    const patterns = Array.isArray(value.patterns) ? value.patterns : [];
    if (!patterns.length) throw new Error(`No payment pattern configured for ${slug}`);
    const expected = routed.find((person) => person.slug === slug)?.amount || 0;
    debtors[slug] = {
      expectedCents: Math.round(expected * 100),
      regex: new RegExp(patterns.map((pattern) => `(?:${pattern})`).join('|'), 'i'),
    };
  }
  return debtors;
}

(async () => {
  const rule = readRule();
  await api.init({ dataDir: DATA_DIR, serverURL: process.env.ACTUAL_SERVER_URL, password: process.env.ACTUAL_PASSWORD });
  await api.downloadBudget(process.env.ACTUAL_SYNC_ID);

  // simplified_debts is intentionally used here for payment routing, not for the
  // dashboard's "who owes me" totals (which remain direct pairwise only).
  const group = await sw.getGroupDebts(rule.group);
  const debtors = compileDebtors(rule, group.owedToMe || []);
  const categoryGroups = await api.getCategoryGroups();
  let reimbursementId = null;
  for (const categoryGroup of categoryGroups) {
    for (const category of categoryGroup.categories || []) {
      if (/^reimbursement$/i.test(category.name || '')) reimbursementId = category.id;
    }
  }
  if (!reimbursementId) throw new Error('Reimbursement category not found');

  const payees = await api.getPayees();
  const payeeNames = Object.fromEntries(payees.map((payee) => [payee.id, payee.name || '']));
  const accounts = (await api.getAccounts()).filter((account) => !account.closed && !account.offbudget);
  const end = todayYMD();
  const rows = [];
  for (const account of accounts) {
    for (const transaction of await api.getTransactions(account.id, rule.start, end)) {
      rows.push({ ...transaction, accountId: account.id });
    }
  }

  const received = Object.fromEntries(Object.keys(debtors).map((slug) => [slug, 0]));
  for (const transaction of rows) {
    const leaves = transaction.subtransactions?.length ? transaction.subtransactions : [transaction];
    for (const leaf of leaves) {
      const notes = leaf.notes || transaction.notes || '';
      if (!(leaf.amount > 0) || !notes.includes(`#${rule.tag}`)) continue;
      const label = `${payeeNames[transaction.payee] || transaction.imported_payee || ''} ${notes}`;
      for (const [slug, debtor] of Object.entries(debtors)) if (debtor.regex.test(label)) received[slug] += leaf.amount;
    }
  }

  const low = Number(rule.minRatio ?? 0.4);
  const high = Number(rule.maxRatio ?? 1.6);
  let tagged = 0;
  const review = [];
  for (const transaction of rows) {
    if (transaction.date < rule.start || transaction.amount <= 0 || transaction.subtransactions?.length) continue;
    if (String(transaction.notes || '').includes(`#${rule.tag}`)) continue;
    const label = `${payeeNames[transaction.payee] || transaction.imported_payee || ''} ${transaction.notes || ''}`;
    const match = Object.entries(debtors).find(([, debtor]) => debtor.regex.test(label));
    if (!match) continue;
    const [slug, debtor] = match;
    const remaining = Math.max(0, debtor.expectedCents - received[slug]);
    const baseline = remaining || debtor.expectedCents;
    if (!(baseline > 0) || transaction.amount < baseline * low || transaction.amount > baseline * high) {
      review.push({ id: transaction.id, date: transaction.date, amount: transaction.amount, slug });
      continue;
    }
    const notes = `${String(transaction.notes || '').trim()} #${rule.tag} #${slug}`.trim();
    console.log(`${CONFIRM ? 'TAG' : 'DRY'} ${transaction.date} ${money(transaction.amount)} #${slug}`);
    if (CONFIRM) await api.updateTransaction(transaction.id, { category: reimbursementId, notes });
    received[slug] += transaction.amount;
    tagged++;
  }
  if (CONFIRM && tagged) await api.sync();
  console.log(`${CONFIRM ? 'APPLIED' : 'DRY-RUN'}: ${tagged} repayment(s); ${review.length} need review`);
  await api.shutdown();
})().catch(async (error) => {
  console.error('ERR', error?.stack || error);
  try { await api.shutdown(); } catch (_) {}
  process.exit(1);
});
