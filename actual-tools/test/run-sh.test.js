const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function fixture(t, dataDir) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-runner-'));
  if (dataDir !== '/') fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (dataDir !== '/') fs.rmSync(dataDir, { recursive: true, force: true });
  });
  fs.copyFileSync(path.resolve(__dirname, '..', 'run.sh'), path.join(dir, 'run.sh'));
  fs.writeFileSync(path.join(dir, '.actual.env'), `FIX_DATA_DIR=${JSON.stringify(dataDir)}\n`);
  return dir;
}

test('runner requires an explicit script', (t) => {
  const dir = fixture(t, '/tmp/darkfinances-runner-cache-test');
  const result = spawnSync('bash', [path.join(dir, 'run.sh')], { encoding: 'utf8' });
  assert.equal(result.status, 2);
});

test('runner refuses unsafe cache deletion paths', (t) => {
  const dir = fixture(t, '/');
  fs.writeFileSync(path.join(dir, 'ok.js'), 'console.log("should not run");\n');
  const result = spawnSync('bash', [path.join(dir, 'run.sh'), 'ok.js'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /should not run/);
});

test('filtered-only output remains successful while script failures propagate', (t) => {
  const dir = fixture(t, `/tmp/darkfinances-runner-cache-${process.pid}`);
  fs.writeFileSync(path.join(dir, 'quiet.js'), 'console.log("Loading");\n');
  fs.writeFileSync(path.join(dir, 'fail.js'), 'process.exit(7);\n');
  const quiet = spawnSync('bash', [path.join(dir, 'run.sh'), 'quiet.js'], { encoding: 'utf8' });
  const failed = spawnSync('bash', [path.join(dir, 'run.sh'), 'fail.js'], { encoding: 'utf8' });
  assert.equal(quiet.status, 0);
  assert.equal(failed.status, 7);
});
