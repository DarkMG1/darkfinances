const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const script = path.resolve(__dirname, '..', 'trip-quickadd.js');

function fixture(t, initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-events-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'events.json');
  if (initial !== undefined) fs.writeFileSync(file, initial);
  const run = (...args) => spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, EVENTS_PATH: file },
    encoding: 'utf8',
  });
  return { dir, file, run };
}

test('trip quick-add refuses to replace malformed state', (t) => {
  const f = fixture(t, '{broken');
  const result = f.run('add', 'Test Trip');
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{broken');
});

test('trip quick-add writes valid state atomically and privately', (t) => {
  const f = fixture(t);
  const result = f.run('add', 'Test Trip', '--start', '2026-07-01');
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.equal(state.events[0].slug, 'test-trip');
  assert.equal(state.events[0].start, '2026-07-01');
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(f.dir), ['events.json']);
});
