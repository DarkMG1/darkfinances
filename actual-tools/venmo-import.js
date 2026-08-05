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
const { slugForName } = require('./splitwise-lib');

const OUT_DEFAULT = process.env.VENMO_TRUTH_PATH || path.resolve(__dirname, '..', 'finance-dashboard', 'venmo-truth.json');
const r2 = (n) => +Number(n).toFixed(2);
const slugify = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const firstNameSlug = (full) => slugForName(full) || slugify(String(full || '').trim().split(/\s+/)[0] || full);
const VALUE_FLAGS = new Set(['me', 'event', 'out']);
const BOOLEAN_FLAGS = new Set(['dry', 'flip']);
const UNSAFE_MAP_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, `${file}.last-good`);
    fs.chmodSync(`${file}.last-good`, 0o600);
  }
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

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = a.slice(2, eq === -1 ? undefined : eq);
      if (!VALUE_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name)) {
        throw new Error(`Unknown option --${name || '(empty)'}`);
      }
      if (Object.hasOwn(flags, name)) throw new Error(`Option --${name} may only be specified once`);
      if (BOOLEAN_FLAGS.has(name)) {
        if (eq !== -1) throw new Error(`Option --${name} does not take a value`);
        flags[name] = true;
        continue;
      }
      let value;
      if (eq !== -1) {
        value = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next == null || next.startsWith('-')) throw new Error(`Option --${name} requires a value`);
        value = next;
        i++;
      }
      if (value === '') throw new Error(`Option --${name} requires a value`);
      flags[name] = value;
    } else {
      if (a.startsWith('-')) throw new Error(`Unknown option ${a}`);
      pos.push(a);
    }
  }
  if (pos.length !== 1) {
    throw new Error(pos.length ? 'Exactly one statement CSV is required; extra positional arguments are not allowed' : 'A statement CSV is required');
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
  if (inQ) throw new Error('CSV ended inside a quoted field');
  if (cell !== '' || row.length) { row.push(cell); if (row.some((x) => x !== '')) rows.push(row); }
  return rows;
}

function mergeEvent(existing, eventName, next) {
  const bySlug = {};
  for (const [slug, entries] of Object.entries(existing?.bySlug || {})) {
    const kept = (Array.isArray(entries) ? entries : []).filter((entry) => entry.event !== eventName);
    if (kept.length) bySlug[slug] = kept;
  }
  for (const [slug, entries] of Object.entries(next.bySlug || {})) {
    bySlug[slug] = [...(bySlug[slug] || []), ...entries];
  }
  const names = new Map();
  for (const person of existing?.people || []) names.set(person.slug, person.name);
  for (const person of next.people || []) {
    const prior = names.get(person.slug);
    if (prior && prior.toLowerCase() !== person.name.toLowerCase()) {
      throw new Error(`Venmo identity collision for #${person.slug}; add a Splitwise surname alias`);
    }
    names.set(person.slug, person.name);
  }
  const people = Object.entries(bySlug)
    .map(([slug, entries]) => ({
      slug,
      name: names.get(slug) || slug,
      owed: r2(entries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0)),
    }))
    .filter((person) => person.owed > 0.005)
    .sort((a, b) => b.owed - a.owed);
  return {
    ...(existing || {}),
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    source: 'venmo-csv',
    event: eventName,
    imports: {
      ...(existing?.imports || {}),
      [eventName]: {
        importedAt: next.generatedAt,
        sourceFile: next.sourceFile,
        settledNet: next.settledNet,
      },
    },
    bySlug,
    people,
  };
}

