const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-receipts-'));
process.env.RECEIPTS_PATH = path.join(dir, 'receipts.json');
process.env.RECEIPTS_DIR = path.join(dir, 'images');
process.env.PERSONAL_CONFIG_PATH = path.join(dir, 'personal-config.json');
const data = require('../dataModule');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const pngBytes = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('test-image-payload'),
]);

test('receipt metadata and image file commit and delete together', () => {
  const receipt = data.addReceipt({
    txnId: 'txn-1',
    imageBase64: pngBytes.toString('base64'),
    mime: 'image/png',
    source: 'camera',
  });
  assert.equal(receipt.mime, 'image/png');
  const stored = data.getReceiptFile({ id: receipt.id });
  assert.ok(stored);
  assert.equal(fs.statSync(stored.path).mode & 0o777, 0o600);
  assert.equal(data.getReceipts({ txnId: 'txn-1' }).receipts.length, 1);

  assert.deepEqual(data.deleteReceipt({ id: receipt.id }), { ok: true, removed: true });
  assert.equal(fs.existsSync(stored.path), false);
  assert.equal(data.getReceipts({ txnId: 'txn-1' }).receipts.length, 0);
});

test('receipt MIME must match the uploaded bytes', () => {
  assert.throws(
    () => data.addReceipt({
      txnId: 'txn-2',
      imageBase64: pngBytes.toString('base64'),
      mime: 'image/jpeg',
    }),
    /do not match/
  );
});

test('malformed base64 is rejected without creating an image', () => {
  assert.throws(
    () => data.addReceipt({ txnId: 'txn-3', imageBase64: 'not base64!', mime: 'image/jpeg' }),
    /invalid base64/
  );
});
