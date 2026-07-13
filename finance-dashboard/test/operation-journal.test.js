const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OperationJournal } = require('../lib/operation-journal');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-operations-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new OperationJournal(path.join(dir, 'operations.json'));
}

test('completed operations replay one durable result', (t) => {
  const journal = fixture(t);
  const request = { method: 'POST', route: '/api/v1/transactions', body: { amount: 12.34 } };
  assert.equal(journal.start('test-operation-0001', request).existing, null);
  journal.complete('test-operation-0001', { id: 'txn-1' });

  const replay = journal.start('test-operation-0001', request).existing;
  assert.equal(replay.status, 'completed');
  assert.deepEqual(replay.result, { id: 'txn-1' });
});

test('started operation remains outcome-unknown after restart', (t) => {
  const journal = fixture(t);
  const request = { method: 'DELETE', route: '/api/v1/transactions/txn-1', body: null };
  journal.start('test-operation-0002', request);

  const restarted = new OperationJournal(journal.file);
  assert.equal(restarted.get('test-operation-0002').status, 'started');
  assert.equal(restarted.start('test-operation-0002', request).existing.status, 'started');
});

test('idempotency keys cannot be reused for different writes', (t) => {
  const journal = fixture(t);
  journal.start('test-operation-0003', { method: 'POST', route: '/a', body: { value: 1 } });
  assert.throws(
    () => journal.start('test-operation-0003', { method: 'POST', route: '/a', body: { value: 2 } }),
    (error) => error.code === 'IDEMPOTENCY_KEY_REUSED',
  );
});
