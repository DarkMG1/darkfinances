const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('loading components expose named busy live regions', () => {
  const ui = fs.readFileSync(path.join(root, 'src/components/ui.tsx'), 'utf8');
  const loading = ui.slice(ui.indexOf('export function Loading'), ui.indexOf('export function EmptyState'));
  assert.match(loading, /accessibilityRole="progressbar"/);
  assert.match(loading, /accessibilityLabel=\{label\}/);
  assert.match(loading, /accessibilityState=\{\{ busy: true \}\}/);
  assert.match(loading, /visibleStatusLiveRegionProps/);
  assert.match(loading, /AccessibilityAnnouncementEffect message=\{label\}/);

  const skeleton = fs.readFileSync(path.join(root, 'src/components/skeleton.tsx'), 'utf8');
  assert.match(skeleton, /accessibilityLabel = 'Loading content'/);
  assert.match(skeleton, /accessibilityRole="progressbar"/);
  assert.match(skeleton, /accessibilityState=\{\{ busy: true \}\}/);
  assert.match(skeleton, /visibleStatusLiveRegionProps/);
  assert.match(skeleton, /AccessibilityAnnouncementEffect message=\{accessibilityLabel\}/);
});

test('pressable list rows have a consolidated accessibility label', () => {
  const ui = fs.readFileSync(path.join(root, 'src/components/ui.tsx'), 'utf8');
  const listRow = ui.slice(ui.indexOf('export function ListRow'), ui.indexOf('export function PressableScale'));
  assert.match(listRow, /accessibilityLabel\?: string/);
  assert.match(listRow, /const a11yLabel = accessibilityLabel \?\?/);
  assert.match(listRow, /accessibilityLabel=\{a11yLabel\}/);
});
