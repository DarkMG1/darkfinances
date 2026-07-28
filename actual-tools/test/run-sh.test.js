const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const POISON_ACTUAL_ENV = 'echo "ACTUAL_CREDS_LEAKED" >&2\nexit 99\n';
const POISON_SPLITWISE_ENV = 'echo "SPLITWISE_CREDS_LEAKED" >&2\nexit 98\n';

function fixture(t, dataDir, envExtra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-runner-'));
  if (dataDir !== '/' && dataDir !== null) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (dataDir !== '/' && dataDir !== null) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
  fs.copyFileSync(path.resolve(__dirname, '..', 'run.sh'), path.join(dir, 'run.sh'));
  return { dir, env: envExtra };
}

function writePoisonedCredentialFiles(dir, { dataDir = '/tmp/darkfinances-runner-cache-test', includeSplitwise = true } = {}) {
  fs.writeFileSync(
    path.join(dir, '.actual.env'),
    `${POISON_ACTUAL_ENV}FIX_DATA_DIR=${JSON.stringify(dataDir)}\n`,
  );
  if (includeSplitwise) {
    fs.writeFileSync(path.join(dir, '.splitwise.env'), POISON_SPLITWISE_ENV);
  }
}

function runRunner(fixtureInfo, args) {
  return spawnSync('bash', [path.join(fixtureInfo.dir, 'run.sh'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...fixtureInfo.env },
  });
}

function assertNoCredentialLeak(result, marker = 'SHOULD_NOT_RUN') {
  assert.doesNotMatch(result.stdout, new RegExp(marker));
  assert.doesNotMatch(result.stderr, /ACTUAL_CREDS_LEAKED/);
  assert.doesNotMatch(result.stderr, /SPLITWISE_CREDS_LEAKED/);
}

function assertRejectedWithoutExecution(result, marker = 'SHOULD_NOT_RUN') {
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  assertNoCredentialLeak(result, marker);
}

test('runner requires an explicit script without sourcing poisoned credentials', (t) => {
  const fixtureInfo = fixture(t, '/tmp/darkfinances-runner-cache-test');
  writePoisonedCredentialFiles(fixtureInfo.dir);
  const result = runRunner(fixtureInfo, []);
  assert.equal(result.status, 2);
  assertNoCredentialLeak(result);
});

test('runner refuses unsafe cache deletion paths without sourcing poisoned credentials', (t) => {
  const fixtureInfo = fixture(t, '/');
  writePoisonedCredentialFiles(fixtureInfo.dir, { dataDir: '/' });
  fs.writeFileSync(path.join(fixtureInfo.dir, 'ok.js'), 'console.log("should not run");\n');
  const result = runRunner(fixtureInfo, ['ok.js']);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /should not run/);
  assertNoCredentialLeak(result);
});

test('runner refuses missing FIX_DATA_DIR without sourcing poisoned credentials', (t) => {
  const missingDir = `/tmp/darkfinances-runner-missing-${process.pid}`;
  const fixtureInfo = fixture(t, null);
  writePoisonedCredentialFiles(fixtureInfo.dir, { dataDir: missingDir });
  fs.writeFileSync(path.join(fixtureInfo.dir, 'ok.js'), 'console.log("SHOULD_NOT_RUN");\n');
  const result = runRunner(fixtureInfo, ['ok.js']);
  assertRejectedWithoutExecution(result);
  assert.match(result.stderr, /missing FIX_DATA_DIR/);
});

test('filtered-only output remains successful while script failures propagate', (t) => {
  const dataDir = `/tmp/darkfinances-runner-cache-${process.pid}`;
  const fixtureInfo = fixture(t, dataDir);
  fs.writeFileSync(path.join(fixtureInfo.dir, '.actual.env'), `FIX_DATA_DIR=${JSON.stringify(dataDir)}\n`);
  fs.writeFileSync(path.join(fixtureInfo.dir, 'quiet.js'), 'console.log("Loading");\n');
  fs.writeFileSync(path.join(fixtureInfo.dir, 'fail.js'), 'process.exit(7);\n');
  const quiet = runRunner(fixtureInfo, ['quiet.js']);
  const failed = runRunner(fixtureInfo, ['fail.js']);
  assert.equal(quiet.status, 0);
  assert.equal(failed.status, 7);
});

