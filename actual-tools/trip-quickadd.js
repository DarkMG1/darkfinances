#!/usr/bin/env node
// trip-quickadd.js — quick-add for trips/events. Writes the SAME
// events.json the dashboard API and owes-snapshot read, so a trip added here shows
// up in the app and (if a Splitwise group is linked) auto-pulls into who-owes-me on
// the next snapshot. No server/auth needed — it edits the sidecar file directly.
//
// Usage:
//   node trip-quickadd.js list
//   node trip-quickadd.js add "Trip 2026" [--start 2026-06-01] [--members alex,sam] [--group "Trip Group"]
//   node trip-quickadd.js rm <slug>
//
// Output file: $EVENTS_PATH (default ../finance-dashboard/events.json)

const fs = require('fs');
const path = require('path');
const { todayYMD } = require('./lib/date-only');

const EVENTS_PATH = process.env.EVENTS_PATH || path.resolve(__dirname, '..', 'finance-dashboard', 'events.json');
const slugify = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(EVENTS_PATH, 'utf8'));
    if (!raw || !Array.isArray(raw.events)) throw new Error('expected an object with an events array');
    return { events: raw.events };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { events: [] };
    throw new Error(`Refusing to replace invalid events file ${EVENTS_PATH}: ${error.message}`);
  }
}
function save(store) {
  if (!store || !Array.isArray(store.events)) throw new Error('events store is invalid');
  const dir = path.dirname(EVENTS_PATH);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(EVENTS_PATH)}.${process.pid}.${Date.now()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(store, null, 2) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, EVENTS_PATH);
    fs.chmodSync(EVENTS_PATH, 0o600);
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw error;
  }
}

// --flag value / --flag=value parsing; positionals collected separately.
function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); }
      else { const next = argv[i + 1]; if (next && !next.startsWith('--')) { flags[a.slice(2)] = next; i++; } else flags[a.slice(2)] = true; }
    } else pos.push(a);
  }
  return { flags, pos };
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parseArgs(rest);

  if (cmd === 'list' || !cmd) {
    const { events } = load();
    if (!events.length) { console.log('No trips yet.'); return; }
    for (const e of events.sort((a, b) => (b.start || '').localeCompare(a.start || ''))) {
      console.log(`#ev-${e.slug}\t${e.name}\t${e.start}\t${(e.members || []).join(',') || '-'}\t${e.group ? `SW:${e.group}` : ''}`);
    }
    return;
  }

  if (cmd === 'add') {
    const name = pos.join(' ').trim();
    if (!name) { console.error('Usage: trip-quickadd.js add "Name" [--start YYYY-MM-DD] [--members a,b] [--group "SW group"]'); process.exit(1); }
    const slug = slugify(flags.slug || name);
    if (!slug) { console.error('Could not derive a slug from the name.'); process.exit(1); }
    const store = load();
    const existing = store.events.find((e) => e.slug === slug);
    const members = String(flags.members || (existing && (existing.members || []).join(',')) || '')
      .split(/[,\n]/).map((m) => slugify(m)).filter(Boolean);
    const rec = {
      slug,
      name,
      start: flags.start || (existing && existing.start) || todayYMD(),
      members,
      group: (flags.group != null && flags.group !== true ? String(flags.group) : (existing && existing.group)) || '',
      created: (existing && existing.created) || new Date().toISOString(),
    };
    store.events = store.events.filter((e) => e.slug !== slug);
    store.events.push(rec);
    save(store);
    console.log(`${existing ? 'Updated' : 'Created'} trip "${rec.name}". Tag charges with #ev-${slug}.`);
    if (rec.group) console.log(`Linked Splitwise group "${rec.group}" — run owes-snapshot.js to pull its debts.`);
    return;
  }

  if (cmd === 'rm' || cmd === 'remove' || cmd === 'delete') {
    const slug = slugify(pos[0] || flags.slug);
    if (!slug) { console.error('Usage: trip-quickadd.js rm <slug>'); process.exit(1); }
    const store = load();
    const before = store.events.length;
    store.events = store.events.filter((e) => e.slug !== slug);
    save(store);
    console.log(before === store.events.length ? `No trip with slug "${slug}".` : `Removed trip "${slug}".`);
    return;
  }

  console.error(`Unknown command "${cmd}". Use: list | add | rm`);
  process.exit(1);
}

main();
