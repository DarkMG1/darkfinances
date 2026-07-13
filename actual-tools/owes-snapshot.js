// owes-snapshot.js — write the AUTHORITATIVE "who owes me" snapshot the
// finance-dashboard reads. Per-person trip/group debts come ONLY from
// Splitwise's pairwise friend/group balance (`get_friends -> groups[].balance`).
// Do not publish reconstructed or itemized debts here; itemized expense data is
// retained only for spend-mirroring metadata and diagnostics.
//
// READ-ONLY against Splitwise; the only thing it writes is the snapshot file.
// Run via:  bash ~/actual-tools/run.sh owes-snapshot.js   (sources .splitwise.env)
// Output:   $OWES_TRUTH_PATH  (default ../finance-dashboard/owes-truth.json)

const fs = require('fs');
const path = require('path');
const sw = require(path.join(__dirname, 'splitwise-lib.js'));

const dashboardPath = (...parts) => path.resolve(__dirname, '..', 'finance-dashboard', ...parts);
const OUT = process.env.OWES_TRUTH_PATH || dashboardPath('owes-truth.json');
const EXPECTED_CURRENCY = process.env.SPLITWISE_CURRENCY || 'USD';
const r2 = (n) => +Number(n).toFixed(2);

function writeSnapshotAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const backup = `${file}.last-good`;
  try {
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, backup);
      fs.chmodSync(backup, 0o600);
    }
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

// Built-in event->Splitwise-group map, extended by any trips created in the app
// (events.json). A trip with a `group` set auto-pulls its Splitwise data here.
function loadEventMap() {
  const map = { ...sw.eventToGroup };
  const p = process.env.EVENTS_PATH || dashboardPath('events.json');
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!raw || !Array.isArray(raw.events)) throw new Error('expected an object with an events array');
    for (const e of raw.events) {
      if (e && e.slug && e.group) map[e.slug] = e.group;
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      throw new Error(`Invalid events file ${p}: ${error.message}`);
    }
  }
  return map;
}

