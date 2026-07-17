'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const {
  registerAdmission,
  consumeAdmission,
  revokeAdmission,
  assertAdmissionConsumable,
  registryRootForLayout,
  terminalPath,
  legacyConsumedPath,
  legacyRevokedPath,
  readTerminalMarker,
  TERMINAL_CONSUMED,
  TERMINAL_REVOKED,
  REGISTRY_KIND,
  TERMINAL_SCHEMA_VERSION,
} = require('../lib/coordinated-admission-registry');
const {
  consumeAdmissionToken,
  revokeAdmissionToken,
  assertAdmissionRegistryState,
} = require('../lib/restore-quiescence-admission');
const { coordinatedLayoutForRoot } = require('../lib/coordinated-operation-layout');
const { buildTestAdmissionToken, registerTestAdmission } = require('./fixtures/admission-token-fixtures');

const registryHelper = path.join(__dirname, '..', 'lib', 'coordinated-admission-registry.js');
const layoutHelper = path.join(__dirname, '..', 'lib', 'coordinated-operation-layout.js');
const admissionHelper = path.join(__dirname, '..', 'lib', 'restore-quiescence-admission.js');

const STRESS_TRIALS = Number(process.env.ADMISSION_REGISTRY_STRESS_TRIALS || 200);

function mkRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function prepareLayout(root) {
  const layout = coordinatedLayoutForRoot(path.join(root, 'backups'));
  fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  return layout;
}

function sampleEntry(nonce = 'nonce-1') {
  const now = new Date().toISOString();
  return {
    nonce,
    runId: 'run-1',
    journalId: 'journal-1',
    issuedAt: now,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function spawnRegistryOp(coordinatorRoot, nonce, op, reasonCode = 'restore_failed') {
  const script = `
    const { coordinatedLayoutForRoot } = require(${JSON.stringify(layoutHelper)});
    const registry = require(${JSON.stringify(registryHelper)});
    const layout = coordinatedLayoutForRoot(${JSON.stringify(coordinatorRoot)});
    try {
      if (${JSON.stringify(op)} === 'consume') registry.consumeAdmission(layout, ${JSON.stringify(nonce)});
      else registry.revokeAdmission(layout, ${JSON.stringify(nonce)}, ${JSON.stringify(reasonCode)});
      process.stdout.write('ok');
      process.exit(0);
    } catch (error) {
      process.stdout.write(String(error.message));
      process.exit(2);
    }
  `;
  return spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
}

async function runParallelOps(coordinatorRoot, nonce, opA, opB) {
  function run(op) {
    return new Promise((resolve) => {
      const child = spawnRegistryOp(coordinatorRoot, nonce, op);
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk.toString(); });
      child.on('exit', (code) => resolve({ code, out }));
    });
  }
  const [a, b] = await Promise.all([run(opA), run(opB)]);
  return { a, b };
}

function assertSingleTerminalState(layout, nonce) {
  const registryRoot = registryRootForLayout(layout);
  const terminal = readTerminalMarker(registryRoot, nonce);
  assert.ok(terminal, 'expected exactly one terminal state');
  assert.ok([TERMINAL_CONSUMED, TERMINAL_REVOKED].includes(terminal.terminal));
  assert.equal(fs.existsSync(terminalPath(registryRoot, nonce)), true);
  const legacyBoth = fs.existsSync(legacyConsumedPath(registryRoot, nonce))
    && fs.existsSync(legacyRevokedPath(registryRoot, nonce));
  assert.equal(legacyBoth, false);
  return terminal;
}

test('register rejects duplicate nonce', (t) => {
  const layout = prepareLayout(mkRoot(t, 'df-registry-dup-'));
  registerAdmission(layout, sampleEntry('dup'));
  assert.throws(() => registerAdmission(layout, sampleEntry('dup')), /already registered/);
});

test('consume rejects second use and revoke blocks consume', (t) => {
  const layout = prepareLayout(mkRoot(t, 'df-registry-consume-'));
  registerAdmission(layout, sampleEntry('race-nonce'));
  consumeAdmission(layout, 'race-nonce');
  assert.throws(() => consumeAdmission(layout, 'race-nonce'), /already consumed/);
  assert.throws(() => assertAdmissionConsumable(layout, 'race-nonce'), /consumed/);
  registerAdmission(layout, sampleEntry('revoke-nonce'));
  revokeAdmission(layout, 'revoke-nonce', 'restore_failed');
  revokeAdmission(layout, 'revoke-nonce', 'restore_failed');
  assert.throws(() => consumeAdmission(layout, 'revoke-nonce'), /revoked/);
});

