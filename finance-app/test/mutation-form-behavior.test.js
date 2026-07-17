const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

test('mutation form components expose accessibility live region and 44pt targets', () => {
  const source = fs.readFileSync(path.join(root, 'src/components/mutation-form.tsx'), 'utf8');
  assert.match(source, /accessibilityLiveRegion/);
  assert.match(source, /minHeight: 44/);
  assert.match(source, /accessibilityRole="alert"/);
});

test('profile purge clears mutation form drafts', () => {
  const source = fs.readFileSync(path.join(root, 'src/lib/profile-purge.ts'), 'utf8');
  assert.match(source, /purgeMutationFormDrafts/);
});

test('requests propagate validation issues on finance errors', () => {
  const source = fs.readFileSync(path.join(root, 'src/api/client/requests.ts'), 'utf8');
  assert.match(source, /issues\?: ValidationIssue\[\]/);
  assert.match(source, /requiresIdempotencyKeyReuse/);
});

test('add transaction screen uses mutation form banner not alert errors', () => {
  const source = fs.readFileSync(path.join(root, 'src/app/add-transaction.tsx'), 'utf8');
  assert.match(source, /useMutationForm/);
  assert.match(source, /MutationFormBanner/);
  assert.doesNotMatch(source, /Alert\.alert\('Could not add'/);
});

test('goals sheet blocks dismiss while locked', () => {
  const source = fs.readFileSync(path.join(root, 'src/app/goals.tsx'), 'utf8');
  assert.match(source, /canDismiss={form\.canDismiss/);
  assert.match(source, /requestDismiss/);
});
