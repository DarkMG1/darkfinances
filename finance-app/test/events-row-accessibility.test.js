const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.dirname(require.resolve('../package.json'));
const source = fs.readFileSync(path.join(root, 'src/app/events.tsx'), 'utf8');

test('event rows expose separate accessible navigation and locked deletion controls', () => {
  const rowsStart = source.indexOf('{list.map((e, i) => (');
  const rowsEnd = source.indexOf('</Card>', rowsStart);
  assert.notEqual(rowsStart, -1, 'event row map must exist');
  assert.notEqual(rowsEnd, -1, 'event row card must close');

  const rows = source.slice(rowsStart, rowsEnd);
  const navigation = rows.match(/<Pressable\s+testID=\{`events-row-\$\{e\.slug\}`\}[\s\S]*?<\/Pressable>/)?.[0];
  const deletion = rows.match(/<Pressable\s+testID=\{`events-delete-\$\{e\.slug\}`\}[\s\S]*?<\/Pressable>/)?.[0];

  assert.ok(navigation, 'event navigation control must exist');
  assert.match(navigation, /accessibilityRole="link"/);
  assert.match(navigation, /accessibilityLabel=\{`\$\{e\.name\}, #ev-\$\{e\.slug\}/);
  assert.match(navigation, /accessibilityHint="Opens transactions tagged for this trip"/);
  assert.doesNotMatch(navigation, /onLongPress/);

  assert.ok(deletion, 'event deletion control must exist');
  assert.ok(rows.indexOf(deletion) > rows.indexOf(navigation), 'delete must be a sibling after the navigation control');
  assert.match(deletion, /accessibilityRole="button"/);
  assert.match(deletion, /accessibilityLabel=\{`Delete \$\{e\.name\}`\}/);
  assert.match(deletion, /accessibilityHint="Shows a confirmation before deleting this trip"/);
  assert.match(deletion, /accessibilityState=\{\{ disabled: inputLocked \}\}/);
  assert.match(deletion, /disabled=\{inputLocked\}/);
  assert.match(deletion, /onPress=\{\(\) => remove\(e\.slug, e\.name\)\}/);

  assert.match(source, /if \(inputLocked\) return;\s*Alert\.alert\('Delete trip\?'/);
  assert.match(source, /onPress: \(\) => \{ if \(inputLocked\) return; haptics\.tap\(\); deleteAction\.run\(\{ slug \}\); \}/);
});