test('revoke after consume reports already consumed', (t) => {
  const layout = prepareLayout(mkRoot(t, 'df-registry-revoke-after-consume-'));
  registerAdmission(layout, sampleEntry('used'));
  consumeAdmission(layout, 'used');
  assert.throws(() => revokeAdmission(layout, 'used', 'late_revoke'), /already consumed/);
});

test('concurrent consume allows one winner', async (t) => {
  const root = mkRoot(t, 'df-registry-consume-par-');
  const layout = prepareLayout(root);
  registerAdmission(layout, sampleEntry('parallel-consume'));
  const result = await runParallelOps(path.join(root, 'backups'), 'parallel-consume', 'consume', 'consume');
  const codes = [result.a.code, result.b.code].sort();
  assert.deepEqual(codes, [0, 2]);
  const terminal = assertSingleTerminalState(layout, 'parallel-consume');
  assert.equal(terminal.terminal, TERMINAL_CONSUMED);
});

test('concurrent revoke is idempotent with one terminal marker', async (t) => {
  const root = mkRoot(t, 'df-registry-revoke-par-');
  const layout = prepareLayout(root);
  registerAdmission(layout, sampleEntry('parallel-revoke'));
  const result = await runParallelOps(path.join(root, 'backups'), 'parallel-revoke', 'revoke', 'revoke');
  assert.equal(result.a.code, 0);
  assert.equal(result.b.code, 0);
  const terminal = assertSingleTerminalState(layout, 'parallel-revoke');
  assert.equal(terminal.terminal, TERMINAL_REVOKED);
});

test('concurrent consume and revoke leave exactly one terminal state', async (t) => {
  const root = mkRoot(t, 'df-registry-consume-revoke-');
  const layout = prepareLayout(root);
  registerAdmission(layout, sampleEntry('cr-race'));
  const result = await runParallelOps(path.join(root, 'backups'), 'cr-race', 'consume', 'revoke');
  const codes = [result.a.code, result.b.code].sort();
  assert.deepEqual(codes, [0, 2]);
  const terminal = assertSingleTerminalState(layout, 'cr-race');
  assert.ok([TERMINAL_CONSUMED, TERMINAL_REVOKED].includes(terminal.terminal));
  const loser = result.a.code === 2 ? result.a : result.b;
  if (terminal.terminal === TERMINAL_CONSUMED) {
    assert.match(loser.out, /already consumed/);
  } else {
    assert.match(loser.out, /revoked/);
  }
});