function parseAmount(value) {
  const raw = value == null ? '' : String(value).trim();
  if (!raw) throw new Error('Invalid Venmo amount: value is missing or blank');
  const match = raw.match(/^([+-])?\s*\$?\s*((?:(?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.\d{1,2})?|\.\d{1,2})$/);
  if (!match) throw new Error(`Invalid Venmo amount ${JSON.stringify(raw)}`);
  const amount = Number(match[2].replaceAll(',', ''));
  if (!Number.isFinite(amount)) throw new Error(`Invalid Venmo amount ${JSON.stringify(raw)}`);
  return match[1] === '-' ? -amount : amount;
}

function validateSidecar(value, label = 'Venmo sidecar', { allowNull = false } = {}) {
  const invalid = (detail) => {
    throw new Error(`${label} is invalid: ${detail}`);
  };
  const plainObject = (candidate) => (
    candidate !== null &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate) &&
    (Object.getPrototypeOf(candidate) === Object.prototype || Object.getPrototypeOf(candidate) === null)
  );
  const safeMap = (candidate, location) => {
    if (!plainObject(candidate)) invalid(`${location} must be an object`);
    for (const key of Object.keys(candidate)) {
      if (UNSAFE_MAP_KEYS.has(key)) invalid(`${location} contains unsafe key ${key}`);
    }
  };
  const money = (candidate, location, { positive = false } = {}) => {
    if (!Number.isFinite(candidate) || (positive && candidate <= 0)) {
      invalid(`${location} must be a ${positive ? 'positive ' : ''}finite number`);
    }
    if (Math.abs(candidate * 100 - Math.round(candidate * 100)) > 1e-7) {
      invalid(`${location} must use whole cents`);
    }
  };
  const optionalString = (owner, key, location, { nonempty = false, timestamp = false } = {}) => {
    if (!Object.hasOwn(owner, key)) return;
    const candidate = owner[key];
    if (typeof candidate !== 'string' || (nonempty && !candidate.trim())) {
      invalid(`${location} must be ${nonempty ? 'a nonempty string' : 'a string'}`);
    }
    if (timestamp && !Number.isFinite(Date.parse(candidate))) invalid(`${location} must be a valid timestamp`);
  };

  if (value === null && allowNull) return value;
  if (!plainObject(value)) invalid('root must be an object');
  for (const key of Object.keys(value)) {
    if (UNSAFE_MAP_KEYS.has(key)) invalid(`root contains unsafe key ${key}`);
  }
  if (value.schemaVersion !== 2) invalid('schemaVersion must be 2');
  safeMap(value.bySlug, 'bySlug');
  for (const [slug, entries] of Object.entries(value.bySlug)) {
    if (!slug.trim() || UNSAFE_MAP_KEYS.has(slug)) invalid(`bySlug contains invalid slug ${JSON.stringify(slug)}`);
    if (!Array.isArray(entries)) invalid(`bySlug.${slug} must be an array`);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!plainObject(entry)) invalid(`bySlug.${slug}[${i}] must be an object`);
      if (typeof entry.event !== 'string' || !entry.event.trim()) invalid(`bySlug.${slug}[${i}].event must be a nonempty string`);
      money(entry.amount, `bySlug.${slug}[${i}].amount`, { positive: true });
    }
  }

  optionalString(value, 'generatedAt', 'generatedAt', { timestamp: true });
  optionalString(value, 'source', 'source', { nonempty: true });
  optionalString(value, 'event', 'event', { nonempty: true });

  if (Object.hasOwn(value, 'people')) {
    if (!Array.isArray(value.people)) invalid('people must be an array');
    const seenSlugs = new Set();
    for (let i = 0; i < value.people.length; i++) {
      const person = value.people[i];
      if (!plainObject(person)) invalid(`people[${i}] must be an object`);
      if (typeof person.slug !== 'string' || !person.slug.trim() || UNSAFE_MAP_KEYS.has(person.slug)) {
        invalid(`people[${i}].slug must be a safe nonempty string`);
      }
      if (seenSlugs.has(person.slug)) invalid(`people contains duplicate slug ${person.slug}`);
      seenSlugs.add(person.slug);
      if (typeof person.name !== 'string' || !person.name.trim()) invalid(`people[${i}].name must be a nonempty string`);
      money(person.owed, `people[${i}].owed`, { positive: true });
    }
  }

  if (Object.hasOwn(value, 'imports')) {
    safeMap(value.imports, 'imports');
    for (const [event, record] of Object.entries(value.imports)) {
      if (!event.trim() || UNSAFE_MAP_KEYS.has(event)) invalid(`imports contains invalid event ${JSON.stringify(event)}`);
      if (!plainObject(record)) invalid(`imports.${event} must be an object`);
      optionalString(record, 'importedAt', `imports.${event}.importedAt`, { timestamp: true });
      optionalString(record, 'sourceFile', `imports.${event}.sourceFile`, { nonempty: true });
      if (Object.hasOwn(record, 'settledNet')) {
        safeMap(record.settledNet, `imports.${event}.settledNet`);
        for (const [slug, amount] of Object.entries(record.settledNet)) {
          if (!slug.trim() || UNSAFE_MAP_KEYS.has(slug)) invalid(`imports.${event}.settledNet contains invalid slug ${JSON.stringify(slug)}`);
          money(amount, `imports.${event}.settledNet.${slug}`);
        }
      }
    }
  }
  return value;
}

