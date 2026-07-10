const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonStoreError, readJsonFile, writeJsonFile } = require('../lib/json-store');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-json-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('missing files return an independent fallback value', (t) => {
  const dir = tempDir(t);
  const fallback = { items: [] };
  const first = readJsonFile(path.join(dir, 'missing.json'), fallback);
  first.items.push('changed');
  assert.deepEqual(readJsonFile(path.join(dir, 'missing.json'), fallback), { items: [] });
});

test('writes JSON atomically with private permissions and a last-good copy', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'state.json');
  writeJsonFile(file, { version: 1 });
  assert.deepEqual(readJsonFile(file), { version: 1 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  writeJsonFile(file, { version: 2 });
  assert.deepEqual(readJsonFile(file), { version: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.last-good`, 'utf8')), { version: 1 });
  assert.equal(fs.statSync(`${file}.last-good`).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(dir).some((name) => name.endsWith('.tmp')), false);
});

test('corrupt JSON is preserved and quarantined instead of treated as empty', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{broken', { mode: 0o600 });

  assert.throws(
    () => readJsonFile(file, { items: [] }),
    (error) => error instanceof JsonStoreError && error.code === 'JSON_CORRUPT'
  );
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('state.json.corrupt-')));
  assert.throws(() => writeJsonFile(file, { items: [] }), /Refusing to replace unreadable JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('optional shape validation fails closed', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ wrong: true }), { mode: 0o600 });
  assert.throws(
    () => readJsonFile(file, null, (value) => Array.isArray(value.items)),
    (error) => error instanceof JsonStoreError && error.code === 'JSON_INVALID_SHAPE'
  );
});
