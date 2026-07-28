'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_MAX_ENCODED_BYTES,
  DEFAULT_MAX_SOURCE_BYTES,
  assertLocalReceiptUri,
  readBoundedFileBase64,
  statRegularFileSize,
} = require('../src/lib/receipt-bounded-fallback');
const { processReceiptAsset } = require('../src/lib/receipt-processor');

function createFileSystem(info, options = {}) {
  const reads = [];
  const statCalls = [];
  return {
    reads,
    statCalls,
    fileSystem: {
      EncodingType: { Base64: 'base64' },
      async getInfoAsync(uri) {
        statCalls.push({ uri, argCount: arguments.length });
        if (options.statThrows) throw new Error('stat unavailable');
        return info;
      },
      async readAsStringAsync(_uri, _opts) {
        reads.push('read');
        if (options.readValue != null) return options.readValue;
        throw new Error('readAsStringAsync should not be called');
      },
    },
  };
}

test('assertLocalReceiptUri accepts file:// picker URIs', () => {
  assert.doesNotThrow(() => assertLocalReceiptUri('file:///tmp/receipt.jpg'));
});

test('assertLocalReceiptUri rejects remote and non-file schemes before stat', () => {
  const cases = [
    ['https://example.com/receipt.jpg', 'RECEIPT_IMAGE_URI_NOT_LOCAL'],
    ['http://example.com/receipt.jpg', 'RECEIPT_IMAGE_URI_NOT_LOCAL'],
    ['content://media/external/images/1', 'RECEIPT_IMAGE_URI_NOT_LOCAL'],
    ['data:image/jpeg;base64,abc', 'RECEIPT_IMAGE_URI_NOT_LOCAL'],
    ['not-a-uri', 'RECEIPT_IMAGE_URI_INVALID'],
    ['', 'RECEIPT_IMAGE_URI_INVALID'],
  ];
  for (const [uri, code] of cases) {
    assert.throws(() => assertLocalReceiptUri(uri), (error) => error.code === code);
  }
});

test('statRegularFileSize rejects missing, non-regular, and unknown-size files', async () => {
  await assert.rejects(
    statRegularFileSize('file://missing', createFileSystem({ exists: false }).fileSystem),
    (error) => error.code === 'RECEIPT_IMAGE_MISSING',
  );
  await assert.rejects(
    statRegularFileSize('file://dir', createFileSystem({ exists: true, isDirectory: true, size: 10 }).fileSystem),
    (error) => error.code === 'RECEIPT_IMAGE_NOT_REGULAR',
  );
  await assert.rejects(
    statRegularFileSize('file://unknown', createFileSystem({ exists: true, isDirectory: false }).fileSystem),
    (error) => error.code === 'RECEIPT_IMAGE_SIZE_UNKNOWN',
  );
});

test('statRegularFileSize calls legacy getInfoAsync with uri only', async () => {
  const { fileSystem, statCalls } = createFileSystem({
    exists: true,
    isDirectory: false,
    size: 128,
  });
  const size = await statRegularFileSize('file:///tmp/receipt.jpg', fileSystem);
  assert.equal(size, 128);
  assert.equal(statCalls.length, 1);
  assert.equal(statCalls[0].uri, 'file:///tmp/receipt.jpg');
  assert.equal(statCalls[0].argCount, 1);
});

test('readBoundedFileBase64 rejects oversize source before base64 read', async () => {
  const { fileSystem, reads } = createFileSystem({
    exists: true,
    isDirectory: false,
    size: DEFAULT_MAX_SOURCE_BYTES + 1,
  });
  await assert.rejects(
    readBoundedFileBase64('file://big', fileSystem),
    (error) => error.code === 'RECEIPT_IMAGE_TOO_LARGE',
  );
  assert.deepEqual(reads, []);
});

test('readBoundedFileBase64 rejects oversize encoded payload after read', async () => {
  const oversized = 'A'.repeat(Math.ceil((DEFAULT_MAX_ENCODED_BYTES * 4) / 3) + 4);
  const { fileSystem, reads } = createFileSystem(
    { exists: true, isDirectory: false, size: 64 },
    { readValue: oversized },
  );
  await assert.rejects(
    readBoundedFileBase64('file://payload', fileSystem),
    (error) => error.code === 'RECEIPT_IMAGE_TOO_LARGE',
  );
  assert.deepEqual(reads, ['read']);
});

