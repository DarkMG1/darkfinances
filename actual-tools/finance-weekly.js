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

const TZ = process.env.FINANCE_TIME_ZONE || process.env.TZ || 'America/Los_Angeles';
const c2 = (cents) => (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (cents) => (cents < 0 ? '-$' : '$') + c2(cents);
const signed = (cents) => (cents < 0 ? '-$' : '+$') + c2(cents);

function financeToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function addDays(ymd, n) {
  const [Y, M, D] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(Y, M - 1, D));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

const MM_CAT = /^(transfers?|investments?|credit\s*card\s*payments?|cc\s*payments?)$/i;
const REIMB_CAT = /^reimbursement$/i;
const TRANSFER_PAYEE = /^transfer\s*:?\s*(to|from)\b|\btransfer (to|from)\b/i;

(async () => {
  await api.init({ dataDir: process.env.FIX_DATA_DIR, serverURL: process.env.ACTUAL_SERVER_URL, password: process.env.ACTUAL_PASSWORD });
  await api.downloadBudget(process.env.ACTUAL_SYNC_ID);

  const today = financeToday();
  const thisStart = addDays(today, -6), thisEnd = today;
  const lastStart = addDays(today, -13), lastEnd = addDays(today, -7);

  const groups = await api.getCategoryGroups();
  const catInfo = {};
  for (const g of groups) {
    const inc = g.is_income === true || /^income$/i.test(g.name || '');
    const mm = /money\s*movement/i.test(g.name || '');
    for (const c of (g.categories || [])) {
      let k = 'spend';
      if (inc) k = 'income';
      else if (REIMB_CAT.test(c.name || '')) k = 'reimb';
      else if (mm || MM_CAT.test(c.name || '')) k = 'mm';
      catInfo[c.id] = { name: c.name, kind: k };
    }
  }
  const nameOf = (id) => (id && catInfo[id] ? catInfo[id].name : '(uncategorized)');
  const kindOf = (id) => (id && catInfo[id] ? catInfo[id].kind : 'uncat');
  const payees = await api.getPayees();
  const pn = {}; for (const p of payees) pn[p.id] = p.name || '';
  const accounts = await api.getAccounts();

  const leaves = [];
  for (const a of accounts) {
    const tx = await api.getTransactions(a.id, lastStart, today);
    for (const t of tx) {
      const payeeName = pn[t.payee] || '';
      const pTransfer = !!(t.transfer_id || t.transferred_id) || TRANSFER_PAYEE.test(payeeName);
      const isSplit = t.subtransactions && t.subtransactions.length;
      const ls = isSplit
        ? t.subtransactions.map((s) => ({ amount: s.amount, catId: s.category, transfer: !!s.transfer_id }))
        : [{ amount: t.amount, catId: t.category, transfer: pTransfer }];
      for (const lf of ls) {
        let kind = kindOf(lf.catId);
        if (kind === 'uncat' && (lf.transfer || pTransfer)) kind = 'mm';
        leaves.push({ date: t.date, payee: payeeName, amount: lf.amount, catName: lf.catId ? nameOf(lf.catId) : (kind === 'mm' ? 'Transfer' : '(uncategorized)'), kind, onbudget: !a.offbudget });
      }
    }
  }

  const inRange = (d, a, b) => d >= a && d <= b;
  const isReal = (e) => e.onbudget && (e.kind === 'spend' || e.kind === 'uncat');
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

  console.log(out.join('\n'));
  await api.shutdown();
})().catch((e) => { console.error('WEEKLY_ERR', (e && e.stack) || e); process.exit(1); });
