#!/usr/bin/env node
// venmo-import.js — turn a Venmo statement CSV into who-owes-me debts.
//
// Venmo settles instantly, so the only durable "owes me" signal in a statement is a
// CHARGE you requested that is still PENDING (they haven't paid yet). This reads the
// CSV, finds those, and writes a `venmo-truth.json` sidecar in the SAME shape as
// owes-truth.json so the dashboard merges Venmo debts into who-owes-me next refresh.
//
// Download: venmo.com -> Statement -> pick a range -> Download CSV.
//
// Usage:
//   node venmo-import.js <statement.csv> --me "Your Full Name" [--event "Trip name"] [--out <path>]
//   node venmo-import.js <statement.csv> --me "Your Name" --dry     # print, don't write
//
// Direction convention (Venmo standard): for a Charge, "To" is the requester and
// "From" is the payer. So a pending Charge with To == me means From still owes me.
// If your export uses the opposite convention, pass --flip.

const fs = require('fs');
const path = require('path');

const OUT_DEFAULT = process.env.VENMO_TRUTH_PATH || path.resolve(__dirname, '..', 'finance-dashboard', 'venmo-truth.json');
const r2 = (n) => +Number(n).toFixed(2);
const slugify = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const firstNameSlug = (full) => slugify(String(full || '').trim().split(/\s+/)[0] || full);

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else { const nx = argv[i + 1]; if (nx && !nx.startsWith('--')) { flags[a.slice(2)] = nx; i++; } else flags[a.slice(2)] = true; }
    } else pos.push(a);
  }
  return { flags, pos };
}

// Minimal RFC-4180-ish CSV: handles quoted fields, commas + newlines inside quotes,
// and "" escapes. Returns an array of rows (arrays of cell strings).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); if (row.some((x) => x !== '')) rows.push(row); }
  return rows;
}

const parseAmount = (s) => {
  const cleaned = String(s || '').replace(/[^0-9.\-]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
};

function main() {
  const { flags, pos } = parseArgs(process.argv.slice(2));
  const file = pos[0];
  const me = (flags.me && flags.me !== true) ? String(flags.me) : '';
  if (!file || !me) {
    console.error('Usage: venmo-import.js <statement.csv> --me "Your Full Name" [--event "Name"] [--flip] [--dry] [--out <path>]');
    process.exit(1);
  }
  const text = fs.readFileSync(path.resolve(file), 'utf8');
  const rows = parseCsv(text);

  // Find the header row (Venmo prefixes a few account-summary lines first).
  const headerIdx = rows.findIndex((r) => r.some((c) => /datetime/i.test(c)) && r.some((c) => /amount\s*\(total\)/i.test(c)));
  if (headerIdx === -1) { console.error('Could not find the Venmo column header row (need "Datetime" and "Amount (total)").'); process.exit(1); }
  const header = rows[headerIdx].map((h) => h.trim().toLowerCase());
  const col = (re) => header.findIndex((h) => re.test(h));
  const idx = {
    type: col(/^type$/), status: col(/^status$/), note: col(/^note$/),
    from: col(/^from$/), to: col(/^to$/), amount: col(/amount\s*\(total\)/),
    datetime: col(/datetime/),
  };

  const meNorm = me.trim().toLowerCase();
  const isMe = (name) => (name || '').trim().toLowerCase() === meNorm;
  const flip = !!flags.flip;

  const owed = {};      // slug -> { name, amount }
  const settled = {};   // slug -> net completed (info only)
  let pendingCount = 0;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const type = (r[idx.type] || '').trim();
    const status = (r[idx.status] || '').trim();
    const note = (r[idx.note] || '').trim();
    let from = (r[idx.from] || '').trim();
    let to = (r[idx.to] || '').trim();
    const amount = Math.abs(parseAmount(r[idx.amount]));
    if (!type || amount === 0) continue;
    if (flip) { const t = from; from = to; to = t; }

    const isCharge = /charge/i.test(type);
    const isPending = /pending|incomplete/i.test(status);

    // The durable debt: a pending charge I requested (To == me) => From owes me.
    if (isCharge && isPending && isMe(to) && !isMe(from)) {
      const slug = firstNameSlug(from);
      if (!slug) continue;
      owed[slug] = owed[slug] || { name: from, amount: 0 };
      owed[slug].amount = r2(owed[slug].amount + amount);
      pendingCount++;
    } else if (/complete/i.test(status)) {
      // Completed flow, info-only net per counterparty (from my perspective).
      const other = isMe(from) ? to : (isMe(to) ? from : '');
      if (other) {
        const slug = firstNameSlug(other);
        settled[slug] = r2((settled[slug] || 0) + (isMe(to) ? amount : -amount));
      }
    }
  }

  const eventName = (flags.event && flags.event !== true) ? String(flags.event) : 'Venmo';
  const bySlug = {};
  const people = [];
  for (const [slug, v] of Object.entries(owed)) {
    if (!(v.amount > 0.005)) continue;
    bySlug[slug] = [{ event: eventName, amount: v.amount }];
    people.push({ slug, name: v.name, owed: v.amount });
  }
  people.sort((a, b) => b.owed - a.owed);

  const out = {
    generatedAt: new Date().toISOString(),
    source: 'venmo-csv',
    sourceFile: path.basename(file),
    event: eventName,
    bySlug,
    people,
    settledNet: settled,
  };

  console.log(`Venmo import: ${people.length} people with pending charges (${pendingCount} charges).`);
  for (const p of people) console.log(`  ${p.name} (#${p.slug}) owes you $${p.owed.toFixed(2)}`);
  if (!people.length) console.log('  (no pending charges found — Venmo debts are only visible while a charge is unpaid)');

  if (flags.dry) { console.log('\n--dry: not writing.'); return; }
  const outPath = (flags.out && flags.out !== true) ? String(flags.out) : OUT_DEFAULT;
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nWrote ${outPath}. Run a dashboard refresh to merge into Who Owes Me.`);
}

main();
