'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runCoordinatedBackup, buildCoordinatedManifest } = require('../lib/coordinated-backup');
const {
  discoverWriters,
  stopWritersByPhase,
  stopWriter,
  verifyAllQuiescent,
  restartWritersByPhase,
  captureWriterState,
  preserveOriginalFlags,
  restartWriter,
} = require('../lib/writer-quiescence');
const { acquireCoordinatedLock } = require('../lib/coordinated-operation-lock');
const { coordinatedLayoutForRoot } = require('../lib/coordinated-operation-layout');
const { readRunJournal, PHASE, createRunJournal, writeRunJournal } = require('../lib/coordinated-run-journal');
const { loadWriterInventory } = require('../lib/writer-inventory');
const { parseAdmissionToken, assertAdmissionFresh, assertAdmissionBindings } = require('../lib/restore-quiescence-admission');
const { buildTestAdmissionToken } = require('./fixtures/admission-token-fixtures');
const { installTestCoordinatorKeys } = require('./fixtures/coordinated-test-helpers');
const {
  createMockRunners,
  defaultActiveUnits,
  RELEASE_MANIFEST_BODY,
  RELEASE_MANIFEST_DIGEST,
} = require('./fixtures/coordinated-backup-fixtures');
const { runPostRestartHealthChecks } = require('../lib/coordinated-backup-health');
const { bundleToolingSourcePaths } = require('../lib/backup-bundle-tooling');
const { writeProductionDashboard } = require('./fixtures/backup-bundle-dashboard-fixtures');

const repoRoot = path.resolve(__dirname, '..', '..');
const coordinatedShell = path.join(repoRoot, 'ops/bin/backup-coordinated.sh');

function mkRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function stubReleaseManifest() {
  return ({ releaseManifestPath }) => {
    fs.writeFileSync(releaseManifestPath, RELEASE_MANIFEST_BODY, { mode: 0o600 });
  };
}

function backupOptions(base, runners, extra = {}) {
  return {
    pollMs: 1,
    stopDeadlineMs: 2000,
    healthTimeoutMs: 200,
    healthPollMs: 10,
    registerSignalHandlers: false,
    writeReleaseManifest: stubReleaseManifest(),
    ...extra,
    env: base,
    runners,
  };
}
function envFor(root, dashboard, extra = {}) {
  return {
    ...process.env,
    HOME: root,
    FINANCE_DASHBOARD_DIR: dashboard,
    DARKFINANCES_BACKUP_DIR: path.join(root, 'backups'),
    DARKFINANCES_REPO_ROOT: repoRoot,
    COORDINATED_TEST_SKIP_LOCK: '0',
    BACKUP_INCLUDE_ACTUAL_DATA: '0',
    FINANCE_API_TOKEN: 'test-token',
    ...extra,
  };
}

function snapshotsMap(snapshots) {
  return new Map(snapshots.map((entry) => [entry.id, { ...entry }]));
}

test('reproduces incomplete legacy quiescence: stop exit 0 without inactive proof would pass old script', async (t) => {
  const root = mkRoot(t, 'df-coordinated-repro-');
  const dashboard = path.join(root, 'dashboard');
  fs.mkdirSync(dashboard, { recursive: true });
  const runners = createMockRunners({ units: defaultActiveUnits() });
  runners.systemctlStop = () => ({ status: 0, stdout: '' });
  runners.systemctlIsActive = (_scope, unit) => (
    unit === 'finance-dashboard.service'
      ? { status: 0, state: 'active' }
      : { status: 3, state: 'inactive' }
  );
  const inventory = loadWriterInventory();
  const context = { inventory, env: envFor(root, dashboard), runners, dashboardDir: dashboard, pollMs: 1, stopDeadlineMs: 50 };
  const { writers, snapshots } = discoverWriters(context);
  context.writers = writers;
  const map = snapshotsMap(snapshots);
  const stop = await stopWriter(
    inventory.writers.find((entry) => entry.id === 'finance-dashboard'),
    map.get('finance-dashboard'),
    context,
  );
  assert.equal(stop.ok, false);
  const verify = await verifyAllQuiescent(context, map);
  assert.equal(verify.ok, false);
  assert.match(verify.failures[0].reason, /state=active/);
});

