'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { statRegularFileSize } = require('../src/lib/receipt-bounded-fallback');

const contract = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures/expo-file-system-legacy-contract.json'),
  'utf8',
));

function mockLegacyFileSystem(responseByUri) {
  const calls = [];
  return {
    calls,
    fileSystem: {
      EncodingType: { Base64: 'base64' },
      async getInfoAsync(uri) {
        calls.push({ uri, argCount: arguments.length });
        return responseByUri[uri];
      },
      async readAsStringAsync() {
        throw new Error('readAsStringAsync should not be called');
      },
    },
  };
}

test('recorded legacy contract rejects unsupported size option', () => {
  assert.deepEqual(contract.getInfoAsyncSignature.unsupportedOptions, ['size']);
  assert.equal(contract.getInfoAsyncSignature.supportedOptions.includes('md5'), true);
});

for (const [label, shape] of Object.entries(contract.responses)) {
  test(`statRegularFileSize handles recorded legacy ${label} shape`, async () => {
    const uri = shape.uri ?? `file:///contract/${label}`;
    const { fileSystem, calls } = mockLegacyFileSystem({ [uri]: shape });

    if (label === 'existingFile') {
      const size = await statRegularFileSize(uri, fileSystem);
      assert.equal(size, shape.size);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].argCount, 1);
      return;
    }

    const codeByLabel = {
      missing: 'RECEIPT_IMAGE_MISSING',
      directory: 'RECEIPT_IMAGE_NOT_REGULAR',
      unknownSize: 'RECEIPT_IMAGE_SIZE_UNKNOWN',
    };
    await assert.rejects(
      statRegularFileSize(uri, fileSystem),
      (error) => error.code === codeByLabel[label],
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].argCount, 1);
  });
}

test('installed expo-file-system/legacy getInfoAsync matches recorded contract when available', () => {
  let legacy;
  try {
    legacy = require('expo-file-system/legacy');
  } catch {
    return;
  }
  assert.equal(typeof legacy.getInfoAsync, 'function');
  assert.equal(legacy.getInfoAsync.length, 2);
});
