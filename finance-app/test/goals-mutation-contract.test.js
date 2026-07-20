const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('MutationSheet keeps sheet container non-accessible with separate backdrop', () => {
  const source = fs.readFileSync(path.join(root, 'src/components/mutation-form.tsx'), 'utf8');
  assert.match(source, /accessible=\{false\}/);
  assert.match(source, /importantForAccessibility="no"/);
  assert.match(source, /<Text testID=\{testID\} accessibilityRole="header"/);
  assert.doesNotMatch(source, /<View\s+testID=\{testID\}[\s\S]*accessibilityLabel=\{title\}/);
  assert.match(source, /accessibilityLabel="Dismiss sheet"/);
  assert.match(source, /modalDismissRegion:\s*\{\s*flex:\s*1/);
  assert.doesNotMatch(source, /modalDismissRegion:\s*\{[\s\S]*StyleSheet\.absoluteFill/);
});

test('MutationFormBanner exposes summary as accessibility label', () => {
  const source = fs.readFileSync(path.join(root, 'src/components/mutation-form.tsx'), 'utf8');
  assert.match(source, /accessibilityLabel=\{outcome\.summary\}/);
  assert.match(source, /accessibilityLiveRegion="polite"/);
});

test('goals uses distinct sheet banner and hides screen banner while editing', () => {
  const source = fs.readFileSync(path.join(root, 'src/app/goals.tsx'), 'utf8');
  assert.match(source, /testID="goals-sheet-mutation-banner"/);
  assert.match(source, /\{!editing \? \([\s\S]*MutationFormBanner/);
  assert.doesNotMatch(source, /PushScreen[\s\S]*MutationFormBanner[\s\S]*MutationSheet[\s\S]*testID="mutation-form-banner"/);
});

test('SortSheet uses sibling backdrop and selection accessibilityState', () => {
  const source = fs.readFileSync(path.join(root, 'src/app/category/[name].tsx'), 'utf8');
  assert.match(source, /function SortSheet/);
  assert.match(source, /testID="category-sort-sheet"[\s\S]*accessible=\{false\}/);
  assert.match(source, /accessibilityState=\{\{ selected \}\}/);
  assert.doesNotMatch(source, /<Pressable testID="category-sort-sheet" style=\{styles\.sheetCard\} onPress/);
  assert.match(source, /sheetBackdrop:\s*\{\s*flex:\s*1/);
  assert.match(source, /paddingBottom:\s*insets\.bottom\s*\+\s*16/);
  assert.doesNotMatch(source, /sheetBackdrop:\s*\{[\s\S]*StyleSheet\.absoluteFill/);
});

test('Maestro goals validation flows target sheet banner and field errors', () => {
  for (const file of [
    '.maestro/mutation-validation-banner-dismiss.yaml',
    '.maestro/mutation-validation-draft-preservation.yaml',
  ]) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(source, /goals-sheet-mutation-banner/);
    assert.match(source, /goals-(name|target)-error/);
  }
  const dismiss = fs.readFileSync(path.join(root, '.maestro/mutation-validation-banner-dismiss.yaml'), 'utf8');
  assert.match(dismiss, /assertNotVisible:[\s\S]*goals-sheet-mutation-banner/);
  assert.match(dismiss, /assertNotVisible:[\s\S]*goals-name-error/);
});

test('settings demo notification copy uses dedicated testID', () => {
  const source = fs.readFileSync(path.join(root, 'src/app/(tabs)/settings.tsx'), 'utf8');
  assert.match(source, /settings-notifications-unavailable-demo-copy/);
  const flow = fs.readFileSync(path.join(root, '.maestro/notification-settings.yaml'), 'utf8');
  assert.match(flow, /settings-notifications-unavailable-demo-copy/);
});
