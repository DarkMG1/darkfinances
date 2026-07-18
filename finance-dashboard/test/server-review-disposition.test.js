'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const server = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
const types = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'api', 'generated', 'types.ts'),
  'utf8',
);

test('review disposition admission runs before applyLocal inside projection lane', () => {
  assert.match(server, /prepareReviewDispositionAdmission/);
  assert.match(server, /commitReviewDisposition/);
  assert.match(server, /runActualProjectionMutation\(async \(\) => \{[\s\S]*prepareReviewDispositionAdmission[\s\S]*commitReviewDisposition/);
});

test('review GET persists snooze cleanup on write lane, not inside cached read', () => {
  assert.match(server, /loadReviewInbox/);
  assert.match(server, /persistReviewStateMaintenance/);
  assert.match(server, /actualCoordinator\.runWrite/);
  assert.match(server, /publicReviewInbox/);
  assert.doesNotMatch(server, /delete state\.dispositions\[task\.id\]/);
});

test('review disposition validation accepts optional contentHash', () => {
  const validation = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'validation.js'), 'utf8');
  assert.match(validation, /contentHash: z\.string\(\)\.regex/);
});

test('generated ReviewTask includes fingerprint fields', () => {
  assert.match(types, /contentHash: string;/);
  assert.match(types, /stableKey: string;/);
  assert.match(types, /contentVersion: number;/);
});