test('readBoundedFileBase64 allows small fallback payloads', async () => {
  const base64 = Buffer.from('small-receipt-bytes').toString('base64');
  const { fileSystem, reads } = createFileSystem(
    { exists: true, isDirectory: false, size: 20 },
    { readValue: base64 },
  );
  const out = await readBoundedFileBase64('file://small', fileSystem);
  assert.equal(out, base64);
  assert.deepEqual(reads, ['read']);
});

test('readBoundedFileBase64 rejects non-local URIs without stat or read', async () => {
  const { fileSystem, reads, statCalls } = createFileSystem({
    exists: true,
    isDirectory: false,
    size: 20,
  });
  await assert.rejects(
    readBoundedFileBase64('https://example.com/receipt.jpg', fileSystem),
    (error) => error.code === 'RECEIPT_IMAGE_URI_NOT_LOCAL',
  );
  assert.deepEqual(reads, []);
  assert.deepEqual(statCalls, []);
});

test('processReceiptAsset uses bounded fallback when manipulator fails', async () => {
  const base64 = Buffer.from('jpeg-fallback').toString('base64');
  const reads = [];
  const asset = {
    uri: 'file://camera-roll/receipt.jpg',
    width: 1000,
    height: 800,
    mimeType: 'image/jpeg',
  };
  const receipt = await processReceiptAsset(asset, 'camera', {
    extractOcrLines: async () => [],
    manipulateAsset: async () => {
      throw new Error('manipulator unavailable');
    },
    fileSystem: {
      EncodingType: { Base64: 'base64' },
      async getInfoAsync() {
        return { exists: true, isDirectory: false, size: 32 };
      },
      async readAsStringAsync() {
        reads.push('read');
        return base64;
      },
    },
  });
  assert.equal(receipt.base64, base64);
  assert.deepEqual(reads, ['read']);
});

test('processReceiptAsset rejects manipulator failure when stat fails', async () => {
  const reads = [];
  const asset = {
    uri: 'file://camera-roll/missing.jpg',
    width: 1000,
    height: 800,
    mimeType: 'image/jpeg',
  };
  await assert.rejects(processReceiptAsset(asset, 'library', {
    extractOcrLines: async () => [],
    manipulateAsset: async () => {
      throw new Error('manipulator unavailable');
    },
    fileSystem: {
      EncodingType: { Base64: 'base64' },
      async getInfoAsync() {
        throw new Error('stat unavailable');
      },
      async readAsStringAsync() {
        reads.push('read');
        return 'abc';
      },
    },
  }), /stat unavailable/);
  assert.deepEqual(reads, []);
});

test('processReceiptAsset rejects manipulator failure for oversize originals without upload payload', async () => {
  const reads = [];
  const asset = {
    uri: 'file://camera-roll/huge.jpg',
    width: 4000,
    height: 3000,
    mimeType: 'image/jpeg',
  };
  await assert.rejects(processReceiptAsset(asset, 'camera', {
    extractOcrLines: async () => [],
    manipulateAsset: async () => {
      throw new Error('manipulator unavailable');
    },
    fileSystem: {
      EncodingType: { Base64: 'base64' },
      async getInfoAsync() {
        return { exists: true, isDirectory: false, size: DEFAULT_MAX_SOURCE_BYTES + 1 };
      },
      async readAsStringAsync() {
        reads.push('read');
        return 'abc';
      },
    },
  }), (error) => error.code === 'RECEIPT_IMAGE_TOO_LARGE');
  assert.deepEqual(reads, []);
});

test('processReceiptAsset rejects non-local URIs on manipulator fallback without stat or read', async () => {
  const reads = [];
  const statCalls = [];
  const asset = {
    uri: 'content://media/external/images/1',
    width: 1000,
    height: 800,
    mimeType: 'image/jpeg',
  };
  await assert.rejects(processReceiptAsset(asset, 'library', {
    extractOcrLines: async () => [],
    manipulateAsset: async () => {
      throw new Error('manipulator unavailable');
    },
    fileSystem: {
      EncodingType: { Base64: 'base64' },
      async getInfoAsync(uri) {
        statCalls.push(uri);
        return { exists: true, isDirectory: false, size: 32 };
      },
      async readAsStringAsync() {
        reads.push('read');
        return 'abc';
      },
    },
  }), (error) => error.code === 'RECEIPT_IMAGE_URI_NOT_LOCAL');
  assert.deepEqual(reads, []);
  assert.deepEqual(statCalls, []);
});
