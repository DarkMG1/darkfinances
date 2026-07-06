#!/usr/bin/env node
// splitwise-reconcile.js — READ-ONLY per-person NET reconciliation for any Splitwise group.
//
// ⭐ THE LESSON (applies to ALL trips/events, always): a person's debt to you is the NET of
// BOTH directions — (their share of lines you fronted) MINUS (your share of lines THEY
// fronted). Settlements happen on the net. Using only the gross "items I paid for" basis
// OVERSTATES the debt of anyone who also fronted anything. Never quote/chase a gross figure.
//
// For each member it prints: gross owed to you, what you owe them, NET owed, paid back
// (Splitwise payments to you), and remaining. Multi-payer expenses are flagged (ambiguous
// pairwise attribution) so they can be eyeballed.
//
// Usage: bash ~/actual-tools/splitwise-run.sh --reconcile <group name|id>
//    or: node splitwise-reconcile.js --group <name|id>   (needs creds in env)

const API = 'https://secure.splitwise.com/api/v3.0';
const TOKEN_URL = 'https://secure.splitwise.com/oauth/token';

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return (v && !v.startsWith('--')) ? v : true;
}
const f2 = n => Number(n).toFixed(2);

async function getToken() {
  if (process.env.SPLITWISE_API_KEY) return process.env.SPLITWISE_API_KEY;
  const key = process.env.SPLITWISE_CONSUMER_KEY, secret = process.env.SPLITWISE_CONSUMER_SECRET;
  if (!key || !secret) throw new Error('Missing SPLITWISE_API_KEY or SPLITWISE_CONSUMER_KEY/SECRET');
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: key, client_secret: secret });
  const r = await fetch(TOKEN_URL, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  if (!r.ok) throw new Error(`token failed: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}
async function api(token, endpoint, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${API}/${endpoint}${qs ? '?' + qs : ''}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`${endpoint} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function main() {
  const token = await getToken();
  const me = (await api(token, 'get_current_user')).user;
  const myId = me.id;
  const groupArg = arg('--group');
  if (!groupArg || groupArg === true) throw new Error('pass --group <name|id>');

  let groups = (await api(token, 'get_groups')).groups;
  const gf = String(groupArg).toLowerCase();
  const g = groups.find(x => String(x.id) === gf || (x.name || '').toLowerCase().includes(gf));
  if (!g) throw new Error(`no group matched "${groupArg}"`);
  const names = Object.fromEntries((g.members || []).map(m => [m.id, `${m.first_name || ''} ${m.last_name || ''}`.trim()]));

  // ── AUTHORITATIVE: Splitwise's own group balance + simplified debts ───────────
  const myBal = ((g.members.find(m => m.id === myId) || {}).balance || []).map(b => `${b.amount} ${b.currency_code}`).join(', ') || '0.00';
  console.log(`\n### ${g.name} — SPLITWISE AUTHORITATIVE (use these for collection) ###`);
  console.log(`My net balance in group: ${myBal}`);
  const sd = (g.simplified_debts || []);
  const owesMe = sd.filter(x => x.to === myId), iOwe = sd.filter(x => x.from === myId);
  if (owesMe.length) { console.log('Owes me:'); for (const x of owesMe) console.log(`   ${names[x.from] || x.from}: $${x.amount}`); }
  if (iOwe.length) { console.log('I owe:'); for (const x of iOwe) console.log(`   ${names[x.to] || x.to}: $${x.amount}`); }
  if (!owesMe.length && !iOwe.length) console.log('   (no open debts involving me — settled)');
  console.log('\n--- line-item reconstruction below is a CROSS-CHECK on the total only ---');
  console.log('--- (per-person may differ from above due to Splitwise debt simplification) ---');

  const expenses = (await api(token, 'get_expenses', { group_id: g.id, limit: 0 })).expenses.filter(e => !e.deleted_at);

  const grossOwed = {}, meOwes = {}, paid = {};
  let multiPayerNote = 0;
  const add = (o, k, v) => { o[k] = (o[k] || 0) + v; };

  for (const e of expenses) {
    const users = e.users || [];
    const c = users.find(u => u.user_id === myId);
    const payers = users.filter(u => Number(u.paid_share) > 0);
    if (e.payment) {
      // settle-up. NET both directions: payments TO me reduce remaining (+),
      // payments FROM me to a person increase their remaining (−).
      const payer = users.find(u => Number(u.paid_share) > 0);
      const receiver = users.find(u => Number(u.owed_share) > 0);
      if (!payer || !receiver) continue;
      if (receiver.user_id === myId) add(paid, payer.user_id, Number(payer.paid_share));        // they paid me
      else if (payer.user_id === myId) add(paid, receiver.user_id, -Number(receiver.owed_share)); // I paid them
      continue;
    }
    // direction 1: I fronted -> others owe their share
    if (c && Number(c.paid_share) > 0) {
      for (const u of users) if (u.user_id !== myId && Number(u.owed_share) > 0) add(grossOwed, u.user_id, Number(u.owed_share));
    }
    // direction 2: someone else fronted -> I owe them my share
    if (c && Number(c.owed_share) > 0 && !payers.some(p => p.user_id === myId)) {
      if (payers.length === 1) add(meOwes, payers[0].user_id, Number(c.owed_share));
      else if (payers.length > 1) multiPayerNote++;
    }
  }

  const ids = new Set([...Object.keys(grossOwed), ...Object.keys(meOwes), ...Object.keys(paid)].map(Number));
  console.log(`\n=== ${g.name} — NET reconciliation (me: ${me.first_name} ${me.last_name}) ===`);
  console.log('person            grossOwed  iOweThem    NET-owed     paid   REMAINING');
  let totalRemaining = 0;
  const rows = [...ids].map(pid => {
    const o = grossOwed[pid] || 0, co = meOwes[pid] || 0, p = paid[pid] || 0;
    const net = +(o - co).toFixed(2), rem = +(net - p).toFixed(2);
    return { pid, o, co, net, p, rem };
  }).sort((a, b) => b.rem - a.rem);
  for (const r of rows) {
    totalRemaining += r.rem;
    const flag = Math.abs(r.rem) < 0.01 ? ' ✓ settled' : (r.rem > 0 ? ' <== OWES' : ' (you owe)');
    console.log(`${(names[r.pid] || r.pid).padEnd(16)} ${f2(r.o).padStart(9)} ${f2(r.co).padStart(9)} ${f2(r.net).padStart(10)} ${f2(r.p).padStart(8)} ${f2(r.rem).padStart(10)}${flag}`);
  }
  console.log('-'.repeat(72));
  console.log(`TOTAL still owed to me: ${f2(totalRemaining)}`);
  if (multiPayerNote) console.log(`\n⚠️ ${multiPayerNote} multi-payer expense(s) skipped in "iOweThem" (ambiguous pairwise) — eyeball if numbers look off.`);
}

main().catch(e => { console.error('ERR', e && (e.stack || e.message || e)); process.exit(1); });
