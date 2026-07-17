#!/usr/bin/env node
/*
 * finance-weekly.js — DETERMINISTIC weekly recap: this 7 days vs the prior 7 days.
 *
 * READ-ONLY. Same classification as finance-digest.js (income / mm / reimb / spend / uncat,
 * real spend = on-budget spend + uncategorized). Numbers are EXACT; an LLM only formats.
 *
 * Windows (canonical finance timezone, anchored at today): this=[today-6..today], last=[today-13..today-7].
 * Env (via run.sh + .actual.env): ACTUAL_SERVER_URL, ACTUAL_PASSWORD, ACTUAL_SYNC_ID, FIX_DATA_DIR
 */
const api = require('@actual-app/api');
const { addDays, todayYMD } = require('./lib/date-only');
const { buildToolCategoryInfo, classifiedLeavesForAccounts, incompleteTransferLeaves } = require('./lib/transfer-classification');

const c2 = (cents) => (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (cents) => (cents < 0 ? '-$' : '$') + c2(cents);
const signed = (cents) => (cents < 0 ? '-$' : '+$') + c2(cents);

const MM_CAT = /^(transfers?|investments?|credit\s*card\s*payments?|cc\s*payments?)$/i;
const REIMB_CAT = /^reimbursement$/i;

(async () => {
  await api.init({ dataDir: process.env.FIX_DATA_DIR, serverURL: process.env.ACTUAL_SERVER_URL, password: process.env.ACTUAL_PASSWORD });
  await api.downloadBudget(process.env.ACTUAL_SYNC_ID);

  const today = todayYMD();
  const thisStart = addDays(today, -6), thisEnd = today;
  const lastStart = addDays(today, -13), lastEnd = addDays(today, -7);

  const groups = await api.getCategoryGroups();
  const catInfo = buildToolCategoryInfo(groups);
  const nameOf = (id) => (id && catInfo[id] ? catInfo[id].name : '(uncategorized)');
  const payees = await api.getPayees();
  const pn = {}; for (const p of payees) pn[p.id] = p.name || '';
  const accounts = await api.getAccounts();
  const transactionsByAccountId = new Map();
  for (const a of accounts) {
    transactionsByAccountId.set(a.id, await api.getTransactions(a.id, lastStart, today));
  }
  const classified = classifiedLeavesForAccounts(accounts, transactionsByAccountId, catInfo, (t) => pn[t.payee] || '');
  const leaves = classified.map((lf) => ({
    date: lf.date,
    payee: lf.payee,
    amount: lf.amount,
    catName: lf.kind === 'transfer' ? 'Transfer' : lf.catId ? nameOf(lf.catId) : '(uncategorized)',
    kind: lf.kind,
    onbudget: lf.onbudget,
  }));

  const inRange = (d, a, b) => d >= a && d <= b;
  const isReal = (e) => e.onbudget && (e.kind === 'spend' || (e.kind === 'uncat' && e.amount < 0));
  const catKey = (e) => (e.kind === 'uncat' ? 'Uncategorized' : e.catName);

  function week(a, b) {
    const es = leaves.filter((e) => inRange(e.date, a, b));
    const real = es.filter(isReal);
    const realCents = -real.reduce((s, e) => s + e.amount, 0);
    const byCat = {}; for (const e of real) byCat[catKey(e)] = (byCat[catKey(e)] || 0) + e.amount;
    const byPayee = {}; for (const e of real) if (e.amount < 0) byPayee[e.payee || '(no payee)'] = (byPayee[e.payee || '(no payee)'] || 0) + e.amount;
    const income = es.filter((e) => e.kind === 'income' && e.amount > 0).reduce((s, e) => s + e.amount, 0);
    return { realCents, byCat, byPayee, income, payeeSet: new Set(real.filter((e) => e.amount < 0).map((e) => e.payee)) };
  }
  const T = week(thisStart, thisEnd), L = week(lastStart, lastEnd);

  const out = [];
  out.push(`FINANCE WEEKLY (deterministic; numbers are EXACT - format verbatim, do not recompute)`);
  out.push(`generated=${today} tz=${TZ} this_week=${thisStart}..${thisEnd} last_week=${lastStart}..${lastEnd}`);
  out.push('');
  out.push(`[REAL SPEND] this=${money(T.realCents)} last=${money(L.realCents)} change=${signed(T.realCents - L.realCents)}`);
  out.push('');
  out.push(`[BY CATEGORY this vs last] (spent)`);
  const cats = [...new Set([...Object.keys(T.byCat), ...Object.keys(L.byCat)])];
  const catRows = cats.map((n) => ({ n, t: -(T.byCat[n] || 0), l: -(L.byCat[n] || 0) })).sort((a, b) => b.t - a.t);
  for (const r of catRows) out.push(`- ${r.n} | this=${money(r.t)} | last=${money(r.l)} | change=${signed(r.t - r.l)}`);
  out.push('');
  out.push(`[TOP MERCHANTS this week] (real spend)`);
  const merch = Object.entries(T.byPayee).map(([p, c]) => ({ p, spent: -c })).sort((a, b) => b.spent - a.spent).slice(0, 6);
  if (merch.length) for (const m of merch) out.push(`- ${m.p} | ${money(m.spent)}`); else out.push('- none');
  out.push('');
  out.push(`[CASH FLOW] this: income=${money(T.income)} real_spend=${money(T.realCents)} net=${signed(T.income - T.realCents)}`);
  out.push(`          last: income=${money(L.income)} real_spend=${money(L.realCents)} net=${signed(L.income - L.realCents)}`);
  out.push('');
  out.push(`[RECURRING] payees seen in BOTH weeks (likely recurring)`);
  const both = [...T.payeeSet].filter((p) => p && L.payeeSet.has(p));
  if (both.length) for (const p of both) out.push(`- ${p}`); else out.push('- none detected');
  out.push('');
  out.push(`[OFF-TREND] biggest category changes (this vs last)`);
  const trend = catRows.map((r) => ({ n: r.n, d: r.t - r.l })).filter((r) => Math.abs(r.d) >= 1).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 4);
  if (trend.length) for (const r of trend) out.push(`- ${r.n} | ${signed(r.d)}`); else out.push('- none');
  const incomplete = incompleteTransferLeaves(classified);
  if (incomplete.length) {
    out.push('');
    const reasons = [...new Set(incomplete.map((leaf) => leaf.transferReason || leaf.reason).filter(Boolean))].sort();
    out.push(`[INCOMPLETE TRANSFER IDENTITY] count=${incomplete.length} reasons=${reasons.join(',')}`);
  }

  console.log(out.join('\n'));
  await api.shutdown();
  if (process.env.DIGEST_STRICT === '1' && incomplete.length) process.exit(2);
})().catch((e) => { console.error('WEEKLY_ERR', (e && e.stack) || e); process.exit(1); });
