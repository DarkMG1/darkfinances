#!/usr/bin/env node
// CONFIRM-gated auto-tagging of incoming event repayments.
// All people, aliases, dates and Splitwise group names live in collection-rules.json.

const path = require('path');
const api = require('@actual-app/api');
const sw = require('./splitwise-lib');
const { todayYMD } = require('./lib/date-only');
const {
  compileCollectionDebtors,
  loadCollectionRule,
} = require('./lib/operator-regex-config');

const CONFIRM = process.env.CONFIRM === '1';
const EVENT = process.env.COLLECTION_EVENT;
const CONFIG_PATH = process.env.COLLECTION_RULES_PATH || path.join(__dirname, 'collection-rules.json');
const DATA_DIR = process.env.FIX_DATA_DIR || process.env.ACTUAL_DATA_DIR;
const money = (cents) => `$${(Number(cents) / 100).toFixed(2)}`;

function paymentNotes(transaction, leaf = transaction) {
  const parentNotes = String(transaction.notes || '').trim();
  const leafNotes = leaf === transaction ? '' : String(leaf.notes || '').trim();
  return [parentNotes, leafNotes].filter(Boolean).join(' ');
}

function hasCanonicalTag(notes, tag) {
  return (String(notes || '').match(/#[a-z0-9_-]+/gi) || [])
    .some((value) => value.slice(1).toLowerCase() === tag);
}

(async () => {
  if (!EVENT) throw new Error('COLLECTION_EVENT is required');
  const rule = loadCollectionRule(CONFIG_PATH, EVENT);
  await api.init({ dataDir: DATA_DIR, serverURL: process.env.ACTUAL_SERVER_URL, password: process.env.ACTUAL_PASSWORD });
  await api.downloadBudget(process.env.ACTUAL_SYNC_ID);

  // simplified_debts is intentionally used here for payment routing, not for the
  // dashboard's "who owes me" totals (which remain direct pairwise only).
  const group = await sw.getGroupDebts(rule.group);
  const debtors = compileCollectionDebtors(rule, group.owedToMe || []);
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
  const review = [];
  const matchingDebtors = (label) => Object.entries(debtors)
    .filter(([, debtor]) => debtor.regex.test(label));
  const addReview = (transaction, leaf, matches, reason) => {
    const slugs = matches.map(([slug]) => slug);
    const item = {
      id: leaf.id || transaction.id,
      date: leaf.date || transaction.date,
      amount: leaf.amount,
      slugs,
      reason,
    };
    review.push(item);
    const identities = slugs.length ? ` (${slugs.map((slug) => `#${slug}`).join(', ')})` : '';
    console.log(`REVIEW ${item.date} ${money(item.amount)} ${reason}${identities}`);
  };

  for (const transaction of rows) {
    const leaves = transaction.subtransactions?.length ? transaction.subtransactions : [transaction];
    for (const leaf of leaves) {
      const notes = paymentNotes(transaction, leaf);
      if (!(leaf.amount > 0) || !hasCanonicalTag(notes, rule.tag)) continue;
      const label = `${payeeNames[transaction.payee] || transaction.imported_payee || ''} ${notes}`;
      const matches = matchingDebtors(label);
      if (matches.length !== 1) {
        addReview(transaction, leaf, matches, matches.length ? 'multiple-debtors' : 'no-debtor');
        continue;
      }
      received[matches[0][0]] += leaf.amount;
    }
  }

  const low = rule.minRatio;
  const high = rule.maxRatio;
  let tagged = 0;
  for (const transaction of rows) {
    if (transaction.date < rule.start || transaction.amount <= 0 || transaction.subtransactions?.length) continue;
    const transactionNotes = paymentNotes(transaction);
    if (hasCanonicalTag(transactionNotes, rule.tag)) continue;
    const label = `${payeeNames[transaction.payee] || transaction.imported_payee || ''} ${transactionNotes}`;
    const matches = matchingDebtors(label);
    if (matches.length !== 1) {
      addReview(transaction, transaction, matches, matches.length ? 'multiple-debtors' : 'no-debtor');
      continue;
    }
    const [slug, debtor] = matches[0];
    const remaining = Math.max(0, debtor.expectedCents - received[slug]);
    const baseline = remaining || debtor.expectedCents;
    if (!(baseline > 0) || transaction.amount < baseline * low || transaction.amount > baseline * high) {
      addReview(transaction, transaction, matches, 'amount-out-of-range');
      continue;
    }
    const notes = `${transactionNotes} #${rule.tag} #${slug}`.trim();
    console.log(`${CONFIRM ? 'TAG' : 'DRY'} ${transaction.date} ${money(transaction.amount)} #${slug}`);
    if (CONFIRM) {
      await api.updateTransaction(transaction.id, { category: reimbursementId, notes });
      // Each completed sync is a resume checkpoint: a later failure exits
      // nonzero, and the next run skips transactions carrying this event tag.
      await api.sync();
    }
    received[slug] += transaction.amount;
    tagged++;
  }
  console.log(`${CONFIRM ? 'APPLIED' : 'DRY-RUN'}: ${tagged} repayment(s); ${review.length} need review`);
  await api.shutdown();
})().catch(async (error) => {
  console.error('ERR', error?.stack || error);
  try { await api.shutdown(); } catch (_) {}
  process.exit(1);
});
