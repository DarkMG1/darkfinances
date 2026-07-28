'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const {
  ReceiptFileAccessError,
  ReceiptImageFormatError,
  closeReceiptFileHandle,
  createReceiptFileReadStream,
  openVerifiedReceiptFile,
  sniffReceiptImageFormat,
  verifyReceiptImageContent,
} = require('../lib/receipt-file-access');
const { startEphemeralDashboardServer } = require('./helpers/ephemeral-dashboard-server');

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

function writeReceiptStore(dir, { id = 'rcpt-test', file = 'valid.png', mime = 'image/png' } = {}) {
  const receiptsDir = path.join(dir, 'receipts');
  fs.mkdirSync(receiptsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(receiptsDir, file), PNG_BYTES, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'receipts.json'), JSON.stringify({
    byTxn: {
      'txn-1': [{
        id,
        txnId: 'txn-1',
        file,
        mime,
        size: PNG_BYTES.length,
        uploadedAt: '2026-07-13T00:00:00.000Z',
      }],
    },
  }, null, 2));
  return { receiptsDir, id };
}

function trackingReadFile(filePath) {
  let reads = 0;
  const original = fs.readFileSync;
  fs.readFileSync = (...args) => {
    if (String(args[0]) === filePath) reads += 1;
    return original(...args);
  };
  return {
    reads: () => reads,
    restore: () => {
      fs.readFileSync = original;
    },
  };
}

test('rejects symlink pointing outside receipts directory', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-receipt-outside-link-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const receiptsDir = path.join(dir, 'receipts');
  const outside = path.join(dir, 'outside-secret');
  fs.mkdirSync(receiptsDir, { recursive: true });
  fs.writeFileSync(outside, 'secret-bytes', { mode: 0o600 });
  fs.symlinkSync(outside, path.join(receiptsDir, 'escape.png'));
  const tracker = trackingReadFile(outside);
  t.after(tracker.restore);
  assert.throws(
    () => openVerifiedReceiptFile(receiptsDir, 'escape.png'),
    ReceiptFileAccessError,
  );
  assert.equal(tracker.reads(), 0);
});

test('rejects symlink inside receipts directory', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-receipt-inside-link-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const receiptsDir = path.join(dir, 'receipts');
  fs.mkdirSync(receiptsDir, { recursive: true });
  fs.writeFileSync(path.join(receiptsDir, 'real.png'), PNG_BYTES, { mode: 0o600 });
  fs.symlinkSync(path.join(receiptsDir, 'real.png'), path.join(receiptsDir, 'alias.png'));
  assert.throws(
    () => openVerifiedReceiptFile(receiptsDir, 'alias.png'),
    ReceiptFileAccessError,
  );
});

test('rejects hardlinked receipt files', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-receipt-hardlink-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const receiptsDir = path.join(dir, 'receipts');
  fs.mkdirSync(receiptsDir, { recursive: true });
  const primary = path.join(receiptsDir, 'primary.png');
  fs.writeFileSync(primary, PNG_BYTES, { mode: 0o600 });
  fs.linkSync(primary, path.join(receiptsDir, 'alias.png'));
  assert.throws(
    () => openVerifiedReceiptFile(receiptsDir, 'primary.png'),
    ReceiptFileAccessError,
  );
  assert.throws(
    () => openVerifiedReceiptFile(receiptsDir, 'alias.png'),
    ReceiptFileAccessError,
  );
});

test('rejects fifo and other non-regular files', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-receipt-fifo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const receiptsDir = path.join(dir, 'receipts');
  fs.mkdirSync(receiptsDir, { recursive: true });
  const fifoPath = path.join(receiptsDir, 'pipe.bin');
  if (typeof fs.mkfifoSync === 'function') {
    fs.mkfifoSync(fifoPath, 0o600);
    assert.throws(
      () => openVerifiedReceiptFile(receiptsDir, 'pipe.bin'),
      ReceiptFileAccessError,
    );
  } else {
    t.skip('mkfifoSync unavailable on this platform');
  }
});

