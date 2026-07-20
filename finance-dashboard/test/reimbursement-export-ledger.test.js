'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  assertExportConservation,
  buildReimbursementExportV1Envelope,
  buildTrustedAllocationIndex,
  collectLeakedAuthoritativeCents,
  csvEscape,
  digestStableJson,
  exportExitCode,
  finalizeExportPayload,
  formatReimbursementExportCsv,
  formatReimbursementExportHuman,
  MAX_EXPORT_LINKS,
  MAX_SNAPSHOT_ATTEMPTS,
  prepareExportForPublish,
  projectAllocationLedger,
  redactExportPayload,
  sanitizeHumanText,
  stableStringify,
  withholdAuthoritativeNumbers,
} = require('../lib/reimbursement-export-ledger');
const {
  ExportSourceChangedError,
  ReimbursementExportIncompleteError,
  summarizeExportIncompleteForError,
} = require('../lib/reimbursement-export-common');
const { apiErrorBody } = require('../lib/request-envelope');
const {
  acquireExportSnapshotLock,
  assertExportLockAvailable,
  sidecarSnapshotDigest,
} = require('../lib/reimbursement-export-snapshot');
const { writePrivateFileAtomic, assertSafeOutputTarget } = require('../lib/private-durable-io');

const REIMB_CATEGORY = 'cat-reimb';

function assertNoLeakedAuthoritativeCents(payload, label = 'payload') {
  const leaks = collectLeakedAuthoritativeCents(payload);
  assert.equal(leaks.length, 0, `${label} leaked authoritative cents: ${JSON.stringify(leaks)}`);
}

function assertCsvWithholdsCents(csv) {
  const dataLines = csv.split('\n').filter((line) => line && !line.startsWith('#'));
  const header = dataLines[0].split(',');
  const centColumns = new Set([
    'allocationCents',
    'inflowAmountCents',
    'expenseAmountCents',
    'inflowGlobalRemainingTrustedCents',
    'expenseGlobalRemainingTrustedCents',
    'inflowWindowAllocatedTrustedCents',
    'expenseWindowAllocatedTrustedCents',
  ].map((name) => header.indexOf(name)).filter((index) => index >= 0));
  for (const line of dataLines.slice(1)) {
    if (!line.trim()) continue;
    const cells = line.split(',');
    for (const index of centColumns) {
      assert.equal(cells[index] ?? '', '', `CSV leaked cents in column ${header[index]}: ${line}`);
    }
  }
}

function assertHumanWithholdsCents(human) {
  assert.doesNotMatch(human, /\$\d+\.\d{2}/, 'human output leaked dollar amounts');
}

function assertPublishedFormatsWithholdCents(payload, label) {
  assertNoLeakedAuthoritativeCents(payload, `${label} json`);
  assertNoLeakedAuthoritativeCents(JSON.parse(stableStringify(payload)), `${label} stable json`);
  assertCsvWithholdsCents(formatReimbursementExportCsv(payload));
  assertHumanWithholdsCents(formatReimbursementExportHuman(payload));
}

function incompleteFixture(kind) {
  const baseLinks = [explicitLink({ inflowId: 'in1', expenseId: 'ex1', cents: 4321, inflowCapCents: 5000, expenseCapCents: 5000 })];
  const liveById = {
    in1: live('in1', 5000),
    ex1: live('ex1', -5000, '2026-07-02', REIMB_CATEGORY),
  };
  if (kind === 'legacy') {
    return projectAllocationLedger({
      links: [{ inflow: { id: 'in1' }, expense: { id: 'ex1' }, amount: null }],
      liveById,
      activeSagas: [],
      reimbCategoryId: REIMB_CATEGORY,
    });
  }
  if (kind === 'orphan') {
    return projectAllocationLedger({
      links: baseLinks,
      liveById: { in1: live('in1', 5000) },
      activeSagas: [],
      reimbCategoryId: REIMB_CATEGORY,
    });
  }
  if (kind === 'saga') {
    return projectAllocationLedger({
      links: baseLinks,
      liveById,
      activeSagas: [{ id: 's1', phase: 'prepared', action: 'link', inflowId: 'in1', expenseId: 'ex2', terminal: false }],
      reimbCategoryId: REIMB_CATEGORY,
    });
  }
  throw new Error(`unknown incomplete fixture: ${kind}`);
}