(async () => {
  const eventMap = loadEventMap();
  const events = Object.keys(eventMap);
  const bySlug = {};        // slug -> [{ event, amount }]  (pairwise they owe me, >0) — dashboard contract
  const byEvent = {};       // event -> { name, total, owedToMe:[{name,slug,amount}] }
  const perPerson = {};     // slug -> pairwise rollup + itemized diagnostics
  const mySpendItems = [];  // [{ event, id, date, desc, category, myShare, paidByMe, payer }]
  const recon = {};         // slug -> { itemized, pairwise, diff } diagnostic log
  const failures = [];
  const groupOwner = new Map();
  let total = 0, ok = 0;

  for (const ev of events) {
    const grp = eventMap[ev];
    let pair, it = null;
    try {
      pair = await sw.getDirectOwed(grp);
    } catch (e) {
      console.error(`[owes-snapshot] ${ev} (${grp}) pairwise failed: ${e.message}`);
      failures.push({ event: ev, group: grp, stage: 'pairwise', error: e.message });
      continue;
    }
    const priorEvent = groupOwner.get(String(pair.id));
    if (priorEvent) {
      const message = `Splitwise group ${pair.id} is mapped by both ${priorEvent} and ${ev}`;
      console.error(`[owes-snapshot] ${message}`);
      failures.push({ event: ev, group: grp, stage: 'duplicate-group', error: message });
      continue;
    }
    groupOwner.set(String(pair.id), ev);
    try { it = await sw.getItemizedOwed(grp); }
    catch (e) {
      console.error(`[owes-snapshot] ${ev} (${grp}) itemized metadata failed: ${e.message}`);
      failures.push({ event: ev, group: grp, stage: 'itemized', error: e.message });
      continue;
    }
    const currencies = [pair.currency, it.currency].filter(Boolean);
    if (currencies.some((currency) => currency !== EXPECTED_CURRENCY)) {
      const message = `expected ${EXPECTED_CURRENCY}, received ${[...new Set(currencies)].join(', ')}`;
      console.error(`[owes-snapshot] ${ev} (${grp}) currency failed: ${message}`);
      failures.push({ event: ev, group: grp, stage: 'currency', error: message });
      continue;
    }
    ok++;

    const eventOwed = pair.owedToMe.map((p) => ({
      name: p.name,
      slug: (p.slug || p.name || '').toLowerCase(),
      amount: r2(p.amount),
    })).filter((p) => p.slug && p.amount > 0.005);
    for (const p of eventOwed) {
      (bySlug[p.slug] = bySlug[p.slug] || []).push({ event: ev, amount: p.amount });
      const pp = (perPerson[p.slug] = perPerson[p.slug] || { net: 0, owedToMe: 0, iOwe: 0, byEvent: [] });
      pp.net = r2(pp.net + p.amount);
      pp.owedToMe = r2(pp.owedToMe + p.amount);
      pp.byEvent.push({ event: ev, source: 'pairwise', net: p.amount, owedToMe: p.amount, iOwe: 0, items: [] });
      total += p.amount;
    }
    for (const p of pair.iOweThem || []) {
      const slug = (p.slug || p.name || '').toLowerCase();
      if (!slug) continue;
      const amt = r2(p.amount);
      const pp = (perPerson[slug] = perPerson[slug] || { net: 0, owedToMe: 0, iOwe: 0, byEvent: [] });
      pp.net = r2(pp.net - amt);
      pp.iOwe = r2(pp.iOwe + amt);
      pp.byEvent.push({ event: ev, source: 'pairwise', net: -amt, owedToMe: 0, iOwe: amt, items: [] });
    }

    if (it) {
      const pairMap = Object.fromEntries(eventOwed.map((p) => [p.slug, p.amount]));
      for (const [slug, p] of Object.entries(it.perPerson || {})) {
        const itemized = r2(Math.max(0, p.net || 0));
        const pairwise = r2(pairMap[slug] || 0);
        if (Math.abs(itemized - pairwise) > 1) {
          (recon[slug] = recon[slug] || []).push({ event: ev, itemized, pairwise, diff: r2(itemized - pairwise) });
        }
        const pp = (perPerson[slug] = perPerson[slug] || { net: 0, owedToMe: 0, iOwe: 0, byEvent: [] });
        pp.byEvent.push({ event: ev, source: 'itemized-audit', net: p.net, owedToMe: p.owedToMe, iOwe: p.iOwe, items: p.items });
      }
      for (const m of it.mySpendItems || []) mySpendItems.push({ event: ev, ...m });
    }

    eventOwed.sort((a, b) => b.amount - a.amount);
    byEvent[ev] = { name: pair.name, total: r2(eventOwed.reduce((s, x) => s + x.amount, 0)), owedToMe: eventOwed };
  }

  if (ok === 0 || failures.length || ok !== events.length) {
    throw new Error(
      `incomplete Splitwise snapshot (${ok}/${events.length} events; ${failures.length} failure(s)) — existing snapshot left untouched`
    );
  }

  // Items someone else paid but I owe a share of — these are real spending that
  // never hit my card, so Phase 3 mirrors them into Actual as my-share expenses.
  const othersPaidItems = mySpendItems.filter((m) => !m.paidByMe);

  const snap = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    source: 'splitwise-pairwise (get_friends groups.balance); itemized spend metadata only',
    manifest: {
      complete: true,
      expectedEvents: events.length,
      resolvedEvents: ok,
      failedEvents: [],
      uniqueGroupIds: [...groupOwner.keys()].sort(),
      itemizedComplete: true,
      currency: EXPECTED_CURRENCY,
    },
    events,
    bySlug,
    byEvent,
    perPerson,
    mySpendItems,
    othersPaidItems,
    reconciliation: recon,
    total: r2(total),
  };

  writeSnapshotAtomic(OUT, snap);
  const reconN = Object.keys(recon).length;
  console.log(`[owes-snapshot] wrote ${OUT} — $${snap.total} across ${Object.keys(bySlug).length} debtor(s), ${ok}/${events.length} groups, ${mySpendItems.length} my-share items (${othersPaidItems.length} others-paid)${reconN ? `, ${reconN} pairwise divergence(s) logged` : ''}`);
  if (reconN) console.log('[owes-snapshot] divergences:', JSON.stringify(recon));
})().catch((e) => {
  console.error('[owes-snapshot] fatal:', e && e.message ? e.message : e);
  process.exit(1);
});
