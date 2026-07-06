#!/usr/bin/env node
// splitwise-pull.js — READ-ONLY pull of Splitwise groups + expenses via the official API.
// Auth: mints a bearer token from SPLITWISE_CONSUMER_KEY/SECRET (client_credentials),
//       or uses SPLITWISE_API_KEY if provided. Never edits/creates/deletes anything.
//
// Usage:
//   node splitwise-pull.js                         # all groups, all dates -> JSON per group
//   node splitwise-pull.js --group "trip group"    # one group (name substring or id)
//   node splitwise-pull.js --since 2026-06-01      # only expenses dated on/after
//   node splitwise-pull.js --out /path/dir         # output dir (default ~/actual-tools/splitwise)
//   node splitwise-pull.js --print                 # also print a per-item table to stdout
//
// Output: <out>/<slug>_<YYYY-MM-DD>_pull.json  (normalized, per-item, per-person shares)

const fs = require('fs');
const os = require('os');
const path = require('path');

const API = 'https://secure.splitwise.com/api/v3.0';
const TOKEN_URL = 'https://secure.splitwise.com/oauth/token';

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return (v && !v.startsWith('--')) ? v : true;
}
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const c2 = n => (n == null ? '' : Number(n).toFixed(2));

async function getToken() {
  if (process.env.SPLITWISE_API_KEY) return process.env.SPLITWISE_API_KEY;
  const key = process.env.SPLITWISE_CONSUMER_KEY, secret = process.env.SPLITWISE_CONSUMER_SECRET;
  if (!key || !secret) throw new Error('Missing SPLITWISE_API_KEY or SPLITWISE_CONSUMER_KEY/SECRET in env');
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: key, client_secret: secret });
  const r = await fetch(TOKEN_URL, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  if (!r.ok) throw new Error(`token request failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  if (!j.access_token) throw new Error('no access_token in token response');
  return j.access_token;
}

async function api(token, endpoint, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${API}/${endpoint}${qs ? '?' + qs : ''}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`${endpoint} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function main() {
  const token = await getToken();
  const me = (await api(token, 'get_current_user')).user;
  const myId = me.id;

  const groupFilter = arg('--group');
  const since = arg('--since');
  const outDir = arg('--out') || path.join(os.homedir(), 'actual-tools', 'splitwise');
  const doPrint = !!arg('--print');
  fs.mkdirSync(outDir, { recursive: true });

  let groups = (await api(token, 'get_groups')).groups;
  if (groupFilter && groupFilter !== true) {
    const f = String(groupFilter).toLowerCase();
    groups = groups.filter(g => String(g.id) === f || (g.name || '').toLowerCase().includes(f));
    if (!groups.length) throw new Error(`no group matched "${groupFilter}"`);
  }

  const today = new Date().toISOString().slice(0, 10);
  const written = [];

  for (const g of groups) {
    const params = { group_id: g.id, limit: 0 };
    if (since && since !== true) params.dated_after = `${since}T00:00:00Z`;
    const expenses = (await api(token, 'get_expenses', params)).expenses
      .filter(e => !e.deleted_at);

    const items = expenses.map(e => {
      const mine = (e.users || []).find(u => u.user_id === myId);
      const myPaid = mine ? Number(mine.paid_share) : 0;
      const myOwed = mine ? Number(mine.owed_share) : 0;
      return {
        id: e.id,
        date: (e.date || '').slice(0, 10),
        description: e.description,
        cost: Number(e.cost),
        currency: e.currency_code,
        category: e.category ? e.category.name : null,
        is_payment: !!e.payment,
        my_paid: myPaid,
        my_owed: myOwed,
        my_net: +(myPaid - myOwed).toFixed(2), // + = I fronted (others owe me); - = I owe
        users: (e.users || []).map(u => ({
          name: `${u.user.first_name || ''} ${u.user.last_name || ''}`.trim(),
          user_id: u.user_id,
          paid: Number(u.paid_share),
          owed: Number(u.owed_share),
          net: +(Number(u.paid_share) - Number(u.owed_share)).toFixed(2),
        })),
      };
    });

    const payload = {
      pulled_at: new Date().toISOString(),
      group: { id: g.id, name: g.name, members: (g.members || []).map(m => ({ id: m.id, name: `${m.first_name || ''} ${m.last_name || ''}`.trim() })) },
      me: { id: myId, name: `${me.first_name} ${me.last_name}` },
      since: (since && since !== true) ? since : null,
      count: items.length,
      my_net_total: +items.reduce((s, i) => s + i.my_net, 0).toFixed(2),
      items,
    };

    const file = path.join(outDir, `${slug(g.name) || g.id}_${today}_pull.json`);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
    written.push({ name: g.name, file, count: items.length, net: payload.my_net_total });

    if (doPrint) {
      console.log(`\n=== ${g.name} (${items.length} items, my net ${c2(payload.my_net_total)}) ===`);
      for (const i of items) {
        console.log(`  ${i.date}  ${c2(i.cost).padStart(9)}  mynet ${c2(i.my_net).padStart(8)}  ${i.is_payment ? '[PAYMENT] ' : ''}${i.description}`);
      }
    }
  }

  console.log('\nWrote:');
  for (const w of written) console.log(`  ${w.file}  (${w.count} items, my net ${c2(w.net)})`);
}

main().catch(e => { console.error('ERR', e && (e.stack || e.message || e)); process.exit(1); });