function live(id, amountCents, date = '2026-07-01', category = null) {
  return {
    id,
    date,
    payee: id,
    amountCents,
    accountId: 'checking',
    accountName: 'checking',
    category,
  };
}

function explicitLink({
  inflowId,
  expenseId,
  cents,
  inflowCapCents = 5000,
  expenseCapCents = 5000,
  inflowDate = '2026-07-01',
  expenseDate = '2026-07-02',
  person = null,
  version = 1,
  expenseCategoryId = REIMB_CATEGORY,
}) {
  return {
    linkKey: `${inflowId}:${expenseId}`,
    inflow: {
      id: inflowId,
      date: inflowDate,
      payee: 'In',
      amount: inflowCapCents / 100,
      accountId: 'checking',
      account: 'checking',
    },
    expense: {
      id: expenseId,
      date: expenseDate,
      payee: 'Ex',
      amount: -(expenseCapCents / 100),
      accountId: 'checking',
      account: 'checking',
      categoryId: expenseCategoryId,
    },
    allocationCents: cents,
    amount: cents / 100,
    person,
    version,
  };
}

test('PR-25 matrix: partial, one-to-many, many-to-one conserve cents', () => {
  const links = [
    explicitLink({ inflowId: 'in1', expenseId: 'ex1', cents: 3000, inflowCapCents: 5000, expenseCapCents: 10000 }),
    explicitLink({ inflowId: 'in1', expenseId: 'ex2', cents: 2000, inflowCapCents: 5000, expenseCapCents: 2000 }),
    explicitLink({ inflowId: 'in2', expenseId: 'ex1', cents: 1500, inflowCapCents: 1500, expenseCapCents: 10000 }),
  ];
  const liveById = {
    in1: live('in1', 5000),
    in2: live('in2', 1500),
    ex1: live('ex1', -10000, '2026-07-02', REIMB_CATEGORY),
    ex2: live('ex2', -2000, '2026-07-02', REIMB_CATEGORY),
  };
  const payload = projectAllocationLedger({ links, liveById, activeSagas: [], reimbCategoryId: REIMB_CATEGORY });
  assert.equal(payload.completeness.status, 'complete');
  assert.equal(payload.totals.trustedAllocationCents, 6500);
  assert.equal(payload.endpoints.in1.global.remainingTrustedCents, 0);
  assert.equal(payload.endpoints.ex1.global.remainingTrustedCents, 5500);
  assertExportConservation(payload);
});

test('categorized reimbursement endpoints stay complete without fingerprint false positive', () => {
  const links = [explicitLink({ inflowId: 'in1', expenseId: 'ex1', cents: 1000, inflowCapCents: 1000, expenseCapCents: 1000 })];
  const payload = projectAllocationLedger({
    links,
    liveById: {
      in1: live('in1', 1000, '2026-07-01'),
      ex1: live('ex1', -1000, '2026-07-02', REIMB_CATEGORY),
    },
    activeSagas: [],
    reimbCategoryId: REIMB_CATEGORY,
  });
  assert.equal(payload.completeness.status, 'complete');
  assert.equal(payload.links[0].eligibilityMismatch, false);
  assert.equal(payload.links[0].identityMismatch, false);
});

test('category drift marks incomplete without identity mismatch', () => {
  const links = [explicitLink({ inflowId: 'in1', expenseId: 'ex1', cents: 1000, inflowCapCents: 1000, expenseCapCents: 1000 })];
  const payload = projectAllocationLedger({
    links,
    liveById: {
      in1: live('in1', 1000),
      ex1: live('ex1', -1000, '2026-07-02', 'other-category'),
    },
    activeSagas: [],
    reimbCategoryId: REIMB_CATEGORY,
  });
  assert.equal(payload.completeness.status, 'incomplete');
  assert.match(payload.completeness.reasons.map((r) => r.code).join(','), /endpoint_reimbursement_ineligible/);
});