test('run.sh sets restrictive umask before recreating private cache directory', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'run.sh'), 'utf8');
  const umaskIndex = source.indexOf('umask 077');
  const mkdirIndex = source.indexOf('mkdir -p "$SAFE_DATA_DIR"');
  assert.ok(umaskIndex >= 0, 'expected umask 077');
  assert.ok(mkdirIndex > umaskIndex, 'umask must precede private directory creation');
});

test('runner recreates FIX_DATA_DIR with mode 0700', (t) => {
  const dataDir = `/tmp/darkfinances-runner-mode-${process.pid}`;
  const fixtureInfo = fixture(t, dataDir);
  fs.writeFileSync(path.join(fixtureInfo.dir, '.actual.env'), `FIX_DATA_DIR=${JSON.stringify(dataDir)}\n`);
  fs.writeFileSync(path.join(fixtureInfo.dir, 'touch.js'), 'console.log("ok");\n');
  const result = runRunner(fixtureInfo, ['touch.js']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
});

test('runner rejects invalid script payloads without sourcing poisoned credentials', (t) => {
  const dataDir = `/tmp/darkfinances-runner-reject-${process.pid}`;
  const fixtureInfo = fixture(t, dataDir);
  writePoisonedCredentialFiles(fixtureInfo.dir, { dataDir });
  fs.writeFileSync(path.join(fixtureInfo.dir, 'evil.js'), 'console.log("SHOULD_NOT_RUN");\n');
  fs.mkdirSync(path.join(fixtureInfo.dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(fixtureInfo.dir, 'scripts', 'nested.js'), 'console.log("SHOULD_NOT_RUN");\n');

  for (const payload of ['-e', '--help', '--', '../evil.js', 'scripts/nested.js', '.', '..', '/etc/passwd']) {
    const result = runRunner(fixtureInfo, [payload]);
    assertRejectedWithoutExecution(result);
  }
});

test('runner rejects symlink script paths without sourcing poisoned credentials', (t) => {
  const dataDir = `/tmp/darkfinances-runner-symlink-${process.pid}`;
  const fixtureInfo = fixture(t, dataDir);
  writePoisonedCredentialFiles(fixtureInfo.dir, { dataDir });
  fs.writeFileSync(path.join(fixtureInfo.dir, 'real.js'), 'console.log("SHOULD_NOT_RUN");\n');
  fs.symlinkSync('real.js', path.join(fixtureInfo.dir, 'link.js'));
  const result = runRunner(fixtureInfo, ['link.js']);
  assertRejectedWithoutExecution(result);
  assert.match(result.stderr, /symlink script/);
});

test('runner rejects non-regular script paths without sourcing poisoned credentials', (t) => {
  const dataDir = `/tmp/darkfinances-runner-nonregular-${process.pid}`;
  const fixtureInfo = fixture(t, dataDir);
  writePoisonedCredentialFiles(fixtureInfo.dir, { dataDir });
  fs.mkdirSync(path.join(fixtureInfo.dir, 'payload.dir'), { recursive: true });
  const result = runRunner(fixtureInfo, ['payload.dir']);
  assertRejectedWithoutExecution(result);
  assert.match(result.stderr, /non-regular script/);
});

test('runner refuses post-source FIX_DATA_DIR mutation without deleting the pre-validated cache', (t) => {
  const dataDir = `/tmp/darkfinances-runner-post-source-${process.pid}`;
  const fixtureInfo = fixture(t, dataDir);
  const sentinelPath = path.join(dataDir, 'keep-me');
  fs.writeFileSync(sentinelPath, 'sentinel\n', { mode: 0o600 });
  // Pre-source parser uses the first FIX_DATA_DIR= line (re.search). Bash source still
  // executes later assignments, so a trailing FIX_DATA_DIR=/ mutates the shell binding.
  fs.writeFileSync(
    path.join(fixtureInfo.dir, '.actual.env'),
    [
      `FIX_DATA_DIR=${JSON.stringify(dataDir)}`,
      'FIX_DATA_DIR=/',
    ].join('\n').concat('\n'),
  );
  fs.writeFileSync(path.join(fixtureInfo.dir, 'mutate.js'), 'console.log("SHOULD_NOT_RUN");\n');
  const result = runRunner(fixtureInfo, ['mutate.js']);

  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(
    result.stderr,
    /refusing (unsafe FIX_DATA_DIR: \/|FIX_DATA_DIR change after credential load)/,
  );
  assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'sentinel\n');
  assertNoCredentialLeak(result);
});
