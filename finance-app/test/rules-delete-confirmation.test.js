const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('rules require destructive confirmation before deletion', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/app/rules.tsx'), 'utf8');
  assert.match(source, /Alert\.alert\('Delete rule\?'/);
  assert.match(source, /haptics\.warning\(\)/);
  assert.match(source, /style: 'destructive'/);
  assert.match(source, /onPress: \(\) => deleteAction\.run\(\{ id \}\)/);
});