test('legacy null amount stays ambiguous with null authoritative totals', () => {
  const links = [{
    inflow: { id: 'in1' },
    expense: { id: 'ex1' },
    amount: null,
  }];
  const payload = prepareExportForPublish(projectAllocationLedger({
    links,
    liveById: { in1: live('in1', 5000), ex1: live('ex1', -5000, '2026-07-02', REIMB_CATEGORY) },
    activeSagas: [],
    reimbCategoryId: REIMB_CATEGORY,
  }));
  assert.equal(payload.completeness.status, 'incomplete');
  assert.equal(payload.totals.trustedAllocationCents, null);
  assert.equal(payload.scopes.global.totals.trustedAllocationCents, null);
  assert.equal(payload.people.every((row) => row.allocatedTrustedCents == null), true);
  assert.equal(payload.totals.authoritative, false);
  assert.equal(payload.links[0].allocationCents, null);
  assert.equal(exportExitCode(payload), 2);
});

test('orphaned endpoints mark incomplete and withhold subsidiary numbers', () => {
  const links = [explicitLink({ inflowId: 'in1', expenseId: 'ex1', cents: 1000 })];
  const payload = withholdAuthoritativeNumbers(projectAllocationLedger({
    links,
    liveById: { in1: live('in1', 5000) },
    activeSagas: [],
    reimbCategoryId: REIMB_CATEGORY,
  }));
  assert.equal(payload.links[0].expenseOrphan, true);
  assert.equal(payload.completeness.status, 'incomplete');
  assert.equal(payload.endpoints.in1.global.remainingTrustedCents, null);
  assert.equal(payload.scopes.global.links[0].allocationCents, null);
  assert.equal(payload.scopes.global.links[0].expense?.amountCents, null);
  assert.equal(payload.totals.authoritative, false);
  assertPublishedFormatsWithholdCents(payload, 'orphan');
});

test('active reimbursement saga marks export incomplete', () => {
  const links = [explicitLink({ inflowId: 'in1', expenseId: 'ex1', cents: 1000 })];
  const payload = projectAllocationLedger({
    links,
    liveById: { in1: live('in1', 5000), ex1: live('ex1', -5000, '2026-07-02', REIMB_CATEGORY) },
    activeSagas: [{ id: 's1', phase: 'prepared', action: 'link', inflowId: 'in1', expenseId: 'ex2', terminal: false }],
    reimbCategoryId: REIMB_CATEGORY,
  });
  assert.match(payload.completeness.reasons.map((r) => r.code).join(','), /active_reimbursement_link_saga/);
  assert.equal(finalizeExportPayload(payload).totals.trustedAllocationCents, null);
});

test('window scope keeps global remaining separate from window allocation', () => {
  const links = [
    explicitLink({ inflowId: 'in1', expenseId: 'ex1', cents: 1000 }),
    explicitLink({
      inflowId: 'in2',
      expenseId: 'ex2',
      cents: 2000,
      inflowCapCents: 5000,
      expenseCapCents: 5000,
      inflowDate: '2026-08-01',
      expenseDate: '2026-08-02',
    }),
  ];
  const payload = projectAllocationLedger({
    links,
    liveById: {
      in1: live('in1', 5000, '2026-07-01'),
      ex1: live('ex1', -5000, '2026-07-02', REIMB_CATEGORY),
      in2: live('in2', 5000, '2026-08-01'),
      ex2: live('ex2', -5000, '2026-08-02', REIMB_CATEGORY),
    },
    activeSagas: [],
    window: { from: '2026-07-01', to: '2026-07-31' },
    reimbCategoryId: REIMB_CATEGORY,
  });
  assert.equal(payload.links.length, 1);
  assert.equal(payload.scopes.window.totals.trustedAllocationCents, 1000);
  assert.equal(payload.scopes.global.totals.trustedAllocationCents, 3000);
  assert.equal(payload.endpoints.in1.window.allocatedTrustedCents, 1000);
  assert.equal(payload.endpoints.in1.global.allocatedTrustedCents, 1000);
  assert.equal(payload.endpoints.in2.global.remainingTrustedCents, 3000);
  assertExportConservation(payload);
});

