'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  assertExportConservation,
  buildTrustedAllocationIndex,
  csvEscape,
  digestStableJson,
  exportExitCode,
  formatReimbursementExportCsv,
  formatReimbursementExportHuman,
  projectAllocationLedger,
  redactExportPayload,
  stableStringify,
} = require('../lib/reimbursement-export-ledger');

function live(id, amountCents, date = '2026-07-01') {
  return {
    id,
    date,
    payee: id,
    amountCents,
    accountId: 'checking',
    accountName: 'checking',
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
    ex1: live('ex1', -10000, '2026-07-02'),
    ex2: live('ex2', -2000, '2026-07-02'),
  };
  const payload = projectAllocationLedger({ links, liveById, activeSagas: [] });
  assert.equal(payload.completeness.status, 'complete');
  assert.equal(payload.totals.trustedAllocationCents, 6500);
  assert.equal(payload.endpoints.in1.remainingTrustedCents, 0);
  assert.equal(payload.endpoints.ex1.remainingTrustedCents, 5500);
  assertExportConservation(payload);
});

test('legacy null amount stays ambiguous with null authoritative totals', () => {
  const links = [{
    inflow: { id: 'in1' },
    expense: { id: 'ex1' },
    amount: null,
  }];
  const payload = projectAllocationLedger({
    links,
    liveById: { in1: live('in1', 5000), ex1: live('ex1', -5000) },
    activeSagas: [],
  });
  assert.equal(payload.completeness.status, 'incomplete');
  assert.equal(payload.totals.trustedAllocationCents, null);
  assert.equal(payload.totals.authoritative, false);
  assert.equal(payload.links[0].allocationCents, null);
  assert.equal(exportExitCode(payload), 2);
});

test('orphaned endpoints mark incomplete and withhold totals', () => {
  const links = [explicitLink({ inflowId: 'in1', expenseId: 'ex1', cents: 1000 })];
  const payload = projectAllocationLedger({
    links,
    liveById: { in1: live('in1', 5000) },
    activeSagas: [],
  });
  assert.equal(payload.links[0].expenseOrphan, true);
  assert.equal(payload.completeness.status, 'incomplete');
  assert.equal(payload.totals.authoritative, false);
});

test('active reimbursement saga marks export incomplete', () => {
  const links = [explicitLink({ inflowId: 'in1', expenseId: 'ex1', cents: 1000 })];
  const payload = projectAllocationLedger({
    links,
    liveById: { in1: live('in1', 5000), ex1: live('ex1', -5000) },
    activeSagas: [{ id: 's1', phase: 'prepared', action: 'link', inflowId: 'in1', expenseId: 'ex2', terminal: false }],
  });
  assert.match(payload.completeness.reasons.map((r) => r.code).join(','), /active_reimbursement_link_saga/);
  assert.equal(payload.totals.authoritative, false);
});

test('zero and safe-integer boundaries on explicit allocations', () => {
  const links = [explicitLink({ inflowId: 'in1', expenseId: 'ex1', cents: 1, inflowCapCents: 1, expenseCapCents: 1 })];
  const payload = projectAllocationLedger({
    links,
    liveById: { in1: live('in1', 1, '2026-07-01'), ex1: live('ex1', -1, '2026-07-02') },
    activeSagas: [],
  });
  assert.equal(payload.totals.trustedAllocationCents, 1);
  assert.equal(payload.endpoints.in1.remainingTrustedCents, 0);
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

test('deterministic rerun produces identical digest', () => {
  const links = [explicitLink({ inflowId: 'in1', expenseId: 'ex1', cents: 1234, person: 'alex' })];
  const liveById = { in1: live('in1', 5000), ex1: live('ex1', -5000) };
  const a = projectAllocationLedger({ links, liveById, activeSagas: [], generatedAt: '2026-07-01T00:00:00.000Z' });
  const b = projectAllocationLedger({ links, liveById, activeSagas: [], generatedAt: '2026-07-01T00:00:00.000Z' });
  assert.equal(digestStableJson(a), digestStableJson(b));
  assert.equal(stableStringify(a), stableStringify(b));
});

test('CSV escapes formula injection and unicode newlines', () => {
  const links = [explicitLink({
    inflowId: 'in1',
    expenseId: 'ex1',
    cents: 100,
    inflowCapCents: 100,
    expenseCapCents: 100,
    person: '=HYPERLINK("evil")',
  })];
  const payload = projectAllocationLedger({
    links,
    liveById: {
      in1: { ...live('in1', 100), payee: 'Line1\nLine2' },
      ex1: { ...live('ex1', -100), payee: '正常' },
    },
    activeSagas: [],
    generatedAt: '2026-07-01T00:00:00.000Z',
  });
  const csv = formatReimbursementExportCsv(payload);
  assert.match(csv, /"'=HYPERLINK\(""evil""\)"/);
  assert.match(csv, /""/);
  assert.doesNotMatch(csv.split('\n').pop(), /^=HYPERLINK/);
  assert.equal(csvEscape('=SUM(1+1)'), "'=SUM(1+1)");
});

test('human report includes incomplete reasons', () => {
  const payload = projectAllocationLedger({
    links: [{ inflow: { id: 'in1' }, expense: { id: 'ex1' }, amount: null }],
    liveById: { in1: live('in1', 100), ex1: live('ex1', -100) },
    activeSagas: [],
  });
  const text = formatReimbursementExportHuman(payload);
  assert.match(text, /INCOMPLETE/);
  assert.match(text, /ambiguous/);
});

test('redactExportPayload strips secret-like fields', () => {
  const payload = redactExportPayload({
    schemaVersion: 1,
    secrets: { token: 'x' },
    receiptBytes: Buffer.from('abc'),
    links: [],
  });
  assert.equal(payload.secrets, undefined);
  assert.equal(payload.receiptBytes, undefined);
});

test('window filter excludes out-of-range links', () => {
  const links = [
    explicitLink({ inflowId: 'in1', expenseId: 'ex1', cents: 1000 }),
    explicitLink({ inflowId: 'in2', expenseId: 'ex2', cents: 2000 }),
  ];
  links[1] = explicitLink({
    inflowId: 'in2',
    expenseId: 'ex2',
    cents: 2000,
    inflowCapCents: 5000,
    expenseCapCents: 5000,
    inflowDate: '2026-08-01',
    expenseDate: '2026-08-02',
  });
  const payload = projectAllocationLedger({
    links,
    liveById: {
      in1: live('in1', 5000, '2026-07-01'),
      ex1: live('ex1', -5000, '2026-07-02'),
      in2: live('in2', 5000, '2026-08-01'),
      ex2: live('ex2', -5000, '2026-08-02'),
    },
    activeSagas: [],
    window: { from: '2026-07-01', to: '2026-07-31' },
  });
  assert.equal(payload.links.length, 1);
  assert.equal(payload.links[0].inflowId, 'in1');
});
