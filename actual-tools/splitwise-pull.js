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
const { getToken, resolveGroup, swApi } = require('./splitwise-lib');
const EXPECTED_CURRENCY = process.env.SPLITWISE_CURRENCY || 'USD';
const MAX_EXPENSES = Number(process.env.SPLITWISE_MAX_EXPENSES || 20_000);

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return (v && !v.startsWith('--')) ? v : true;
}
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const c2 = n => (n == null ? '' : Number(n).toFixed(2));

function writeJsonAtomic(file, value) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw error;
  }
}

async function main() {
  const token = await getToken();
  const me = (await swApi(token, 'get_current_user')).user;
  const myId = me.id;

  const groupFilter = arg('--group');
  const since = arg('--since');
  const outDir = arg('--out') || path.join(os.homedir(), 'actual-tools', 'splitwise');
  const doPrint = !!arg('--print');
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(outDir, 0o700);

  let groups = (await swApi(token, 'get_groups')).groups;
  if (groupFilter && groupFilter !== true) {
    groups = [resolveGroup(groups, groupFilter)];
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const written = [];

  for (const g of groups) {
    const expenses = [];
    const pageSize = 100;
    for (let offset = 0; ; offset += pageSize) {
      const params = { group_id: g.id, limit: pageSize, offset };
      if (since && since !== true) params.dated_after = `${since}T00:00:00Z`;
      const page = (await swApi(token, 'get_expenses', params)).expenses || [];
      expenses.push(...page.filter((expense) => !expense.deleted_at));
      if (page.length < pageSize) break;
      if (expenses.length >= MAX_EXPENSES) throw new Error(`${g.name} exceeds the ${MAX_EXPENSES}-expense safety limit`);
    }
    const currencies = [...new Set(expenses.map((expense) => expense.currency_code).filter(Boolean))];
    if (currencies.length > 1 || (currencies[0] && currencies[0] !== EXPECTED_CURRENCY)) {
      throw new Error(`${g.name} currency mismatch: expected ${EXPECTED_CURRENCY}, found ${currencies.join(', ') || 'unknown'}`);
    }
    const memberById = Object.fromEntries((g.members || []).map((member) => [String(member.id), member]));

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
        users: (e.users || []).map(u => {
          const user = u.user || memberById[String(u.user_id)] || {};
          return {
          name: `${user.first_name || ''} ${user.last_name || ''}`.trim() || String(u.user_id),
          user_id: u.user_id,
          paid: Number(u.paid_share),
          owed: Number(u.owed_share),
          net: +(Number(u.paid_share) - Number(u.owed_share)).toFixed(2),
          };
        }),
      };
    });

    const payload = {
      pulled_at: new Date().toISOString(),
      group: { id: g.id, name: g.name, members: (g.members || []).map(m => ({ id: m.id, name: `${m.first_name || ''} ${m.last_name || ''}`.trim() })) },
      me: { id: myId, name: `${me.first_name} ${me.last_name}` },
      currency: EXPECTED_CURRENCY,
      since: (since && since !== true) ? since : null,
      count: items.length,
      my_net_total: +items.reduce((s, i) => s + i.my_net, 0).toFixed(2),
      items,
    };

    const file = path.join(outDir, `${slug(g.name) || g.id}_${g.id}_${stamp}_${process.pid}_pull.json`);
    writeJsonAtomic(file, payload);
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