test('descriptor-bound read survives post-open replacement race', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-receipt-race-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const receiptsDir = path.join(dir, 'receipts');
  fs.mkdirSync(receiptsDir, { recursive: true });
  const target = path.join(receiptsDir, 'race.png');
  fs.writeFileSync(target, PNG_BYTES, { mode: 0o600 });
  const handle = openVerifiedReceiptFile(receiptsDir, 'race.png');
  t.after(() => closeReceiptFileHandle(handle));
  fs.unlinkSync(target);
  fs.writeFileSync(path.join(dir, 'replacement-secret'), 'replacement-secret-bytes', { mode: 0o600 });
  fs.symlinkSync(path.join(dir, 'replacement-secret'), target);
  const stream = createReceiptFileReadStream(handle);
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  return new Promise((resolve, reject) => {
    stream.on('end', () => {
      try {
        assert.deepEqual(Buffer.concat(chunks), PNG_BYTES);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    stream.on('error', reject);
  });
});

test('valid image opens and streams bytes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-receipt-valid-'));
  try {
    const { receiptsDir } = writeReceiptStore(dir);
    const handle = openVerifiedReceiptFile(receiptsDir, 'valid.png');
    try {
      assert.equal(handle.size, PNG_BYTES.length);
      verifyReceiptImageContent(handle, 'image/png');
      const stream = createReceiptFileReadStream(handle);
      const body = await new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
      });
      assert.deepEqual(body, PNG_BYTES);
    } finally {
      closeReceiptFileHandle(handle);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('magic byte sniff rejects mime mismatch before streaming', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-receipt-mime-mismatch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const receiptsDir = path.join(dir, 'receipts');
  fs.mkdirSync(receiptsDir, { recursive: true });
  fs.writeFileSync(path.join(receiptsDir, 'png-as-jpeg.png'), PNG_BYTES, { mode: 0o600 });
  const handle = openVerifiedReceiptFile(receiptsDir, 'png-as-jpeg.png');
  t.after(() => closeReceiptFileHandle(handle));
  assert.throws(
    () => verifyReceiptImageContent(handle, 'image/jpeg'),
    ReceiptImageFormatError,
  );
});

test('magic byte sniff recognizes png signature', () => {
  assert.equal(sniffReceiptImageFormat(PNG_BYTES.subarray(0, 12)), 'png');
});

test('magic byte sniff reads from descriptor offset zero', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-receipt-offset-zero-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const receiptsDir = path.join(dir, 'receipts');
  fs.mkdirSync(receiptsDir, { recursive: true });
  fs.writeFileSync(path.join(receiptsDir, 'offset.png'), PNG_BYTES, { mode: 0o600 });
  const handle = openVerifiedReceiptFile(receiptsDir, 'offset.png');
  t.after(() => closeReceiptFileHandle(handle));
  verifyReceiptImageContent(handle, 'image/png');
  const stream = createReceiptFileReadStream(handle);
  const body = await new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
  assert.deepEqual(body, PNG_BYTES);
});

test('storage unavailable errors propagate instead of mapping to not found', () => {
  assert.throws(
    () => openVerifiedReceiptFile('/definitely/missing/receipts-root', 'valid.png'),
    (error) => error.code === 'RECEIPT_STORAGE_UNAVAILABLE' && error.status === 500,
  );
});

test('stream error and client abort close descriptor without reading rejected targets', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-receipt-stream-error-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const receiptsDir = path.join(dir, 'receipts');
  fs.mkdirSync(receiptsDir, { recursive: true });
  const target = path.join(receiptsDir, 'broken.png');
  fs.writeFileSync(target, PNG_BYTES, { mode: 0o600 });

  const originalCreate = fs.createReadStream;
  fs.createReadStream = (...args) => {
    const stream = originalCreate(...args);
    if (args[0] === null) {
      process.nextTick(() => stream.emit('error', new Error('injected stream failure')));
    }
    return stream;
  };
  t.after(() => {
    fs.createReadStream = originalCreate;
  });

  const handle = openVerifiedReceiptFile(receiptsDir, 'broken.png');
  const stream = createReceiptFileReadStream(handle);
  const sink = new PassThrough();
  await assert.rejects(new Promise((resolve, reject) => {
    stream.on('error', reject);
    stream.on('end', resolve);
    stream.pipe(sink);
  }), /injected stream failure/);
  closeReceiptFileHandle(handle);
  assert.equal(handle.fd, undefined);
});

test('HTTP receipt image route rejects symlink without reading secret bytes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-receipt-http-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const secret = path.join(dir, 'secret.outside');
  fs.writeFileSync(secret, 'outside-secret-bytes', { mode: 0o600 });
  const { receiptsDir, id } = writeReceiptStore(dir, { file: 'linked.png' });
  fs.unlinkSync(path.join(receiptsDir, 'linked.png'));
  fs.symlinkSync(secret, path.join(receiptsDir, 'linked.png'));
  const tracker = trackingReadFile(secret);
  t.after(tracker.restore);

  const { base } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-receipt-http-',
    extraEnvForDir: () => ({
      RECEIPTS_PATH: path.join(dir, 'receipts.json'),
      RECEIPTS_DIR: receiptsDir,
      SELFTEST: '1',
    }),
  });

  const response = await fetch(`${base}/api/v1/receipts/${id}/image`, {
    headers: { 'X-Finance-Token': 'test-api-token' },
  });
  assert.equal(response.status, 404);
  assert.equal(tracker.reads(), 0);
});

