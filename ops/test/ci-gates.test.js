const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repositoryRoot = path.resolve(__dirname, '..', '..');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-ci-gates-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function copyScript(root, name) {
  const destination = path.join(root, 'scripts', name);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(repositoryRoot, 'scripts', name), destination);
}

function run(root, script, env = {}) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', script)], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function lockfileFixture(t) {
  const root = fixture(t);
  copyScript(root, 'check-lockfile-repro.js');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"gate-fixture","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"name":"gate-fixture","lockfileVersion":3,"packages":{"":{"name":"gate-fixture","version":"1.0.0"}}}\n');
  return root;
}

function contractFixture(t) {
  const root = fixture(t);
  copyScript(root, 'contract-fingerprint.js');
  copyScript(root, 'check-contract-freshness.js');
  copyScript(root, 'update-contract-fingerprint.js');

  fs.mkdirSync(path.join(root, 'finance-dashboard', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'finance-app', 'src', 'api', 'generated'), { recursive: true });
  fs.writeFileSync(path.join(root, 'finance-dashboard', 'lib', 'validation.js'), 'module.exports = { ping: true };\n');
  fs.writeFileSync(path.join(root, 'finance-dashboard', 'server.js'), "v1.get('/ping', noop);\n");
  fs.writeFileSync(path.join(root, 'finance-app', 'src', 'api', 'generated', 'endpoints.ts'), "const def = () => {};\nexport const API_ENDPOINTS = { ping: def('/api/v1/ping', 'GET', 'ping') };\n");
  fs.writeFileSync(path.join(root, 'finance-app', 'src', 'api', 'generated', 'types.ts'), 'export type Ping = { ok: boolean };\n');
  return root;
}

function stampPath(root) {
  return path.join(root, 'finance-app', 'src', 'api', 'generated', '.contract-fingerprint');
}

function generatedArtifacts(root) {
  const generated = path.join(root, 'finance-app', 'src', 'api', 'generated');
  return {
    endpoints: fs.readFileSync(path.join(generated, 'endpoints.ts'), 'utf8'),
    types: fs.readFileSync(path.join(generated, 'types.ts'), 'utf8'),
  };
}

test('lockfile reproducibility check starts without installed dependencies', (t) => {
  const root = lockfileFixture(t);
  const lockfile = path.join(root, 'package-lock.json');
  const before = fs.readFileSync(lockfile, 'utf8');

  assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);
  const result = run(root, 'check-lockfile-repro.js');

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /lockfile-repro: ok/);
  assert.equal(fs.readFileSync(lockfile, 'utf8'), before);
});

test('lockfile reproducibility check fails when install mutates the lockfile', (t) => {
  const root = lockfileFixture(t);
  const { checkLockfileRepro } = require(path.join(root, 'scripts', 'check-lockfile-repro.js'));
  let command;
  let args;

  assert.throws(() => checkLockfileRepro({
    root,
    runNpm: (nextCommand, nextArgs) => {
      command = nextCommand;
      args = nextArgs;
      fs.appendFileSync(path.join(root, 'package-lock.json'), 'mutated\n');
      return { status: 0 };
    },
  }), /package-lock\.json changed after npm ci/);

  assert.equal(command, 'npm');
  assert.deepEqual(args, ['ci', '--ignore-scripts']);
});

test('contract freshness check fails without creating a missing stamp', (t) => {
  const root = contractFixture(t);
  const before = generatedArtifacts(root);

  const result = run(root, 'check-contract-freshness.js');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /generated contract stamp is missing/);
  assert.equal(fs.existsSync(stampPath(root)), false);
  assert.deepEqual(generatedArtifacts(root), before);
});

test('contract freshness check fails on a changed source without repairing artifacts', (t) => {
  const root = contractFixture(t);
  const generated = generatedArtifacts(root);
  const update = run(root, 'update-contract-fingerprint.js');
  assert.equal(update.status, 0, update.stderr || update.stdout);
  const stamped = fs.readFileSync(stampPath(root), 'utf8');

  fs.appendFileSync(path.join(root, 'finance-dashboard', 'lib', 'validation.js'), '// changed contract input\n');
  const result = run(root, 'check-contract-freshness.js');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /generated contract is stale/);
  assert.equal(fs.readFileSync(stampPath(root), 'utf8'), stamped);
  assert.deepEqual(generatedArtifacts(root), generated);
});

test('explicit contract stamp update makes a regenerated contract verifiable', (t) => {
  const root = contractFixture(t);

  const update = run(root, 'update-contract-fingerprint.js');
  assert.equal(update.status, 0, update.stderr || update.stdout);
  assert.match(fs.readFileSync(stampPath(root), 'utf8'), /^[a-f0-9]{16}\n$/);

  const check = run(root, 'check-contract-freshness.js');
  assert.equal(check.status, 0, check.stderr || check.stdout);
  assert.match(check.stdout, /contract-freshness: ok/);
});

test('contract freshness check rejects route drift without writing artifacts', (t) => {
  const root = contractFixture(t);
  const update = run(root, 'update-contract-fingerprint.js');
  assert.equal(update.status, 0, update.stderr || update.stdout);
  const stamped = fs.readFileSync(stampPath(root), 'utf8');
  const generated = generatedArtifacts(root);

  fs.writeFileSync(path.join(root, 'finance-dashboard', 'server.js'), "v1.get('/different-route', noop);\n");
  const result = run(root, 'check-contract-freshness.js');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /generated endpoints\.ts does not match/);
  assert.equal(fs.readFileSync(stampPath(root), 'utf8'), stamped);
  assert.deepEqual(generatedArtifacts(root), generated);
});
