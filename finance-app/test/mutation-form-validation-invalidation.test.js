const test = require('node:test');
const assert = require('node:assert/strict');
const {
  captureValidationFieldSnapshot,
  shouldInvalidateValidationOutcome,
} = require('../src/lib/mutation-form-validation-invalidation.js');

test('captureValidationFieldSnapshot clones submitted fields', () => {
  const snapshot = captureValidationFieldSnapshot({ name: 'Draft', target: '' });
  assert.notEqual(snapshot, { name: 'Draft', target: '' });
  assert.deepEqual(snapshot, { name: 'Draft', target: '' });
});

test('shouldInvalidateValidationOutcome clears stale client validation after edits', () => {
  const snapshot = captureValidationFieldSnapshot({ name: 'Draft', target: '' });
  const outcome = { kind: 'validation', fieldErrors: { target: 'Required' } };
  assert.equal(shouldInvalidateValidationOutcome('error', outcome, { name: 'Draft', target: '' }, snapshot), false);
  assert.equal(shouldInvalidateValidationOutcome('error', outcome, { name: 'Edited', target: '' }, snapshot), true);
  assert.equal(shouldInvalidateValidationOutcome('idle', outcome, { name: 'Edited', target: '' }, snapshot), false);
  assert.equal(shouldInvalidateValidationOutcome('error', outcome, { name: 'Edited', target: '' }, null), false);
});

test('useMutationForm snapshots fields on client validation failure', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../src/hooks/useMutationForm.ts'), 'utf8');
  assert.match(source, /submittedFieldsRef\.current = captureValidationFieldSnapshot\(fields\)/);
  assert.match(source, /shouldInvalidateValidationOutcome/);
});