test('production finalize asserts conservation before publish', () => {
  const payload = projectAllocationLedger({
    links: [explicitLink({ inflowId: 'in1', expenseId: 'ex1', cents: 1000, inflowCapCents: 1000, expenseCapCents: 1000 })],
    liveById: {
      in1: live('in1', 1000),
      ex1: live('ex1', -1000, '2026-07-02', REIMB_CATEGORY),
    },
    activeSagas: [],
    reimbCategoryId: REIMB_CATEGORY,
  });
  payload.endpoints.ex1.global.remainingTrustedCents = 999;
  assert.throws(() => finalizeExportPayload(payload), /global remaining mismatch/);
});

test('sidecar digest changes when links revision changes', () => {
  const links = [explicitLink({ inflowId: 'in1', expenseId: 'ex1', cents: 1000 })];
  const a = sidecarSnapshotDigest({ linksRevision: 1, links, activeSagas: [] });
  const b = sidecarSnapshotDigest({ linksRevision: 2, links, activeSagas: [] });
  assert.notEqual(a, b);
});

test('export lock blocks link writes and clears for export snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reimb-export-lock-'));
  const linksPath = path.join(dir, 'reimb-links.json');
  fs.writeFileSync(linksPath, JSON.stringify({ schemaVersion: 2, revision: 3, links: [] }));
  const lock = acquireExportSnapshotLock(linksPath, 3);
  assert.throws(() => assertExportLockAvailable(linksPath), ExportSourceChangedError);
  lock.release();
  assert.doesNotThrow(() => assertExportLockAvailable(linksPath));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('retry exhaustion uses exactly four ExportSourceChangedError attempts', async () => {
  const { getActualCoordinator, resetActualCoordinator } = require('../lib/actual-coordinator');
  resetActualCoordinator('reimb-export-barrier');
  const coordinator = getActualCoordinator();
  let caught = 0;
  for (let i = 1; i <= MAX_SNAPSHOT_ATTEMPTS; i += 1) {
    const captureGeneration = coordinator.generation;
    coordinator.invalidateGeneration();
    try {
      if (coordinator.generation !== captureGeneration) throw new ExportSourceChangedError();
      assert.fail('expected generation mismatch');
    } catch (error) {
      if (error instanceof ExportSourceChangedError) caught += 1;
      else throw error;
    }
  }
  assert.equal(caught, MAX_SNAPSHOT_ATTEMPTS);
});

test('private durable writer rejects symlink and hardlink targets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reimb-export-io-'));
  const target = path.join(dir, 'out.json');
  fs.writeFileSync(target, '{}');
  const symlink = path.join(dir, 'link.json');
  fs.symlinkSync(target, symlink);
  assert.throws(() => assertSafeOutputTarget(symlink), /symbolic link/);
  const hardlink = path.join(dir, 'hard.json');
  fs.linkSync(target, hardlink);
  assert.throws(() => assertSafeOutputTarget(hardlink), /hard link/);
  writePrivateFileAtomic(path.join(dir, 'good.json'), '{"ok":true}\n');
  assert.equal(fs.readFileSync(path.join(dir, 'good.json'), 'utf8'), '{"ok":true}\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CSV escapes tabs, CR, and formula injection', () => {
  const payload = projectAllocationLedger({
    links: [explicitLink({
      inflowId: 'in1',
      expenseId: 'ex1',
      cents: 100,
      inflowCapCents: 100,
      expenseCapCents: 100,
      person: 'tab\there',
    })],
    liveById: {
      in1: { ...live('in1', 100), payee: 'Line1\nLine2' },
      ex1: { ...live('ex1', -100, '2026-07-02', REIMB_CATEGORY), payee: '正常' },
    },
    activeSagas: [],
    reimbCategoryId: REIMB_CATEGORY,
    generatedAt: '2026-07-01T00:00:00.000Z',
  });
  const csv = formatReimbursementExportCsv(payload);
  assert.match(csv, /"tab\there"/);
  assert.equal(csvEscape('=SUM(1+1)'), "'=SUM(1+1)");
  assert.match(csvEscape('a\tb'), /"\s*a\tb\s*"/);
});