test('HTTP receipt image route returns 415 when stored MIME does not match magic bytes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-receipt-http-mismatch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { receiptsDir, id } = writeReceiptStore(dir, { file: 'mismatch.png', mime: 'image/jpeg' });
  const { base } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-receipt-http-mismatch-',
    extraEnvForDir: () => ({
      RECEIPTS_PATH: path.join(dir, 'receipts.json'),
      RECEIPTS_DIR: receiptsDir,
      SELFTEST: '1',
    }),
  });

  const response = await fetch(`${base}/api/v1/receipts/${id}/image`, {
    headers: { 'X-Finance-Token': 'test-api-token' },
  });
  assert.equal(response.status, 415);
  const body = await response.json();
  assert.equal(body.code, 'UNSUPPORTED_MEDIA_TYPE');
  assert.equal(String(JSON.stringify(body)).includes(receiptsDir), false);
});

test('HTTP receipt image route returns generic 500 when storage read fails', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-receipt-http-storage-'));
  const { receiptsDir, id } = writeReceiptStore(dir);
  fs.chmodSync(receiptsDir, 0o000);
  t.after(() => {
    try { fs.chmodSync(receiptsDir, 0o700); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });
  const { base } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-receipt-http-storage-srv-',
    extraEnvForDir: () => ({
      RECEIPTS_PATH: path.join(dir, 'receipts.json'),
      RECEIPTS_DIR: receiptsDir,
      SELFTEST: '1',
    }),
  });

  const response = await fetch(`${base}/api/v1/receipts/${id}/image`, {
    headers: { 'X-Finance-Token': 'test-api-token' },
  });
  const body = await response.json();
  assert.equal(response.status, 500);
  assert.equal(body.error, 'Request failed');
  assert.equal(body.code, 'RECEIPT_STORAGE_UNAVAILABLE');
});

test('HTTP receipt image route closes descriptors on repeated and aborted requests', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-receipt-http-fd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { receiptsDir, id } = writeReceiptStore(dir);
  const preloadBody = `
    const fs = require('fs');
    const path = require('path');
    const root = process.env.TEST_DASHBOARD_ROOT;
    const accessPath = require.resolve(path.join(root, 'lib/receipt-file-access.js'));
    const real = require(accessPath);
    const originalClose = real.closeReceiptFileHandle;
    real.closeReceiptFileHandle = function trackedClose(handle) {
      if (process.env.TEST_RECEIPT_CLOSE_MARKER) {
        fs.appendFileSync(process.env.TEST_RECEIPT_CLOSE_MARKER, 'close\\n');
      }
      return originalClose(handle);
    };
    require.cache[accessPath].exports = { ...real, closeReceiptFileHandle: real.closeReceiptFileHandle };
  `;
  const closeMarker = path.join(dir, 'close-marker.log');
  const { base } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-receipt-http-fd-',
    preloadBody,
    extraEnvForDir: () => ({
      RECEIPTS_PATH: path.join(dir, 'receipts.json'),
      RECEIPTS_DIR: receiptsDir,
      SELFTEST: '1',
      TEST_RECEIPT_CLOSE_MARKER: closeMarker,
    }),
  });

  for (let i = 0; i < 3; i += 1) {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/v1/receipts/${id}/image`, {
      headers: { 'X-Finance-Token': 'test-api-token' },
      signal: controller.signal,
    });
    if (i === 1) {
      controller.abort();
      try { await response.arrayBuffer(); } catch (_) {}
    } else {
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    }
    await waitForMarkerLines(closeMarker, i + 1);
  }
  const closes = markerLines(closeMarker);
  assert.ok(closes.length >= 3, `expected close calls, got ${closes.length}`);
});

function markerLines(file) {
  return fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    : [];
}

async function waitForMarkerLines(file, expected, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (markerLines(file).length < expected) {
    if (Date.now() >= deadline) {
      assert.fail(`timed out waiting for ${expected} close calls`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('HTTP receipt image route serves valid image with private cache headers', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-receipt-http-valid-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { receiptsDir, id } = writeReceiptStore(dir);
  const { base } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-receipt-http-valid-',
    extraEnvForDir: () => ({
      RECEIPTS_PATH: path.join(dir, 'receipts.json'),
      RECEIPTS_DIR: receiptsDir,
      SELFTEST: '1',
    }),
  });

  const response = await fetch(`${base}/api/v1/receipts/${id}/image`, {
    headers: { 'X-Finance-Token': 'test-api-token' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.match(response.headers.get('content-type') || '', /image\/png/);
  assert.equal(response.headers.get('content-length'), String(PNG_BYTES.length));
  const body = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(body, PNG_BYTES);
  assert.equal(String(body).includes('receipts/'), false);
  assert.equal(String(body).includes('account'), false);
});
