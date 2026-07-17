#!/usr/bin/env node
/* month-review.js — READ-ONLY. Lists every month-to-date on-budget transaction grouped by
   category so the owner can verify categorization. Money Movement / Reimbursement / Income
   are summarized (net) rather than line-listed. */
const api = require('@actual-app/api');
const { todayYMD } = require('./lib/date-only');
const { buildToolCategoryInfo, classifiedLeavesForAccounts, incompleteTransferLeaves } = require('./lib/transfer-classification');
const { monthReviewRealSpendTotalLine } = require('./lib/real-spend-total-line');
const money = (c) => (c < 0 ? '-$' : '$') + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const MM_CAT = /^(transfers?|investments?|credit\s*card\s*payments?|cc\s*payments?)$/i;
const REIMB_CAT = /^reimbursement$/i;

async function main() {
  await api.init({ dataDir: process.env.FIX_DATA_DIR, serverURL: process.env.ACTUAL_SERVER_URL, password: process.env.ACTUAL_PASSWORD });
  await api.downloadBudget(process.env.ACTUAL_SYNC_ID);

  const today = todayYMD();
  const monthStart = today.slice(0, 8) + '01';

  const groups = await api.getCategoryGroups();
  const catInfo = buildToolCategoryInfo(groups);
  const nameOf = (id) => (id && catInfo[id] ? catInfo[id].name : '(uncategorized)');

  const payees = await api.getPayees();
  const pn = {}; for (const p of payees) pn[p.id] = p.name || '';
  const accounts = await api.getAccounts();
  const an = {}; for (const a of accounts) an[a.id] = a.name;
  const transactionsByAccountId = new Map();
  for (const a of accounts) {
    transactionsByAccountId.set(a.id, await api.getTransactions(a.id, monthStart, today));
  }
  const classified = classifiedLeavesForAccounts(accounts, transactionsByAccountId, catInfo, (t) => pn[t.payee] || '');
  const rows = classified.map((lf) => ({
    date: lf.date,
    payee: lf.payee || '(no payee)',
    acct: (an[lf.accountId] || '').replace(/\s*\(.*$/, '').slice(0, 18),
    amount: lf.amount,
    catName: lf.kind === 'transfer' ? 'Transfer' : lf.catId ? nameOf(lf.catId) : '(uncategorized)',
    kind: lf.kind,
    notes: (lf.notes || '').replace(/\s+/g, ' ').slice(0, 44),
    onbudget: lf.onbudget,
    split: !!lf.isLeg,
    transferReason: lf.transferReason || lf.reason,
  }));
  const incomplete = incompleteTransferLeaves(classified);

  const byCat = {};
  for (const r of rows) {
    if (!r.onbudget) continue;
    const key = r.kind + '::' + (r.kind === 'uncat' ? 'Uncategorized' : r.catName);
    (byCat[key] = byCat[key] || []).push(r);
  }
  const keys = Object.keys(byCat);
  const spentOf = (k) => -byCat[k].reduce((s, r) => s + r.amount, 0);

  const out = [];
  out.push(`MONTH REVIEW ${monthStart} .. ${today}  (on-budget only)`);

  const spendKeys = keys.filter((k) => k.startsWith('spend::') || k.startsWith('uncat::')).sort((a, b) => spentOf(b) - spentOf(a));
  let grand = 0;
  for (const k of spendKeys) {
    const cat = k.split('::')[1];
    const tot = spentOf(k);
    grand += tot;
    out.push('');
    out.push(`### ${cat}  — spent ${money(tot)}  (${byCat[k].length} txn)`);
    for (const r of byCat[k].sort((a, b) => (a.date < b.date ? -1 : 1))) {
      out.push(`  ${r.date} | ${money(r.amount).padStart(11)} | ${r.payee} | ${r.acct}${r.split ? ' | SPLIT' : ''}${r.notes ? ' | ' + r.notes : ''}`);
    }
  }
  out.push('');
  out.push(monthReviewRealSpendTotalLine(grand, { incomplete: incomplete.length > 0 }));

  for (const kind of ['mm', 'reimb']) {
    const kk = keys.filter((k) => k.startsWith(kind + '::'));
    if (!kk.length) continue;
    out.push('');
    out.push(`### [${kind === 'mm' ? 'MONEY MOVEMENT' : 'REIMBURSEMENT'}]  (summary, NOT spending)`);
    for (const k of kk) {
      const cat = k.split('::')[1];
      const net = byCat[k].reduce((s, r) => s + r.amount, 0);
      out.push(`  ${cat}: net ${money(net)}  (${byCat[k].length} txn)`);
    }
  }
  const incKeys = keys.filter((k) => k.startsWith('income::'));
  if (incKeys.length) {
    out.push('');
    out.push(`### [INCOME]  (summary)`);
    for (const k of incKeys) {
      const cat = k.split('::')[1];
      const net = byCat[k].reduce((s, r) => s + r.amount, 0);
      out.push(`  ${cat}: net ${money(net)}  (${byCat[k].length} txn)`);
    }
  }
  if (incomplete.length) {
    out.push('');
    const reasons = [...new Set(incomplete.map((leaf) => leaf.transferReason || leaf.reason).filter(Boolean))].sort();
    out.push(`### [INCOMPLETE TRANSFER IDENTITY] count=${incomplete.length} reasons=${reasons.join(',')}`);
    for (const leaf of incomplete.sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
      out.push(`  ${leaf.date} | ${money(leaf.amount).padStart(11)} | ${leaf.payee || '(no payee)'} | ${an[leaf.accountId] || ''} | ${leaf.transferReason || leaf.reason}`);
    }
  }

  console.log(out.join('\n'));
  await api.shutdown();
  if (process.env.DIGEST_STRICT === '1' && incomplete.length) process.exit(2);
}

if (require.main === module) {
  main().catch((e) => { console.error('REVIEW_ERR', (e && e.stack) || e); process.exit(1); });
}