test(`consume parallel revoke stress leaves one terminal marker (${STRESS_TRIALS} trials)`, async (t) => {
  for (let trial = 0; trial < STRESS_TRIALS; trial += 1) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-registry-stress-'));
    try {
      const layout = prepareLayout(root);
      const nonce = `stress-${trial}`;
      registerAdmission(layout, sampleEntry(nonce));
      const firstOp = trial % 2 === 0 ? 'consume' : 'revoke';
      const secondOp = firstOp === 'consume' ? 'revoke' : 'consume';
      const result = await runParallelOps(path.join(root, 'backups'), nonce, firstOp, secondOp);
      const codes = [result.a.code, result.b.code].sort();
      assert.deepEqual(codes, [0, 2], `trial ${trial} exit codes ${codes.join(',')}`);
      assertSingleTerminalState(layout, nonce);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('different nonces can terminal independently', (t) => {
  const layout = prepareLayout(mkRoot(t, 'df-registry-multi-'));
  registerAdmission(layout, sampleEntry('nonce-a'));
  registerAdmission(layout, sampleEntry('nonce-b'));
  consumeAdmission(layout, 'nonce-a');
  revokeAdmission(layout, 'nonce-b', 'restore_failed');
  assert.throws(() => consumeAdmission(layout, 'nonce-a'), /already consumed/);
  assert.throws(() => consumeAdmission(layout, 'nonce-b'), /revoked/);
  assert.throws(() => assertAdmissionConsumable(layout, 'nonce-c'), /not registered/);
});

test('legacy single consumed marker is readable and blocks reuse', (t) => {
  const layout = prepareLayout(mkRoot(t, 'df-registry-legacy-consumed-'));
  const registryRoot = registryRootForLayout(layout);
  ensureLegacyDirs(registryRoot);
  registerAdmission(layout, sampleEntry('legacy-c'));
  fs.writeFileSync(legacyConsumedPath(registryRoot, 'legacy-c'), `${JSON.stringify({
    kind: REGISTRY_KIND,
    schemaVersion: 1,
    nonce: 'legacy-c',
    consumedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  const terminal = readTerminalMarker(registryRoot, 'legacy-c');
  assert.equal(terminal.terminal, TERMINAL_CONSUMED);
  assert.throws(() => consumeAdmission(layout, 'legacy-c'), /already consumed/);
});

test('legacy dual markers fail closed', (t) => {
  const layout = prepareLayout(mkRoot(t, 'df-registry-legacy-dual-'));
  const registryRoot = registryRootForLayout(layout);
  ensureLegacyDirs(registryRoot);
  registerAdmission(layout, sampleEntry('legacy-dual'));
  const now = new Date().toISOString();
  fs.writeFileSync(legacyConsumedPath(registryRoot, 'legacy-dual'), `${JSON.stringify({ nonce: 'legacy-dual', consumedAt: now }, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(legacyRevokedPath(registryRoot, 'legacy-dual'), `${JSON.stringify({ nonce: 'legacy-dual', revokedAt: now }, null, 2)}\n`, { mode: 0o600 });
  assert.throws(() => readTerminalMarker(registryRoot, 'legacy-dual'), /dual terminal markers/);
  assert.throws(() => assertAdmissionConsumable(layout, 'legacy-dual'), /dual terminal markers/);
});

test('invalid terminal marker fails closed', (t) => {
  const layout = prepareLayout(mkRoot(t, 'df-registry-invalid-terminal-'));
  const registryRoot = registryRootForLayout(layout);
  ensureLegacyDirs(registryRoot);
  registerAdmission(layout, sampleEntry('invalid'));
  fs.writeFileSync(terminalPath(registryRoot, 'invalid'), '{not-json', { mode: 0o600 });
  assert.throws(() => readTerminalMarker(registryRoot, 'invalid'), /not valid JSON/);
});

test('caller wrappers surface consume-lost-to-revoke and revoke-lost-to-consume', (t) => {
  const root = mkRoot(t, 'df-registry-callers-');
  const layout = prepareLayout(root);
  const { token: consumedToken } = buildTestAdmissionToken({ bindings: {} });
  registerTestAdmission(layout, consumedToken);
  consumeAdmissionToken(layout, consumedToken);
  assert.throws(
    () => revokeAdmissionToken(layout, consumedToken, 'cleanup'),
    /already consumed/,
  );
  const { token: revokedToken } = buildTestAdmissionToken({ bindings: {} });
  registerTestAdmission(layout, revokedToken);
  revokeAdmissionToken(layout, revokedToken, 'restore_failed');
  assert.throws(
    () => consumeAdmissionToken(layout, revokedToken),
    /revoked/,
  );
  assert.throws(
    () => assertAdmissionRegistryState(revokedToken, layout),
    /revoked/,
  );
});

function ensureLegacyDirs(registryRoot) {
  for (const sub of ['registered', 'terminal', 'consumed', 'revoked']) {
    fs.mkdirSync(path.join(registryRoot, sub), { recursive: true, mode: 0o700 });
  }
}

test('partial terminal marker without create permission cannot be replaced silently', (t) => {
  const layout = prepareLayout(mkRoot(t, 'df-registry-partial-'));
  registerAdmission(layout, sampleEntry('partial'));
  consumeAdmission(layout, 'partial');
  const marker = readTerminalMarker(registryRootForLayout(layout), 'partial');
  assert.equal(marker.terminal, TERMINAL_CONSUMED);
  assert.throws(() => revokeAdmission(layout, 'partial'), /already consumed/);
});

test('spawn sync consume after terminal revoke never creates dual markers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-registry-sync-'));
  try {
    const layout = prepareLayout(root);
    registerAdmission(layout, sampleEntry('sync'));
    revokeAdmission(layout, 'sync', 'restore_failed');
    const worker = `
      const { coordinatedLayoutForRoot } = require(${JSON.stringify(layoutHelper)});
      const { consumeAdmission } = require(${JSON.stringify(registryHelper)});
      const layout = coordinatedLayoutForRoot(${JSON.stringify(path.join(root, 'backups'))});
      try { consumeAdmission(layout, 'sync'); process.exit(0); }
      catch (e) { console.error(e.message); process.exit(2); }
    `;
    const result = spawnSync(process.execPath, ['-e', worker], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /revoked/);
    const terminal = assertSingleTerminalState(layout, 'sync');
    assert.equal(terminal.terminal, TERMINAL_REVOKED);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