function main() {
  const { flags, pos } = parseArgs(process.argv.slice(2));
  const file = pos[0];
  const me = flags.me ? String(flags.me).trim() : '';
  if (!me) throw new Error('Option --me requires a nonempty value');
  const text = fs.readFileSync(path.resolve(file), 'utf8');
  const rows = parseCsv(text);

  // Find the header row (Venmo prefixes a few account-summary lines first).
  const headerIdx = rows.findIndex((r) => r.some((c) => /datetime/i.test(c)) && r.some((c) => /amount\s*\(total\)/i.test(c)));
  if (headerIdx === -1) throw new Error('Could not find the Venmo column header row (need "Datetime" and "Amount (total)").');
  const header = rows[headerIdx].map((h) => h.trim().toLowerCase());
  const col = (re) => header.findIndex((h) => re.test(h));
  const idx = {
    id: col(/^(?:transaction[\s_-]*)?id$/),
    type: col(/^type$/), status: col(/^status$/), note: col(/^note$/),
    from: col(/^from$/), to: col(/^to$/), amount: col(/amount\s*\(total\)/),
    datetime: col(/datetime/),
  };
  for (const key of ['type', 'status', 'from', 'to', 'amount']) {
    if (idx[key] < 0) throw new Error(`Venmo CSV is missing the ${key} column`);
  }

  const meNorm = me.trim().toLowerCase();
  const isMe = (name) => (name || '').trim().toLowerCase() === meNorm;
  const flip = !!flags.flip;

  const owed = {};      // slug -> { name, amount }
  const settled = {};   // slug -> net completed (info only)
  let pendingCount = 0;
  const rowsById = new Map();
  const idlessRelevantRows = new Set();

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const rowNumber = i + 1;
    const type = (r[idx.type] || '').trim();
    const status = (r[idx.status] || '').trim();
    const note = (r[idx.note] || '').trim();
    let from = (r[idx.from] || '').trim();
    let to = (r[idx.to] || '').trim();
    const transactionId = idx.id >= 0 ? (r[idx.id] || '').trim() : '';
    const rowSignature = JSON.stringify(r);
    if (transactionId) {
      if (rowsById.has(transactionId)) {
        if (rowsById.get(transactionId) === rowSignature) {
          throw new Error(`Duplicate Venmo transaction ID ${transactionId} on CSV row ${rowNumber}`);
        }
        throw new Error(`Conflicting Venmo rows for transaction ID ${transactionId} on CSV row ${rowNumber}`);
      }
      rowsById.set(transactionId, rowSignature);
    }
    if (!type) continue;
    if (flip) { const t = from; from = to; to = t; }

    const isCharge = /charge/i.test(type);
    const isPending = /pending|incomplete/i.test(status);
    const isComplete = /complete/i.test(status) && !isPending;
    const pendingCharge = isCharge && isPending && isMe(to) && !isMe(from);
    const completedOther = isComplete ? (isMe(from) ? to : (isMe(to) ? from : '')) : '';
    if (!pendingCharge && !completedOther) continue;
    if (idx.id >= 0 && !transactionId) {
      throw new Error(`Relevant Venmo row ${rowNumber} is missing a transaction ID`);
    }
    const rawAmount = r[idx.amount];
    let amount;
    try {
      amount = Math.abs(parseAmount(rawAmount));
    } catch (error) {
      throw new Error(`CSV row ${rowNumber}: ${error.message}`);
    }
    if (amount === 0) {
      throw new Error(`CSV row ${rowNumber}: relevant Venmo amount must be non-zero`);
    }
    if (idx.id < 0) {
      if (idlessRelevantRows.has(rowSignature)) {
        throw new Error(`Ambiguous duplicate relevant Venmo row ${rowNumber}; export a transaction ID column`);
      }
      idlessRelevantRows.add(rowSignature);
    }

    // The durable debt: a pending charge I requested (To == me) => From owes me.
    if (pendingCharge) {
      const slug = firstNameSlug(from);
      if (!slug) continue;
      owed[slug] = owed[slug] || { name: from, amount: 0 };
      if (owed[slug].name.toLowerCase() !== from.toLowerCase()) {
        throw new Error(`Venmo identity collision for #${slug}; add a Splitwise surname alias`);
      }
      owed[slug].amount = r2(owed[slug].amount + amount);
      pendingCount++;
    } else {
      // Completed flow, info-only net per counterparty (from my perspective).
      const slug = firstNameSlug(completedOther);
      settled[slug] = r2((settled[slug] || 0) + (isMe(to) ? amount : -amount));
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
  const outPath = flags.out ? String(flags.out) : OUT_DEFAULT;
  let existing = null;
  try {
    existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Could not load existing Venmo sidecar: ${error.message}`);
  }
  validateSidecar(existing, 'Existing Venmo sidecar', { allowNull: true });
  const nextSidecar = mergeEvent(existing, eventName, out);
  validateSidecar(nextSidecar, 'Next Venmo sidecar');
  writeJsonAtomic(outPath, nextSidecar);
  console.log(`\nWrote ${outPath}. Run a dashboard refresh to merge into Who Owes Me.`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Venmo import failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { mergeEvent, parseAmount, parseArgs, parseCsv, validateSidecar };