test('dry-run performs discovery only and executes zero mutating commands', async (t) => {
  const root = mkRoot(t, 'df-coordinated-dry-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const runners = createMockRunners({ units: defaultActiveUnits() });
  const env = envFor(root, dashboard, { BACKUP_DRY_RUN: '1' });
  const result = await runCoordinatedBackup({
    dryRun: true,
    ...backupOptions(env, runners),
    dashboardDir: dashboard,
    destination: env.DARKFINANCES_BACKUP_DIR,
  });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.ok(result.plan.stopPhases.length > 0);
  assert.equal(runners.commands.some((entry) => entry[1] === 'stop'), false);
  assert.equal(fs.existsSync(path.join(env.DARKFINANCES_BACKUP_DIR, '.darkfinances-coordinated')), false);
});

test('happy path quiesces, backs up bundle, publishes manifest, and restarts in order', async (t) => {
  const root = mkRoot(t, 'df-coordinated-happy-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const runners = createMockRunners({ units: defaultActiveUnits() });
  const env = envFor(root, dashboard);
  const result = await runCoordinatedBackup({
    ...backupOptions(env, runners),
    dashboardDir: dashboard,
    destination: env.DARKFINANCES_BACKUP_DIR,
  });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(result.bundleArchive), true);
  assert.equal(fs.existsSync(`${result.bundleArchive}.sha256`), true);
  assert.equal(fs.existsSync(result.coordinatedManifest), true);
  assert.equal(
    fs.readdirSync(env.DARKFINANCES_BACKUP_DIR).some((name) => name.startsWith('quiescence-admission-')),
    false,
  );
  const manifest = JSON.parse(fs.readFileSync(result.coordinatedManifest, 'utf8'));
  assert.equal(manifest.provenanceOnly, true);
  assert.equal(manifest.schemaVersion, 2);
  const stopIndex = runners.commands.findIndex((entry) => entry.includes('actual-sync.timer') && entry.includes('stop'));
  const dashboardStop = runners.commands.findIndex((entry) => entry.includes('finance-dashboard.service') && entry.includes('stop'));
  const dashboardStart = runners.commands.findIndex((entry) => entry.includes('finance-dashboard.service') && entry.includes('start'));
  assert.ok(stopIndex >= 0);
  assert.ok(dashboardStop > stopIndex);
  assert.ok(dashboardStart > dashboardStop);
  const journal = readRunJournal(path.join(env.DARKFINANCES_BACKUP_DIR, '.darkfinances-coordinated/run-journal.json'));
  assert.equal(journal.phase, PHASE.COMPLETE);
});

test('originally inactive timer is not started on restart', async (t) => {
  const root = mkRoot(t, 'df-coordinated-inactive-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const units = defaultActiveUnits();
  units['actual-sync.timer'] = { active: 'inactive', enabled: 'disabled' };
  const runners = createMockRunners({ units });
  const env = envFor(root, dashboard);
  await runCoordinatedBackup({
    ...backupOptions(env, runners),
    dashboardDir: dashboard,
    destination: env.DARKFINANCES_BACKUP_DIR,
  });
  assert.equal(runners.commands.some((entry) => entry.includes('actual-sync.timer') && entry.includes('start')), false);
});

test('lock contention refuses overlapping coordinated backup', (t) => {
  const root = mkRoot(t, 'df-coordinated-lock-');
  const layout = coordinatedLayoutForRoot(path.join(root, 'backups'));
  fs.mkdirSync(layout.canonicalRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  const first = acquireCoordinatedLock({ layout, operation: 'backup', env: { COORDINATED_TEST_SKIP_LOCK: '0' } });
  assert.throws(
    () => acquireCoordinatedLock({ layout, operation: 'restore', env: { COORDINATED_TEST_SKIP_LOCK: '0' } }),
    /already in progress/,
  );
  first.release();
});

test('hung dashboard drain fails quiescence', async (t) => {
  const root = mkRoot(t, 'df-coordinated-hung-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const runners = createMockRunners({ units: defaultActiveUnits(), hungDrain: true });
  const env = envFor(root, dashboard);
  await assert.rejects(
    () => runCoordinatedBackup({
      ...backupOptions(env, runners, { stopDeadlineMs: 100 }),
      dashboardDir: dashboard,
      destination: env.DARKFINANCES_BACKUP_DIR,
    }),
    /did not quiesce/,
  );
});

test('active actual-sync.service during timer stop fails closed', async (t) => {
  const root = mkRoot(t, 'df-coordinated-timer-fire-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const units = defaultActiveUnits();
  units['actual-sync.service'] = { active: 'active', enabled: 'enabled' };
  const runners = createMockRunners({
    units,
    reappearingWriters: ['actual-sync.service'],
  });
  const env = envFor(root, dashboard);
  await assert.rejects(
    () => runCoordinatedBackup({
      ...backupOptions(env, runners, { stopDeadlineMs: 200 }),
      dashboardDir: dashboard,
      destination: env.DARKFINANCES_BACKUP_DIR,
    }),
    /did not quiesce/,
  );
});

test('unknown writer state fails closed', (t) => {
  const root = mkRoot(t, 'df-coordinated-unknown-');
  const dashboard = path.join(root, 'dashboard');
  fs.mkdirSync(dashboard, { recursive: true });
  const runners = createMockRunners({
    units: {
      ...defaultActiveUnits(),
      'finance-dashboard.service': { active: 'unknown', enabled: 'enabled' },
    },
  });
  assert.throws(
    () => discoverWriters({ inventory: loadWriterInventory(), env: envFor(root, dashboard), runners, dashboardDir: dashboard }),
    /unknown state/,
  );
});

test('restore lock held refuses backup', async (t) => {
  const root = mkRoot(t, 'df-coordinated-restore-lock-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const control = path.join(dashboard, '.darkfinances-restore');
  fs.mkdirSync(control, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(control, 'restore.lock'), `${JSON.stringify({
    kind: 'darkfinances-restore-lock',
    schemaVersion: 1,
    pid: process.pid,
    destinationRoot: dashboard,
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  const runners = createMockRunners({ units: defaultActiveUnits() });
  const env = envFor(root, dashboard);
  await assert.rejects(
    () => runCoordinatedBackup({
      ...backupOptions(env, runners, { stopDeadlineMs: 500 }),
      dashboardDir: dashboard,
      destination: env.DARKFINANCES_BACKUP_DIR,
    }),
    /restore already in progress/,
  );
});

test('container stop failure refuses snapshot', async (t) => {
  const root = mkRoot(t, 'df-coordinated-container-stop-');
  const dashboard = path.join(root, 'dashboard');
  const actualData = path.join(root, 'actual', 'data');
  fs.mkdirSync(actualData, { recursive: true });
  fs.writeFileSync(path.join(actualData, 'meta'), 'v1\n');
  writeProductionDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const runners = createMockRunners({
    units: defaultActiveUnits(),
    containers: { actual: 'running' },
    stopFailures: new Set(['actual']),
  });
  const env = envFor(root, dashboard, {
    BACKUP_INCLUDE_ACTUAL_DATA: '1',
    ACTUAL_DATA_DIR: actualData,
    ACTUAL_COMPOSE_FILE: path.join(root, 'compose.yml'),
  });
  fs.writeFileSync(env.ACTUAL_COMPOSE_FILE, 'services:\n  actual:\n    image: test\n');
  await assert.rejects(
    () => runCoordinatedBackup({
      ...backupOptions(env, runners, { stopDeadlineMs: 500 }),
      includeActual: true,
      dashboardDir: dashboard,
      destination: env.DARKFINANCES_BACKUP_DIR,
    }),
    /docker compose stop actual failed/,
  );
});

test('active saga without actual snapshot refuses generation-mismatched backup', async (t) => {
  const root = mkRoot(t, 'df-coordinated-saga-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard);
  const runners = createMockRunners({ units: defaultActiveUnits() });
  const env = envFor(root, dashboard);
  await assert.rejects(
    () => runCoordinatedBackup({
      ...backupOptions(env, runners, { stopDeadlineMs: 500 }),
      dashboardDir: dashboard,
      destination: env.DARKFINANCES_BACKUP_DIR,
    }),
    /active saga/,
  );
});

test('backup failure cleans run-owned staging only', async (t) => {
  const root = mkRoot(t, 'df-coordinated-enospc-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const prior = path.join(root, 'backups', 'prior.tgz');
  fs.mkdirSync(path.dirname(prior), { recursive: true, mode: 0o700 });
  fs.writeFileSync(prior, 'prior\n', { mode: 0o600 });
  const runners = createMockRunners({ units: defaultActiveUnits() });
  const original = fs.mkdtempSync;
  fs.mkdtempSync = () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); };
  t.after(() => { fs.mkdtempSync = original; });
  const env = envFor(root, dashboard);
  await assert.rejects(
    () => runCoordinatedBackup({
      ...backupOptions(env, runners, { stopDeadlineMs: 500 }),
      dashboardDir: dashboard,
      destination: env.DARKFINANCES_BACKUP_DIR,
    }),
    /ENOSPC/,
  );
  assert.equal(fs.readFileSync(prior, 'utf8'), 'prior\n');
});

test('multiple restart failures are reported without masking primary backup error', async (t) => {
  const root = mkRoot(t, 'df-coordinated-multi-restart-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const units = defaultActiveUnits();
  units['actual-sync.timer'] = { active: 'active', enabled: 'enabled' };
  const runners = createMockRunners({ units, restartFailures: new Set(['finance-dashboard.service', 'actual-sync.timer']) });
  const originalBuild = require('../lib/build-backup-bundle').buildBackupBundle;
  t.after(() => { require('../lib/build-backup-bundle').buildBackupBundle = originalBuild; });
  const env = envFor(root, dashboard);
  await assert.rejects(
    () => runCoordinatedBackup({
      ...backupOptions(env, runners, { stopDeadlineMs: 500 }),
      buildBackupBundle: () => { throw new Error('checksum mismatch'); },
      dashboardDir: dashboard,
      destination: env.DARKFINANCES_BACKUP_DIR,
    }),
    /checksum mismatch.*restart failures/,
  );
});

test('admission token expires and rejects stale restore binding', (t) => {
  const root = mkRoot(t, 'df-admission-expired-');
  const keys = installTestCoordinatorKeys(root);
  const { token } = buildTestAdmissionToken({ keyPair: keys.pair, ttlMs: 1 });
  assert.throws(() => assertAdmissionFresh(token, Date.now() + 60_000), /expired/);
});

test('hostile unit names are rejected by argv runner guards', () => {
  const { assertSafeUnit, assertSafeContainer } = require('../lib/ops-command-runners');
  assert.throws(() => assertSafeUnit('finance-dashboard.service; rm -rf /'), /unsafe/);
  assert.throws(() => assertSafeContainer('actual$(id)'), /unsafe/);
});

test('relocated install tooling includes coordinated backup modules', () => {
  const sources = bundleToolingSourcePaths();
  assert.ok(sources.includes('ops/lib/coordinated-backup.js'));
  assert.ok(sources.includes('ops/lib/writer-inventory.json'));
  assert.ok(sources.includes('ops/lib/coordinated-backup-cli.js'));
});

test('shell wrapper passes bash -n', () => {
  const syntax = spawnSync('bash', ['-n', coordinatedShell], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('coordinated manifest binds generation fields accepted by PR-17', (t) => {
  const root = mkRoot(t, 'df-coordinated-manifest-');
  const manifestPath = path.join(root, 'bundle.manifest.json');
  const releasePath = path.join(root, 'release.json');
  fs.writeFileSync(manifestPath, '{"artifact":{"id":"abc"}}\n');
  fs.writeFileSync(releasePath, '{"contentDigest":{"value":"def"}}\n');
  const journal = {
    runId: 'run-1',
    journalId: 'j-1',
    inventory: { writerInventoryDigest: 'd'.repeat(64) },
    artifacts: {
      bundleArchive: path.join(root, 'bundle.tgz'),
      bundleManifest: manifestPath,
      releaseManifest: releasePath,
    },
  };
  fs.writeFileSync(path.join(root, 'bundle.tgz'), 'bundle\n');
  const bundleManifest = {
    artifact: { id: 'a'.repeat(64), bundleName: 'dashboard-runtime-backup-bundle.tgz' },
    runtimeState: { inventoryDigest: 'b'.repeat(64) },
    provenance: { sourceCommit: 'abc123' },
  };
  const manifest = buildCoordinatedManifest({
    journal,
    bundleManifest,
    bundleManifestPath: manifestPath,
    releaseManifestPath: releasePath,
  });
  assert.equal(manifest.kind, 'darkfinances-coordinated-backup-manifest');
  assert.match(manifest.generation.bundleArtifactId, /^[a-f0-9]{64}$/);
  assert.equal(manifest.provenanceOnly, true);
  assert.deepEqual(manifest.bindingsAcceptedBy, ['darkfinances-staged-restore-generation-binding']);
});

test('all-active and all-inactive writer combinations discover consistently', (t) => {
  const root = mkRoot(t, 'df-coordinated-combo-');
  const dashboard = path.join(root, 'dashboard');
  fs.mkdirSync(dashboard, { recursive: true });
  const inventory = loadWriterInventory();
  for (const mode of ['active', 'inactive']) {
    const units = {};
    for (const writer of inventory.writers) {
      if (writer.type === 'systemd-timer' || writer.type === 'systemd-service') {
        units[writer.unit] = mode === 'active'
          ? { active: 'active', enabled: 'enabled' }
          : { active: 'inactive', enabled: 'disabled' };
      }
    }
    const runners = createMockRunners({ units });
    const { snapshots } = discoverWriters({ inventory, env: envFor(root, dashboard), runners, dashboardDir: dashboard });
    assert.ok(snapshots.length >= 3);
  }
});

test('restart order restores actual container before dashboard and timers last', async (t) => {
  const root = mkRoot(t, 'df-coordinated-order-');
  const dashboard = path.join(root, 'dashboard');
  const actualData = path.join(root, 'actual', 'data');
  fs.mkdirSync(actualData, { recursive: true });
  fs.writeFileSync(path.join(actualData, 'db'), 'data\n');
  writeProductionDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const runners = createMockRunners({
    units: defaultActiveUnits(),
    containers: { actual: 'running' },
  });
  const env = envFor(root, dashboard, {
    BACKUP_INCLUDE_ACTUAL_DATA: '1',
    ACTUAL_DATA_DIR: actualData,
    ACTUAL_COMPOSE_FILE: path.join(root, 'compose.yml'),
  });
  fs.writeFileSync(env.ACTUAL_COMPOSE_FILE, 'services:\n  actual:\n    image: test\n');
  await runCoordinatedBackup({
    ...backupOptions(env, runners),
    includeActual: true,
    dashboardDir: dashboard,
    destination: env.DARKFINANCES_BACKUP_DIR,
  });
  const actualStart = runners.commands.findIndex((entry) => entry[0] === 'docker' && entry.includes('start'));
  const dashboardStart = runners.commands.findIndex((entry) => entry.includes('finance-dashboard.service') && entry.includes('start'));
  const timerStart = runners.commands.findIndex((entry) => entry.includes('actual-sync.timer') && entry.includes('start'));
  assert.ok(actualStart >= 0);
  assert.ok(dashboardStart > actualStart);
  assert.ok(timerStart > dashboardStart);
});

test('health check fails on stale dashboard readiness', async (t) => {
  const root = mkRoot(t, 'df-coordinated-health-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const runners = createMockRunners({
    units: defaultActiveUnits(),
    pingResponse: { status: 503, body: { ok: false } },
  });
  const env = envFor(root, dashboard);
  await assert.rejects(
    () => runCoordinatedBackup({
      ...backupOptions(env, runners, { stopDeadlineMs: 500 }),
      dashboardDir: dashboard,
      destination: env.DARKFINANCES_BACKUP_DIR,
    }),
    /post-restart health verification failed/,
  );
  const journal = readRunJournal(path.join(env.DARKFINANCES_BACKUP_DIR, '.darkfinances-coordinated/run-journal.json'));
  assert.equal(journal.phase, PHASE.RECOVERY_REQUIRED);
});

test('symlinked backup destination root is rejected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-coordinated-symlink-'));
  try {
    const target = path.join(root, 'target');
    const link = path.join(root, 'link');
    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(target, link);
    assert.throws(() => coordinatedLayoutForRoot(link), /symbolic link/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writer reappears after stop fails verification', async (t) => {
  const root = mkRoot(t, 'df-coordinated-reappear-');
  const dashboard = path.join(root, 'dashboard');
  fs.mkdirSync(dashboard, { recursive: true });
  const inventory = loadWriterInventory();
  const runners = createMockRunners({
    units: defaultActiveUnits(),
    reappearingWriters: ['finance-dashboard.service'],
  });
  const context = { inventory, env: envFor(root, dashboard), runners, dashboardDir: dashboard, pollMs: 1, stopDeadlineMs: 20 };
  const { writers, snapshots } = discoverWriters(context);
  context.writers = writers;
  const map = snapshotsMap(snapshots);
  for (const phase of ['timers', 'jobs', 'dashboard']) {
    await stopWritersByPhase(context, map, phase);
  }
  const verify = await verifyAllQuiescent(context, map);
  assert.equal(verify.ok, false);
});

test('manual restart phase honors originally inactive components', async (t) => {
  const root = mkRoot(t, 'df-coordinated-manual-restart-');
  const dashboard = path.join(root, 'dashboard');
  fs.mkdirSync(dashboard, { recursive: true });
  const inventory = loadWriterInventory();
  const runners = createMockRunners({
    units: {
      'finance-dashboard.service': { active: 'inactive', enabled: 'disabled' },
      'actual-sync.timer': { active: 'inactive', enabled: 'disabled' },
      'actual-sync.service': { active: 'inactive', enabled: 'disabled' },
    },
  });
  const context = { inventory, env: envFor(root, dashboard), runners, dashboardDir: dashboard };
  const { writers, snapshots } = discoverWriters(context);
  context.writers = writers;
  const map = snapshotsMap(snapshots);
  const results = await restartWritersByPhase(context, map, 'dashboard');
  assert.ok(results.every((entry) => entry.skipped));
  assert.equal(runners.commands.some((entry) => entry.includes('start')), false);
});

test('captureWriterState records pre-run active/enabled/running flags', () => {
  const inventory = loadWriterInventory();
  const writer = inventory.writers.find((entry) => entry.id === 'finance-dashboard');
  const runners = createMockRunners({ units: defaultActiveUnits() });
  const snapshot = captureWriterState(writer, { runners, env: {}, dashboardDir: '/tmp/x' });
  assert.equal(snapshot.originallyActive, true);
  assert.equal(snapshot.originallyEnabled, true);
  assert.equal(snapshot.originallyRunning, true);
});

test('stale coordinated lock from dead pid is removed and backup proceeds', async (t) => {
  const root = mkRoot(t, 'df-coordinated-stale-lock-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const env = envFor(root, dashboard);
  const layout = coordinatedLayoutForRoot(env.DARKFINANCES_BACKUP_DIR);
  fs.mkdirSync(layout.canonicalRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(layout.lockPath, `${JSON.stringify({
    kind: 'darkfinances-coordinated-lock',
    schemaVersion: 1,
    pid: 999999,
    operation: 'backup',
    canonicalRoot: layout.canonicalRoot,
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  const runners = createMockRunners({ units: defaultActiveUnits() });
  const result = await runCoordinatedBackup({
    ...backupOptions(env, runners),
    dashboardDir: dashboard,
    destination: env.DARKFINANCES_BACKUP_DIR,
  });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(layout.lockPath), false);
});

test('incomplete run journal resumes with preserved pre-run writer snapshots', async (t) => {
  const root = mkRoot(t, 'df-coordinated-journal-resume-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const env = envFor(root, dashboard);
  const layout = coordinatedLayoutForRoot(env.DARKFINANCES_BACKUP_DIR);
  fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  const inventory = loadWriterInventory();
  const runners = createMockRunners({ units: defaultActiveUnits() });
  const { snapshots } = discoverWriters({
    inventory,
    env,
    runners,
    dashboardDir: dashboard,
  });
  const timerSnapshot = snapshots.find((entry) => entry.id === 'actual-sync.timer');
  timerSnapshot.originallyActive = false;
  timerSnapshot.originallyEnabled = false;
  timerSnapshot.active = false;
  timerSnapshot.enabled = false;
  const journal = createRunJournal({
    runId: 'resume-run',
    operation: 'backup',
    layout,
    writerInventory: inventory,
    preRunWriters: snapshots,
    options: { includeActualData: false, preQuiesced: false, dashboardDir: dashboard },
  });
  journal.phase = PHASE.WRITERS_CAPTURED;
  writeRunJournal(layout.journalPath, journal);
  await runCoordinatedBackup({
    ...backupOptions(env, runners),
    dashboardDir: dashboard,
    destination: env.DARKFINANCES_BACKUP_DIR,
  });
  assert.equal(
    runners.commands.some((entry) => entry.includes('actual-sync.timer') && entry.includes('start')),
    false,
  );
});

test('interrupt during quiescence records recovery_required in journal', async (t) => {
  const root = mkRoot(t, 'df-coordinated-signal-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  let triggerInterrupt = false;
  const runners = createMockRunners({ units: defaultActiveUnits(), hungDrain: true });
  const originalStop = runners.systemctlStop.bind(runners);
  runners.systemctlStop = (scope, unit) => {
    if (unit === 'finance-dashboard.service') triggerInterrupt = true;
    return originalStop(scope, unit);
  };
  const env = envFor(root, dashboard);
  await assert.rejects(
    () => runCoordinatedBackup({
      ...backupOptions(env, runners, { stopDeadlineMs: 150, pollMs: 5 }),
      shouldInterrupt: () => triggerInterrupt,
      dashboardDir: dashboard,
      destination: env.DARKFINANCES_BACKUP_DIR,
    }),
    /interrupted during quiescence/,
  );
  const journal = readRunJournal(path.join(env.DARKFINANCES_BACKUP_DIR, '.darkfinances-coordinated/run-journal.json'));
  assert.equal(journal.phase, PHASE.RECOVERY_REQUIRED);
});

test('post-restart health fails on actual data generation mismatch', async () => {
  const actualDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-coordinated-gen-'));
  fs.writeFileSync(path.join(actualDataDir, 'db'), 'before\n');
  const { computeActualDataGeneration } = require('../lib/writer-quiescence');
  const expected = computeActualDataGeneration(actualDataDir);
  fs.writeFileSync(path.join(actualDataDir, 'db'), 'after\n');
  const runners = createMockRunners({ units: defaultActiveUnits(), containers: { actual: 'running' } });
  const env = {
    ...process.env,
    BACKUP_INCLUDE_ACTUAL_DATA: '1',
    ACTUAL_DATA_DIR: actualDataDir,
  };
  const health = await runPostRestartHealthChecks({
    writers: loadWriterInventory().writers,
    snapshotsById: new Map(),
    env,
    runners,
    expectedActualGeneration: expected,
    timeoutMs: 50,
    pollMs: 1,
  });
  assert.equal(health.ok, false);
  assert.ok(health.results.some((entry) => /generation mismatch/.test(entry.error || '')));
});

test('admission token rejects archive and destination binding drift', (t) => {
  const root = mkRoot(t, 'df-admission-drift-');
  const keys = installTestCoordinatorKeys(root);
  const { token } = buildTestAdmissionToken({
    keyPair: keys.pair,
    bindings: {
      archiveSha256: 'a'.repeat(64),
      destinationRoot: '/tmp/dashboard-a',
    },
  });
  assert.throws(
    () => assertAdmissionBindings(token, {
      archiveSha256: 'b'.repeat(64),
      destinationRoot: '/tmp/dashboard-a',
    }),
    /archive binding mismatch/,
  );
  assert.throws(
    () => assertAdmissionBindings(token, {
      archiveSha256: 'a'.repeat(64),
      destinationRoot: '/tmp/dashboard-b',
    }),
    /destination binding mismatch/,
  );
});

test('post-restart health fails when release digest is missing from ping', async () => {
  const runners = createMockRunners({
    units: defaultActiveUnits(),
    pingResponse: {
      status: 200,
      body: { ok: true, release: {} },
    },
  });
  const health = await runPostRestartHealthChecks({
    writers: [],
    snapshotsById: new Map(),
    env: { ...process.env, FINANCE_API_TOKEN: 'test-token' },
    runners,
    expectedReleaseGeneration: RELEASE_MANIFEST_DIGEST,
    timeoutMs: 50,
    pollMs: 1,
  });
  assert.equal(health.ok, false);
  assert.ok(health.results.some((entry) => /release digest missing/.test(entry.error || '')));
});

test('timer trigger race during stop fails closed', async (t) => {
  const root = mkRoot(t, 'df-coordinated-trigger-race-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const runners = createMockRunners({ units: defaultActiveUnits(), timerFiresDuringStop: true });
  const env = envFor(root, dashboard);
  await assert.rejects(
    () => runCoordinatedBackup({
      ...backupOptions(env, runners, { stopDeadlineMs: 200 }),
      dashboardDir: dashboard,
      destination: env.DARKFINANCES_BACKUP_DIR,
    }),
    /quiescence verification failed|did not quiesce/,
  );
});

test('systemd stop failure refuses backup before snapshot', async (t) => {
  const root = mkRoot(t, 'df-coordinated-systemctl-stop-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const runners = createMockRunners({
    units: defaultActiveUnits(),
    stopFailures: new Set(['finance-dashboard.service']),
  });
  const env = envFor(root, dashboard);
  await assert.rejects(
    () => runCoordinatedBackup({
      ...backupOptions(env, runners, { stopDeadlineMs: 500 }),
      dashboardDir: dashboard,
      destination: env.DARKFINANCES_BACKUP_DIR,
    }),
    /systemctl stop finance-dashboard.service failed/,
  );
});

test('BACKUP_QUIESCE=0 is forbidden', async (t) => {
  const root = mkRoot(t, 'df-coordinated-no-quiesce-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const env = envFor(root, dashboard, { BACKUP_QUIESCE: '0' });
  await assert.rejects(
    () => runCoordinatedBackup({
      ...backupOptions(env, createMockRunners({ units: defaultActiveUnits() })),
      dashboardDir: dashboard,
      destination: env.DARKFINANCES_BACKUP_DIR,
    }),
    /BACKUP_QUIESCE=0 is forbidden/,
  );
});

test('BACKUP_PRE_QUIESCED=1 rejects active writers and mints no restore token', async (t) => {
  const root = mkRoot(t, 'df-coordinated-pre-quiesced-active-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const env = envFor(root, dashboard, { BACKUP_PRE_QUIESCED: '1' });
  await assert.rejects(
    () => runCoordinatedBackup({
      ...backupOptions(env, createMockRunners({ units: defaultActiveUnits() }), { stopDeadlineMs: 200 }),
      preQuiesced: true,
      dashboardDir: dashboard,
      destination: env.DARKFINANCES_BACKUP_DIR,
    }),
    /quiescence verification failed|did not quiesce/,
  );
});

test('quiescence_verified resume with active writer fails before snapshot', async (t) => {
  const root = mkRoot(t, 'df-coordinated-resume-active-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const env = envFor(root, dashboard);
  const layout = coordinatedLayoutForRoot(env.DARKFINANCES_BACKUP_DIR);
  fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  const inventory = loadWriterInventory();
  const runners = createMockRunners({ units: defaultActiveUnits() });
  const { snapshots } = discoverWriters({ inventory, env, runners, dashboardDir: dashboard });
  const journal = createRunJournal({
    runId: 'resume-active',
    operation: 'backup',
    layout,
    writerInventory: inventory,
    preRunWriters: snapshots,
    options: { includeActualData: false, preQuiesced: false, dashboardDir: dashboard },
  });
  journal.phase = PHASE.QUIESCENCE_VERIFIED;
  writeRunJournal(layout.journalPath, journal);
  const activeRunners = createMockRunners({
    units: defaultActiveUnits(),
    reappearingWriters: ['finance-dashboard.service'],
  });
  await assert.rejects(
    () => runCoordinatedBackup({
      ...backupOptions(env, activeRunners, { stopDeadlineMs: 200 }),
      dashboardDir: dashboard,
      destination: env.DARKFINANCES_BACKUP_DIR,
    }),
    /quiescence verification failed|did not quiesce/,
  );
});

test('journal resume uses preserved snapshots when live discovery would fail', async (t) => {
  const root = mkRoot(t, 'df-coordinated-resume-unknown-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const env = envFor(root, dashboard);
  const layout = coordinatedLayoutForRoot(env.DARKFINANCES_BACKUP_DIR);
  fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  const inventory = loadWriterInventory();
  const goodRunners = createMockRunners({ units: defaultActiveUnits() });
  const { snapshots } = discoverWriters({
    inventory,
    env,
    runners: goodRunners,
    dashboardDir: dashboard,
  });
  const journal = createRunJournal({
    runId: 'resume-unknown',
    operation: 'backup',
    layout,
    writerInventory: inventory,
    preRunWriters: snapshots,
    options: { includeActualData: false, preQuiesced: false, dashboardDir: dashboard },
  });
  journal.phase = PHASE.WRITERS_CAPTURED;
  writeRunJournal(layout.journalPath, journal);
  const badRunners = createMockRunners({
    units: {
      ...defaultActiveUnits(),
      'finance-dashboard.service': { active: 'unknown', enabled: 'enabled' },
    },
  });
  await assert.rejects(
    () => runCoordinatedBackup({
      ...backupOptions(env, badRunners),
      dashboardDir: dashboard,
      destination: env.DARKFINANCES_BACKUP_DIR,
    }),
    /unknown state/,
  );
});

test('journal resume at backup_complete skips republish and finishes restart', async (t) => {
  const root = mkRoot(t, 'df-coordinated-resume-backup-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const env = envFor(root, dashboard);
  const layout = coordinatedLayoutForRoot(env.DARKFINANCES_BACKUP_DIR);
  fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  const inventory = loadWriterInventory();
  const setupRunners = createMockRunners({ units: defaultActiveUnits() });
  const { snapshots } = discoverWriters({
    inventory,
    env,
    runners: setupRunners,
    dashboardDir: dashboard,
  });
  const bundleArchive = path.join(env.DARKFINANCES_BACKUP_DIR, 'existing-bundle.tgz');
  fs.mkdirSync(env.DARKFINANCES_BACKUP_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(bundleArchive, 'bundle\n', { mode: 0o600 });
  const coordinatedManifest = path.join(env.DARKFINANCES_BACKUP_DIR, 'coordinated-backup-resume.json');
  fs.writeFileSync(coordinatedManifest, `${JSON.stringify({
    generation: {
      releaseManifestDigest: RELEASE_MANIFEST_DIGEST,
      actualDataGeneration: null,
    },
  }, null, 2)}\n`, { mode: 0o600 });
  const journal = createRunJournal({
    runId: 'resume-backup',
    operation: 'backup',
    layout,
    writerInventory: inventory,
    preRunWriters: snapshots,
    options: { includeActualData: false, preQuiesced: false, dashboardDir: dashboard },
  });
  journal.phase = PHASE.BACKUP_COMPLETE;
  journal.artifacts = {
    bundleArchive,
    bundleManifest: `${bundleArchive}.manifest.json`,
    releaseManifest: path.join(env.DARKFINANCES_BACKUP_DIR, 'release.json'),
    coordinatedManifest,
  };
  writeRunJournal(layout.journalPath, journal);
  const runners = createMockRunners({
    units: {
      'actual-sync.timer': { active: 'inactive', enabled: 'enabled' },
      'actual-sync.service': { active: 'inactive', enabled: 'enabled' },
      'finance-dashboard.service': { active: 'inactive', enabled: 'enabled' },
    },
  });
  const buildCalls = { count: 0 };
  const originalBuild = require('../lib/build-backup-bundle').buildBackupBundle;
  require('../lib/build-backup-bundle').buildBackupBundle = () => {
    buildCalls.count += 1;
    return originalBuild.apply(this, arguments);
  };
  t.after(() => { require('../lib/build-backup-bundle').buildBackupBundle = originalBuild; });
  const result = await runCoordinatedBackup({
    ...backupOptions(env, runners, {
      writeReleaseManifest: stubReleaseManifest(),
    }),
    dashboardDir: dashboard,
    destination: env.DARKFINANCES_BACKUP_DIR,
  });
  assert.equal(buildCalls.count, 0);
  assert.equal(result.resumed, true);
  assert.equal(result.bundleArchive, bundleArchive);
  assert.equal(result.journal.phase, PHASE.COMPLETE);
  assert.equal(buildCalls.count, 0);
});

test('writerStatesForAdmission throws when required writer is active', () => {
  const map = snapshotsMap([
    { id: 'finance-dashboard', state: 'active', originallyActive: true, originallyRunning: true },
  ]);
  assert.throws(
    () => require('../lib/writer-quiescence').writerStatesForAdmission(map),
    /not quiescent/,
  );
});

test('docker restart policy is disabled during quiescence and restored on restart', async (t) => {
  const root = mkRoot(t, 'df-docker-policy-');
  const compose = path.join(root, 'compose.yml');
  fs.writeFileSync(compose, 'services:\n  actual:\n    image: test\n', { mode: 0o600 });
  const inventory = loadWriterInventory();
  const writer = inventory.writers.find((entry) => entry.id === 'actual-container');
  const runners = createMockRunners({
    units: defaultActiveUnits(),
    containers: { actual: 'running' },
    restartPolicies: { actual: 'unless-stopped' },
  });
  const context = {
    inventory,
    env: { ACTUAL_COMPOSE_FILE: compose, BACKUP_INCLUDE_ACTUAL_DATA: '1', HOME: root },
    runners,
    dashboardDir: path.join(root, 'dashboard'),
    pollMs: 1,
    stopDeadlineMs: 50,
  };
  const snapshot = captureWriterState(writer, context);
  snapshot.originallyRunning = true;
  snapshot.originallyActive = true;
  snapshot.restartPolicy = 'unless-stopped';
  context.writers = [writer];
  await stopWriter(writer, snapshot, context);
  assert.ok(runners.commands.some((entry) => entry.includes('update') && entry.includes('--restart=no')));
  await restartWriter(writer, snapshot, context);
  assert.ok(runners.commands.some((entry) => entry.includes('update') && entry.includes('--restart=unless-stopped')));
});

test('journal resume rejects writer inventory digest drift', async (t) => {
  const root = mkRoot(t, 'df-coordinated-digest-drift-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const env = envFor(root, dashboard);
  const layout = coordinatedLayoutForRoot(env.DARKFINANCES_BACKUP_DIR);
  fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  const inventory = loadWriterInventory();
  const runners = createMockRunners({ units: defaultActiveUnits() });
  const journal = createRunJournal({
    runId: 'digest-drift',
    operation: 'backup',
    layout,
    writerInventory: inventory,
    preRunWriters: [],
    options: { includeActualData: false, preQuiesced: false, dashboardDir: dashboard },
  });
  journal.inventory.writerInventoryDigest = '0'.repeat(64);
  journal.phase = PHASE.WRITERS_CAPTURED;
  writeRunJournal(layout.journalPath, journal);
  await assert.rejects(
    () => runCoordinatedBackup({
      ...backupOptions(env, runners),
      dashboardDir: dashboard,
      destination: env.DARKFINANCES_BACKUP_DIR,
    }),
    /writer inventory digest mismatch/,
  );
});

test('signed admission token rejects forgery and wrong verification key', (t) => {
  const root = mkRoot(t, 'df-admission-forgery-');
  const keys = installTestCoordinatorKeys(root);
  const other = installTestCoordinatorKeys(path.join(root, 'other'));
  const { token } = buildTestAdmissionToken({ keyPair: keys.pair });
  token.signature = 'AAAA';
  assert.throws(
    () => parseAdmissionToken(JSON.stringify(token), 'token', { publicKey: keys.pair.publicKey }),
    /signature verification failed/,
  );
  const { token: good } = buildTestAdmissionToken({ keyPair: keys.pair });
  assert.throws(
    () => parseAdmissionToken(JSON.stringify(good), 'token', { publicKey: other.pair.publicKey }),
    /signature verification failed/,
  );
});

test('tooling closure includes coordinated restore and build-backup dependencies', () => {
  const sources = bundleToolingSourcePaths();
  assert.ok(sources.includes('ops/lib/build-backup-bundle.js'));
  assert.ok(sources.includes('ops/lib/coordinated-admission-crypto.js'));
  assert.ok(sources.includes('ops/lib/coordinated-restore.js'));
});

test('shell wrapper dry-run exits 2 without mutating destination', (t) => {
  const root = mkRoot(t, 'df-coordinated-shell-dry-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const fakeBin = path.join(root, 'bin');
  fs.mkdirSync(fakeBin, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fakeBin, 'systemctl'), `#!/usr/bin/env bash
set -euo pipefail
unit="\${@: -1}"
case " \$* " in
  *" is-active "*) case "$unit" in
    finance-dashboard.service|actual-sync.timer) echo active; exit 0 ;;
    *) echo inactive; exit 3 ;;
  esac ;;
  *" is-enabled "*) echo enabled; exit 0 ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
  const env = {
    ...process.env,
    HOME: root,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
    FINANCE_DASHBOARD_DIR: dashboard,
    DARKFINANCES_BACKUP_DIR: path.join(root, 'backups'),
    DARKFINANCES_REPO_ROOT: repoRoot,
    BACKUP_DRY_RUN: '1',
  };
  const result = spawnSync('bash', [coordinatedShell], {
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(env.DARKFINANCES_BACKUP_DIR, '.darkfinances-coordinated')), false);
});