test('human output sanitizes ANSI, bidi, and control characters', () => {
  const dirty = `${String.fromCharCode(27)}[31mRed${String.fromCharCode(27)}[0m \u202eRTL\u202c ${String.fromCharCode(7)}bell`;
  const clean = sanitizeHumanText(dirty);
  assert.doesNotMatch(clean, new RegExp(String.fromCharCode(27)));
  assert.doesNotMatch(clean, /[\u202a-\u202e\u2066-\u2069]/);
  assert.doesNotMatch(clean, new RegExp(String.fromCharCode(7)));
});

test('redactExportPayload removes secret-like fields deeply', () => {
  const payload = redactExportPayload({
    schemaVersion: 1,
    secrets: { token: 'x' },
    receiptBytes: Buffer.from('abc'),
    nested: { password: 'nope', ok: 'yes' },
    links: [],
  });
  assert.equal(payload.secrets, undefined);
  assert.equal(payload.receiptBytes, undefined);
  assert.equal(payload.nested.password, undefined);
  assert.equal(payload.nested.ok, 'yes');
});

test('canonical stable JSON bytes are deterministic', () => {
  const links = [explicitLink({ inflowId: 'in1', expenseId: 'ex1', cents: 1234, person: 'alex' })];
  const liveById = {
    in1: live('in1', 5000),
    ex1: live('ex1', -5000, '2026-07-02', REIMB_CATEGORY),
  };
  const a = prepareExportForPublish(projectAllocationLedger({
    links,
    liveById,
    activeSagas: [],
    reimbCategoryId: REIMB_CATEGORY,
    generatedAt: '2026-07-01T00:00:00.000Z',
  }));
  const b = prepareExportForPublish(projectAllocationLedger({
    links,
    liveById,
    activeSagas: [],
    reimbCategoryId: REIMB_CATEGORY,
    generatedAt: '2026-07-01T00:00:00.000Z',
  }));
  assert.equal(digestStableJson(a), digestStableJson(b));
  assert.equal(stableStringify(a), stableStringify(b));
});

test('malformed export input bounds fail closed', () => {
  const links = Array.from({ length: MAX_EXPORT_LINKS + 1 }, (_, i) => explicitLink({
    inflowId: `in${i}`,
    expenseId: `ex${i}`,
    cents: 1,
    inflowCapCents: 1,
    expenseCapCents: 1,
  }));
  assert.throws(
    () => projectAllocationLedger({ links, liveById: {}, activeSagas: [] }),
    /link count exceeds maximum/,
  );
});

test('buildTrustedAllocationIndex matches ledger cents', () => {
  const links = [
    explicitLink({ inflowId: 'in1', expenseId: 'ex1', cents: 2500 }),
    explicitLink({ inflowId: 'in2', expenseId: 'ex1', cents: 1500 }),
  ];
  const index = buildTrustedAllocationIndex(links);
  assert.equal(index.byExpense.ex1, 4000);
  assert.equal(index.byInflow.in1, 2500);
  assert.equal(index.paymentsByExpense.ex1.length, 2);
});

test('generated contract types include export scopes, endpoints, and provenance', () => {
  const types = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'api', 'generated', 'types.ts'), 'utf8');
  assert.match(types, /ReimbursementExportEndpoint/);
  assert.match(types, /ReimbursementExportProvenance/);
  assert.match(types, /incompleteSections/);
  assert.match(types, /scopes:/);
});

