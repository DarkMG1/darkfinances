'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-bounded-lists-'));
for (const [key, file] of Object.entries({
  EVENTS_PATH: 'events.json',
  RULES_PATH: 'rules.json',
  RECEIPTS_PATH: 'receipts.json',
  BULK_OPERATION_SAGAS_PATH: 'bulk-operation-sagas.json',
  TRANSACTION_SAGAS_PATH: 'transaction-sagas.json',
  TRANSACTION_DELETION_SAGAS_PATH: 'transaction-deletion-sagas.json',
  REPAYMENT_CONFIRMATION_SAGAS_PATH: 'repayment-confirmation-sagas.json',
  REIMBURSEMENT_LINK_SAGAS_PATH: 'reimbursement-link-sagas.json',
})) {
  process.env[key] = path.join(dir, file);
}
process.env.ACTUAL_DATA_DIR = path.join(dir, 'actual-cache');
process.env.ACTUAL_API_PATH = path.join(__dirname, 'fixtures', 'repayment-actual.js');

const data = require('../dataModule');

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('events are bounded, paginated, and stripped to public fields', async () => {
  const events = Array.from({ length: 105 }, (_, index) => ({
    slug: `event-${String(index).padStart(3, '0')}`,
    name: `Trip ${index}${'n'.repeat(400)}`,
    start: '2026-08-01',
    members: Array.from({ length: 105 }, (__, memberIndex) => `member-${memberIndex}${'m'.repeat(120)}`),
    group: 'g'.repeat(400),
    created: `2026-08-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
    privateField: 'must-not-leak',
  }));
  writeJson(process.env.EVENTS_PATH, { events });

  const first = await data.getEvents({ limit: 100 });
  assert.equal(first.events.length, 100);
  assert.equal(first.truncated, true);
  assert.deepEqual(first.pagination, {
    limit: 100,
    offset: 0,
    nextOffset: 100,
    complete: false,
    total: 105,
  });
  assert.ok(first.events.every((event) => event.name.length <= 300));
  assert.ok(first.events.every((event) => event.members.length === 100));
  assert.ok(first.events.every((event) => event.members.every((member) => member.length <= 100)));
  assert.ok(first.events.every((event) => event.privateField === undefined));

  const second = await data.getEvents({ limit: 100, offset: 100 });
  assert.equal(second.events.length, 5);
  assert.equal(second.pagination.complete, true);
  assert.equal(second.pagination.nextOffset, null);
});

test('rules are bounded, paginated, and stripped to public fields', () => {
  const rules = Array.from({ length: 105 }, (_, index) => ({
    id: `rule-${index}`,
    match: `merchant-${index}${'x'.repeat(400)}`,
    categoryId: `category-${index}`,
    categoryName: 'c'.repeat(400),
    created: '2026-08-01-extra',
    privateField: 'must-not-leak',
  }));
  writeJson(process.env.RULES_PATH, { rules, unknown: 'preserved-on-write' });

  const first = data.getRules({ limit: 100 });
  assert.equal(first.rules.length, 100);
  assert.equal(first.truncated, true);
  assert.equal(first.pagination.total, 105);
  assert.equal(first.pagination.nextOffset, 100);
  assert.ok(first.rules.every((rule) => rule.match.length <= 300));
  assert.ok(first.rules.every((rule) => rule.categoryName.length <= 300));
  assert.ok(first.rules.every((rule) => rule.created.length <= 10));
  assert.ok(first.rules.every((rule) => rule.privateField === undefined));

  const second = data.getRules({ limit: 100, offset: 100 });
  assert.equal(second.rules.length, 5);
  assert.equal(second.pagination.complete, true);
});

test('receipt lists omit OCR by default and tightly cap OCR pages and fields', () => {
  const receipts = Array.from({ length: 105 }, (_, index) => ({
    id: `receipt-${String(index).padStart(3, '0')}`,
    txnId: 'txn-list',
    mime: 'image/png',
    size: 100 + index,
    ocrText: index === 104 ? 't'.repeat(9_000) : `text-${index}`,
    ocrLines: index === 104
      ? Array.from({ length: 205 }, () => 'l'.repeat(1_100))
      : [`line-${index}`],
    amount: 12.34,
    date: '2026-08-01',
    source: 'camera',
    evidenceStatus: 'matched',
    uploadedAt: index === 104
      ? '9999-12-31T23:59:59.999Z'
      : `2026-08-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
    privateField: 'must-not-leak',
  }));
  writeJson(process.env.RECEIPTS_PATH, { byTxn: { 'txn-list': receipts }, hashes: {} });

  const metadataPage = data.getReceipts({ txnId: 'txn-list', limit: 100 });
  assert.equal(metadataPage.receipts.length, 100);
  assert.equal(metadataPage.truncated, true);
  assert.equal(metadataPage.ocrIncluded, false);
  assert.equal(metadataPage.pagination.total, 105);
  assert.ok(metadataPage.receipts.every((receipt) => receipt.ocrText === undefined));
  assert.ok(metadataPage.receipts.every((receipt) => receipt.ocrLines === undefined));
  assert.ok(metadataPage.receipts.every((receipt) => receipt.privateField === undefined));

  const ocrPage = data.getReceipts({ txnId: 'txn-list', limit: 100, includeOcr: true });
  assert.equal(ocrPage.receipts.length, 10);
  assert.equal(ocrPage.pagination.limit, 10);
  assert.equal(ocrPage.ocrIncluded, true);
  assert.equal(ocrPage.receipts[0].ocrText.length, 8_000);
  assert.equal(ocrPage.receipts[0].ocrLines.length, 200);
  assert.ok(ocrPage.receipts[0].ocrLines.every((line) => line.length === 1_000));
});
