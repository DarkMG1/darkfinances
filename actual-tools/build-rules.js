// Backfill payee->category rules from history.
// DRY-RUN by default. Set CONFIRM=1 to create rules.
const api = require('@actual-app/api');
const { q, runQuery } = require('@actual-app/api');
const path = require('path');
const {
  compilePatternList,
  loadBuildRulesConfig,
} = require('./lib/operator-regex-config');
const CONFIRM = process.env.CONFIRM === '1';
const HISTORY_PAGE_SIZE = 100000;

// Payees we never want to auto-categorize (money movement / ambiguous)
const SKIP_GROUPS = new Set(['Money Movement', 'Income']);

(async () => {
  const configPath = process.env.BUILD_RULES_CONFIG_PATH || path.join(__dirname, 'build-rules-config.json');
  const config = loadBuildRulesConfig(configPath);
  const SKIP_NAMES = config.skipNames;
  const SKIP_PATTERNS = [
    /zelle/i,
    /venmo/i,
    /cash ?app/i,
    /autosave/i,
    ...compilePatternList(config.skipPatterns, { setLabel: 'skipPatterns' }),
  ];

  await api.init({ dataDir: process.env.FIX_DATA_DIR, serverURL: process.env.ACTUAL_SERVER_URL, password: process.env.ACTUAL_PASSWORD });
  await api.downloadBudget(process.env.ACTUAL_SYNC_ID);

  // category id -> {name, group}
  const groups = await api.getCategoryGroups();
  const catInfo = {};
  for (const g of groups) for (const c of (g.categories || [])) catInfo[c.id] = { name: c.name, group: g.name };

  const payees = await api.getPayees();
  const payeeName = {}; const isTransfer = {};
  for (const p of payees) { payeeName[p.id] = p.name; isTransfer[p.id] = !!p.transfer_acct; }

  // existing rules: which payees already have a rule keyed on payee
  const rules = await api.getRules();
  const rulePayees = new Set();
  for (const r of rules) for (const c of (r.conditions || [])) if (c.field === 'payee') rulePayees.add(c.value);

  // Tally all categorized, non-split, non-transfer transactions. The Actual
  // query result is bounded, so a full first page is not evidence of completion.
  // A unique ordering plus offset makes every subsequent page deterministic.
  const tally = {}; // payeeId -> {catId: count, total}
  let historyRows = 0;
  for (let offset = 0; ; offset += HISTORY_PAGE_SIZE) {
    const result = await runQuery(
      q('transactions')
        .filter({ category: { $ne: null }, is_parent: false, transfer_id: null })
        .select(['id', 'payee', 'category'])
        .orderBy({ id: 'asc' })
        .options({ splits: 'inline' })
        .limit(HISTORY_PAGE_SIZE)
        .offset(offset)
    );
    if (!Array.isArray(result?.data) || result.data.length > HISTORY_PAGE_SIZE) {
      throw new Error('Historical transaction scan was incomplete');
    }
    for (const t of result.data) {
      if (!t.payee || !t.category) continue;
      if (isTransfer[t.payee]) continue;
      const info = catInfo[t.category];
      if (!info || SKIP_GROUPS.has(info.group)) continue;
      tally[t.payee] = tally[t.payee] || { counts: {}, total: 0 };
      tally[t.payee].counts[t.category] = (tally[t.payee].counts[t.category] || 0) + 1;
      tally[t.payee].total++;
    }
    historyRows += result.data.length;
    if (result.data.length < HISTORY_PAGE_SIZE) break;
  }

  // decide dominant category per payee: >=2 txns and >=80% agreement
  const proposals = [];
  for (const [pid, t] of Object.entries(tally)) {
    if (rulePayees.has(pid)) continue; // already has a rule
    let best = null, bestN = 0;
    for (const [cid, n] of Object.entries(t.counts)) if (n > bestN) { best = cid; bestN = n; }
    if (t.total < 2) continue;
    if (bestN / t.total < 0.8) continue;
    if (SKIP_NAMES.has(payeeName[pid])) continue;
    if (SKIP_PATTERNS.some(re => re.test(payeeName[pid] || ''))) continue;
    proposals.push({ pid, name: payeeName[pid] || '(unknown)', cat: best, catName: catInfo[best].name, n: bestN, total: t.total });
  }
  proposals.sort((a, b) => b.total - a.total);

  console.log(`Scanned complete paginated history: ${historyRows} transaction(s).`);
  console.log(`Proposed ${proposals.length} payee->category rules (>=2 txns, >=80% agreement, excl. transfers/money-movement/income):\n`);
  for (const p of proposals) {
    console.log(`  ${p.name.padEnd(34)} -> ${p.catName.padEnd(13)} (${p.n}/${p.total})`);
  }

  if (CONFIRM) {
    let created = 0;
    for (const p of proposals) {
      await api.createRule({
        stage: 'pre',
        conditionsOp: 'and',
        conditions: [{ field: 'payee', op: 'is', value: p.pid }],
        actions: [{ op: 'set', field: 'category', value: p.cat }],
      });
      created++;
    }
    if (created) await api.sync();
    console.log(`\nAPPLIED — created ${created} rules.`);
  } else {
    console.log(`\nDRY-RUN — no rules created. Re-run with CONFIRM=1 to apply.`);
  }
  await api.shutdown();
})().catch(async (e) => {
  console.error('ERR', (e && e.stack) || e);
  try { await api.shutdown(); } catch (_) {}
  process.exit(1);
});