test('two-process export lock prevents concurrent snapshot writer takeover', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reimb-export-2p-'));
  const linksPath = path.join(dir, 'reimb-links.json');
  fs.writeFileSync(linksPath, JSON.stringify({ schemaVersion: 2, revision: 1, links: [] }));
  const lock = acquireExportSnapshotLock(linksPath, 1);
  const script = `
    const { acquireExportSnapshotLock } = require(${JSON.stringify(path.resolve(__dirname, '../lib/reimbursement-export-snapshot.js'))});
    const { ExportSourceChangedError } = require(${JSON.stringify(path.resolve(__dirname, '../lib/reimbursement-export-common.js'))});
    try {
      acquireExportSnapshotLock(${JSON.stringify(linksPath)}, 1, { timeoutMs: 200 });
      process.exit(2);
    } catch (error) {
      process.exit(error instanceof ExportSourceChangedError ? 0 : 1);
    }
  `;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  lock.release();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('deep withhold clears authoritative cents in all link copies and scopes', () => {
  const raw = projectAllocationLedger({
    links: [
      explicitLink({ inflowId: 'in1', expenseId: 'ex1', cents: 1000 }),
      explicitLink({
        inflowId: 'in2',
        expenseId: 'ex2',
        cents: 2000,
        inflowCapCents: 5000,
        expenseCapCents: 5000,
        inflowDate: '2026-08-01',
        expenseDate: '2026-08-02',
      }),
    ],
    liveById: {
      in1: live('in1', 5000, '2026-07-01'),
      ex1: live('ex1', -5000, '2026-07-02', REIMB_CATEGORY),
      in2: live('in2', 5000, '2026-08-01'),
      ex2: live('ex2', -5000, '2026-08-02', REIMB_CATEGORY),
    },
    activeSagas: [{ id: 's1', phase: 'prepared', action: 'link', terminal: false }],
    window: { from: '2026-07-01', to: '2026-07-31' },
    reimbCategoryId: REIMB_CATEGORY,
  });
  assert.ok(raw.scopes.global.links.some((row) => row.allocationCents != null));
  assert.ok(raw.scopes.window.links.some((row) => row.allocationCents != null));
  const payload = finalizeExportPayload(raw);
  assertPublishedFormatsWithholdCents(payload, 'deep-withhold');
  assert.equal(payload.scopes.global.links[0].allocationCents, null);
  assert.equal(payload.scopes.window.links[0].allocationCents, null);
});

test('legacy incomplete export leaks no authoritative cents across json csv human', () => {
  const payload = prepareExportForPublish(incompleteFixture('legacy'));
  assertPublishedFormatsWithholdCents(payload, 'legacy');
});

test('orphan incomplete export leaks no authoritative cents across json csv human', () => {
  const payload = prepareExportForPublish(incompleteFixture('orphan'));
  assertPublishedFormatsWithholdCents(payload, 'orphan');
});

test('active saga incomplete export leaks no authoritative cents across json csv human', () => {
  const payload = prepareExportForPublish(incompleteFixture('saga'));
  assertPublishedFormatsWithholdCents(payload, 'saga');
});

test('strict incomplete error exposes actionable reason codes without cent values', () => {
  const payload = finalizeExportPayload(incompleteFixture('saga'));
  const summary = summarizeExportIncompleteForError(payload);
  assert.ok(summary.incompleteReasons.includes('active_reimbursement_link_saga'));
  assert.equal(
    collectLeakedAuthoritativeCents({ incompleteReasons: summary.incompleteReasons }).length,
    0,
  );
  assert.equal(collectLeakedAuthoritativeCents({ incompleteSections: summary.incompleteSections }).length, 0);
  const error = new ReimbursementExportIncompleteError('strict export refused', summary);
  const body = apiErrorBody(error, { requestId: 'req-test' }).body;
  assert.deepEqual(body.incompleteReasons, summary.incompleteReasons);
  assert.ok(Array.isArray(body.incompleteSections));
  assert.throws(
    () => prepareExportForPublish(incompleteFixture('saga'), { strict: true }),
    ReimbursementExportIncompleteError,
  );
});

test('v1 export envelope serializes canonically and stably', () => {
  const payload = prepareExportForPublish(incompleteFixture('legacy'));
  const a = buildReimbursementExportV1Envelope(payload);
  const b = buildReimbursementExportV1Envelope(JSON.parse(a).data);
  assert.equal(a, b);
  assert.match(a, /"data":/);
  assert.match(a, /"meta":/);
});

test('export lock release rejects foreign hostname or nonce ownership', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reimb-export-owner-'));
  const linksPath = path.join(dir, 'reimb-links.json');
  fs.writeFileSync(linksPath, JSON.stringify({ schemaVersion: 2, revision: 4, links: [] }));
  const lock = acquireExportSnapshotLock(linksPath, 4);
  const lockPath = path.join(dir, 'reimb-export.lock');
  const foreign = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  foreign.hostname = 'foreign-host';
  fs.writeFileSync(lockPath, `${JSON.stringify(foreign, null, 2)}\n`);
  lock.release();
  assert.equal(fs.existsSync(lockPath), true);
  fs.unlinkSync(lockPath);
  fs.rmSync(dir, { recursive: true, force: true });
});
