const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf8');
const script = source.match(/<script>([\s\S]*)<\/script>/)?.[1] || '';

test('browser dashboard script parses and does not shadow the escaping helper', () => {
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script));
  assert.doesNotMatch(script, /\blet html\s*=/);
  assert.match(script, /const html = \(s\) =>/);
});

test('browser dashboard has a forced synthetic-data route', () => {
  assert.match(script, /location\.pathname === '\/demo'/);
  assert.match(script, /demoOnlyPage \|\|/);
});
