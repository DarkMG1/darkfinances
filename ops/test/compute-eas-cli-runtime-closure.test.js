'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertBoundPublisherPlatformForClosureRegen, main } = require('../../scripts/compute-eas-cli-runtime-closure');

test('assertBoundPublisherPlatformForClosureRegen allows darwin/arm64', () => {
  assert.doesNotThrow(() => assertBoundPublisherPlatformForClosureRegen({
    platform: 'darwin',
    arch: 'arm64',
  }));
});

test('assertBoundPublisherPlatformForClosureRegen rejects non-bound platforms for regeneration', () => {
  assert.throws(
    () => assertBoundPublisherPlatformForClosureRegen({ platform: 'linux', arch: 'x64' }),
    /requires darwin\/arm64/,
  );
});

test('main rejects regeneration off bound platform', () => {
  assert.throws(
    () => main({ platform: 'linux', arch: 'x64' }),
    /requires darwin\/arm64/,
  );
});
