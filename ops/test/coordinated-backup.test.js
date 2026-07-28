'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runCoordinatedBackup, buildCoordinatedManifest, LEGACY_IDENTITY_RECOVERY_MESSAGE, publishAtomic, writeChecksumSidecar } = require('../lib/coordinated-backup');
const {
  publishFileDurable,
  publishSidecarFromStaging,
  writeChecksumSidecarDurable,
  fsyncPath,
  DIRECTORY_FSYNC_UNSUPPORTED_CODES,
} = require('../lib/restore-durable-io');
const {
  assertArchivePublicationCommitted,
  isArchivePublicationCommitted,
  cleanupPartialRunPublication,
  createRunPublicationTracker,
} = require('../lib/backup-publication-contract');
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
  createEphemeralSigningMaterial,
  createSignedBackupReleaseStub,
  writeSignedReleaseEvidence,
} = require('./helpers/release-signing-fixtures');
const {
  defaultActiveUnits,
} = require('./fixtures/coordinated-backup-fixtures');
const {
  createBackupRunners,
  defaultEnvelopedPingResponse,
  writeSchemaV1ReleaseManifest,
  writeSchemaV2ReleaseManifest,
  envelopedPingBody,
  SCHEMA_V1_RELEASE_IDENTITY,
  SCHEMA_V1_RELEASE_IDENTITY_DIGEST,
  RELEASE_MANIFEST_BODY,
  RELEASE_MANIFEST_DIGEST,
} = require('./fixtures/coordinated-backup-release-identity-fixtures');
const {
  normalizeReleaseIdentity,
  captureDashboardReleaseIdentity,
  runPostRestartHealthChecks,
  resolveActualServerDataDir,
  checkActualContainerHealth,
  checkSystemdUnitHealth,
} = require('../lib/coordinated-backup-health');
const { verifyBackupBundleArchive } = require('../lib/backup-bundle-verify');
const { buildBackupBundle } = require('../lib/build-backup-bundle');
const { bundleToolingSourcePaths } = require('../lib/backup-bundle-tooling');
const { sha256File } = require('../lib/backup-verify');
const { writeProductionDashboard } = require('./fixtures/backup-bundle-dashboard-fixtures');
const { createDefaultRunners } = require('../lib/ops-command-runners');
const {
  signaturePathFor,
  verifySignedManifest,
} = require('../../finance-dashboard/lib/release-signing');

const repoRoot = path.resolve(__dirname, '..', '..');
const coordinatedShell = path.join(repoRoot, 'ops/bin/backup-coordinated.sh');

function mkRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeBackupDashboard(dashboard, options = {}) {
  writeProductionDashboard(dashboard, options);
  if (options.includeReleaseManifest !== false) {
    writeSchemaV1ReleaseManifest(dashboard, options.releaseIdentity);
  }
  return dashboard;
}

function stubReleaseManifest(signing) {
  return createSignedBackupReleaseStub(signing);
}

function backupOptions(base, runners, extra = {}) {
  const signing = extra.signing
    || (base.RELEASE_KEYRING_PATH && base.RELEASE_SIGNING_KEY_PATH
      ? {
        signingPath: base.RELEASE_SIGNING_KEY_PATH,
        keyringPath: base.RELEASE_KEYRING_PATH,
        signingEnv: {
          RELEASE_SIGNING_KEY_PATH: base.RELEASE_SIGNING_KEY_PATH,
          RELEASE_KEYRING_PATH: base.RELEASE_KEYRING_PATH,
        },
      }
      : createEphemeralSigningMaterial(
        extra.root || path.dirname(base.DARKFINANCES_BACKUP_DIR || base.HOME || os.tmpdir()),
      ));
  const mergedEnv = { ...base, ...signing.signingEnv };
  return {
    pollMs: 1,
    stopDeadlineMs: 2000,
    healthTimeoutMs: 200,
    healthPollMs: 10,
    registerSignalHandlers: false,
    writeReleaseManifest: stubReleaseManifest(signing),
    signing,
    ...extra,
    env: mergedEnv,
    runners,
  };
}
function envFor(root, dashboard, extra = {}) {
  const signing = extra.signing || createEphemeralSigningMaterial(root);
  return {
    ...process.env,
    HOME: root,
    FINANCE_DASHBOARD_DIR: dashboard,
    DARKFINANCES_BACKUP_DIR: path.join(root, 'backups'),
    DARKFINANCES_REPO_ROOT: repoRoot,
    COORDINATED_TEST_SKIP_LOCK: '0',
    BACKUP_INCLUDE_ACTUAL_DATA: '0',
    FINANCE_API_TOKEN: 'test-token',
    ...signing.signingEnv,
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
  const runners = createBackupRunners({ units: defaultActiveUnits() });
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
  writeBackupDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const runners = createBackupRunners({ units: defaultActiveUnits() });
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
  writeBackupDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const runners = createBackupRunners();
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
  assert.equal(manifest.generation.dashboardReleaseIdentityDigest, SCHEMA_V1_RELEASE_IDENTITY_DIGEST);
  assert.notEqual(manifest.generation.releaseManifestDigest, manifest.generation.dashboardReleaseIdentityDigest);
  assert.equal(manifest.schemaVersion, 2);
  const stopIndex = runners.commands.findIndex((entry) => entry.includes('actual-sync.timer') && entry.includes('stop'));
  const dashboardStop = runners.commands.findIndex((entry) => entry.includes('finance-dashboard.service') && entry.includes('stop'));
  const dashboardStart = runners.commands.findIndex((entry) => entry.includes('finance-dashboard.service') && entry.includes('start'));
  assert.ok(stopIndex >= 0);
  assert.ok(dashboardStop > stopIndex);
  assert.ok(dashboardStart > dashboardStop);
  const journal = readRunJournal(path.join(env.DARKFINANCES_BACKUP_DIR, '.darkfinances-coordinated/run-journal.json'));
  assert.equal(journal.phase, PHASE.COMPLETE);
  assert.equal(journal.generationBindings?.dashboardReleaseIdentityDigest, SCHEMA_V1_RELEASE_IDENTITY_DIGEST);
  assert.equal(journal.generationBindings?.identityBindingSource, 'live_capture');
});

test('FINANCE_EVENT_SYNC_CONFIGURED=1 quiesces active finance-event-sync writers end-to-end', async (t) => {
  const root = mkRoot(t, 'df-coordinated-event-sync-');
  const dashboard = path.join(root, 'dashboard');
  writeBackupDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const units = {
    ...defaultActiveUnits(),
    'finance-event-sync.timer': { active: 'active', enabled: 'enabled' },
    'finance-event-sync.service': { active: 'active', enabled: 'enabled' },
  };
  const runners = createBackupRunners({ units });
  const env = envFor(root, dashboard, { FINANCE_EVENT_SYNC_CONFIGURED: '1' });
  const result = await runCoordinatedBackup({
    ...backupOptions(env, runners),
    dashboardDir: dashboard,
    destination: env.DARKFINANCES_BACKUP_DIR,
  });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(result.bundleArchive), true);

  const eventTimerStop = runners.commands.findIndex(
    (entry) => entry.includes('finance-event-sync.timer') && entry.includes('stop'),
  );
  const eventServiceStop = runners.commands.findIndex(
    (entry) => entry.includes('finance-event-sync.service') && entry.includes('stop'),
  );
  const actualSyncTimerStop = runners.commands.findIndex(
    (entry) => entry.includes('actual-sync.timer') && entry.includes('stop'),
  );
  const dashboardStop = runners.commands.findIndex(
    (entry) => entry.includes('finance-dashboard.service') && entry.includes('stop'),
  );
  assert.ok(eventTimerStop >= 0);
  assert.ok(eventServiceStop >= 0);
  assert.ok(actualSyncTimerStop >= 0);
  assert.ok(actualSyncTimerStop < eventTimerStop);
  assert.ok(eventTimerStop < dashboardStop);
  assert.ok(eventServiceStop < dashboardStop);
  assert.ok(actualSyncTimerStop < eventServiceStop);

  const eventTimerStart = runners.commands.findIndex(
    (entry) => entry.includes('finance-event-sync.timer') && entry.includes('start'),
  );
  const eventServiceStart = runners.commands.findIndex(
    (entry) => entry.includes('finance-event-sync.service') && entry.includes('start'),
  );
  const dashboardStart = runners.commands.findIndex(
    (entry) => entry.includes('finance-dashboard.service') && entry.includes('start'),
  );
  assert.ok(eventTimerStart > dashboardStart);
  assert.ok(eventServiceStart > dashboardStart);

  const journal = readRunJournal(path.join(env.DARKFINANCES_BACKUP_DIR, '.darkfinances-coordinated/run-journal.json'));
  assert.equal(journal.phase, PHASE.COMPLETE);
  const timerSnapshot = journal.preRunWriters.find((entry) => entry.id === 'finance-event-sync.timer');
  const serviceSnapshot = journal.preRunWriters.find((entry) => entry.id === 'finance-event-sync.service');
  assert.equal(timerSnapshot?.originallyActive, true);
  assert.equal(serviceSnapshot?.originallyActive, true);
});

test('FINANCE_EVENT_SYNC_CONFIGURED=1 rejects legacy owes-snapshot cron before quiescence', async (t) => {
  const root = mkRoot(t, 'df-coordinated-event-sync-cron-');
  const dashboard = path.join(root, 'dashboard');
  writeBackupDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const runners = createBackupRunners({
    units: {
      ...defaultActiveUnits(),
      'finance-event-sync.timer': { active: 'active', enabled: 'enabled' },
      'finance-event-sync.service': { active: 'inactive', enabled: 'enabled' },
    },
    crontabListing: '*/30 * * * * bash /home/dark/actual-tools/run.sh owes-snapshot.js\n',
  });
  const env = envFor(root, dashboard, { FINANCE_EVENT_SYNC_CONFIGURED: '1' });
  await assert.rejects(
    () => runCoordinatedBackup({
      ...backupOptions(env, runners),
      dashboardDir: dashboard,
      destination: env.DARKFINANCES_BACKUP_DIR,
    }),
    /legacy owes-snapshot\.js cron entry must be removed/,
  );
  assert.equal(runners.commands.some((entry) => entry.includes('finance-dashboard.service') && entry.includes('stop')), false);
});

test('originally inactive timer is not started on restart', async (t) => {
  const root = mkRoot(t, 'df-coordinated-inactive-');
  const dashboard = path.join(root, 'dashboard');
  writeBackupDashboard(dashboard, {
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
  const runners = createBackupRunners({ units });
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
  writeBackupDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const runners = createBackupRunners({ units: defaultActiveUnits(), hungDrain: true });
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
  writeBackupDashboard(dashboard, {
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
  const runners = createBackupRunners({
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
  const runners = createBackupRunners({
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
  writeBackupDashboard(dashboard, {
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
  const runners = createBackupRunners({ units: defaultActiveUnits() });
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
  writeBackupDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const runners = createBackupRunners({
    units: defaultActiveUnits(),
    containers: { actual: 'running' },
    stopFailures: new Set(['actual']),
  });
  const env = envFor(root, dashboard, {
    BACKUP_INCLUDE_ACTUAL_DATA: '1',
    ACTUAL_SERVER_DATA_DIR: actualData,
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
  writeBackupDashboard(dashboard);
  const runners = createBackupRunners({ units: defaultActiveUnits() });
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
  writeBackupDashboard(dashboard, {
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
  const runners = createBackupRunners({ units: defaultActiveUnits() });
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
  writeBackupDashboard(dashboard, {
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
  const runners = createBackupRunners({ units, restartFailures: new Set(['finance-dashboard.service', 'actual-sync.timer']) });
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
  assert.ok(sources.includes('finance-dashboard/lib/release-identity.js'));
  assert.ok(sources.includes('finance-dashboard/lib/release-files.js'));
  assert.ok(sources.includes('ops/lib/writer-inventory.json'));
  assert.ok(sources.includes('ops/lib/coordinated-backup-cli.js'));
});

test('relocated bundle tooling captures schema-v2 release identity from manifest when pre-quiesced', async (t) => {
  const root = mkRoot(t, 'df-relocated-v2-capture-');
  const dashboard = path.join(root, 'dashboard');
  writeBackupDashboard(dashboard, { includeReleaseManifest: false });
  const signing = createEphemeralSigningMaterial(dashboard);
  writeSchemaV2ReleaseManifest(dashboard, undefined, { signing });
  const keyringPath = signing.keyringPath;
  const backups = path.join(root, 'backups');
  fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
  const archive = path.join(backups, 'bundle.tgz');
  buildBackupBundle({ dashboardDir: dashboard, archivePath: archive });
  const extractRoot = path.join(root, 'extract');
  verifyBackupBundleArchive({ archivePath: archive, publishDir: extractRoot, readOnly: true });
  const healthModule = path.join(extractRoot, 'tooling/ops/lib/coordinated-backup-health.js');
  assert.equal(fs.existsSync(healthModule), true);
  assert.equal(
    fs.existsSync(path.join(extractRoot, 'tooling/finance-dashboard/lib/release-identity.js')),
    true,
  );
  const { captureDashboardReleaseIdentity } = require(healthModule);
  const digest = await captureDashboardReleaseIdentity({
    dashboardDir: dashboard,
    preQuiesced: true,
    env: { ...process.env, FINANCE_API_TOKEN: 'test-token', RELEASE_KEYRING_PATH: keyringPath },
    runners: createBackupRunners({
      units: {
        'actual-sync.timer': { active: 'inactive', enabled: 'enabled' },
        'actual-sync.service': { active: 'inactive', enabled: 'enabled' },
        'finance-dashboard.service': { active: 'inactive', enabled: 'enabled' },
      },
    }),
    snapshotsById: new Map(),
    timeoutMs: 200,
    pollMs: 1,
  });
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.notEqual(digest, SCHEMA_V1_RELEASE_IDENTITY_DIGEST);
});

test('shell wrapper passes bash -n', () => {
  const syntax = spawnSync('bash', ['-n', coordinatedShell], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('coordinated manifest binds generation fields accepted by PR-17', (t) => {
  const root = mkRoot(t, 'df-coordinated-manifest-');
  const signing = createEphemeralSigningMaterial(root);
  const manifestPath = path.join(root, 'bundle.manifest.json');
  const releasePath = path.join(root, 'release.json');
  fs.writeFileSync(manifestPath, '{"artifact":{"id":"abc"}}\n');
  fs.writeFileSync(path.join(root, 'bundle.tgz'), 'bundle\n');
  writeSignedReleaseEvidence(releasePath, manifestPath, path.join(root, 'bundle.tgz'), signing);
  const releaseSignaturePath = `${releasePath}.sig.json`;
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
    releaseSignaturePath,
    dashboardReleaseIdentityDigest: SCHEMA_V1_RELEASE_IDENTITY_DIGEST,
  });
  assert.equal(manifest.kind, 'darkfinances-coordinated-backup-manifest');
  assert.match(manifest.generation.bundleArtifactId, /^[a-f0-9]{64}$/);
  assert.equal(manifest.generation.dashboardReleaseIdentityDigest, SCHEMA_V1_RELEASE_IDENTITY_DIGEST);
  assert.notEqual(manifest.generation.releaseManifestDigest, manifest.generation.dashboardReleaseIdentityDigest);
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
    const runners = createBackupRunners({ units });
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
  writeBackupDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const runners = createBackupRunners({
    units: defaultActiveUnits(),
    containers: { actual: 'running' },
  });
  const env = envFor(root, dashboard, {
    BACKUP_INCLUDE_ACTUAL_DATA: '1',
    ACTUAL_SERVER_DATA_DIR: actualData,
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
  writeBackupDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const runners = createBackupRunners({
    pingResponses: [
      defaultEnvelopedPingResponse(),
      { status: 503, body: envelopedPingBody({ ok: false }) },
    ],
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
  const runners = createBackupRunners({
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
  const runners = createBackupRunners({
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
  const runners = createBackupRunners({ units: defaultActiveUnits() });
  const snapshot = captureWriterState(writer, { runners, env: {}, dashboardDir: '/tmp/x' });
  assert.equal(snapshot.originallyActive, true);
  assert.equal(snapshot.originallyEnabled, true);
  assert.equal(snapshot.originallyRunning, true);
});

test('stale coordinated lock from dead pid is removed and backup proceeds', async (t) => {
  const root = mkRoot(t, 'df-coordinated-stale-lock-');
  const dashboard = path.join(root, 'dashboard');
  writeBackupDashboard(dashboard, {
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
  const runners = createBackupRunners({ units: defaultActiveUnits() });
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
  writeBackupDashboard(dashboard, {
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
  const runners = createBackupRunners({ units: defaultActiveUnits() });
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
  writeBackupDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  let triggerInterrupt = false;
  const runners = createBackupRunners({ units: defaultActiveUnits(), hungDrain: true });
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
  const runners = createBackupRunners({ units: defaultActiveUnits(), containers: { actual: 'running' } });
  const env = {
    ...process.env,
    BACKUP_INCLUDE_ACTUAL_DATA: '1',
    ACTUAL_SERVER_DATA_DIR: actualDataDir,
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

test('normalizeReleaseIdentity rejects empty and partial ping release objects', () => {
  assert.equal(normalizeReleaseIdentity(null), null);
  assert.equal(normalizeReleaseIdentity({}), null);
  assert.equal(normalizeReleaseIdentity({ dirty: false }), null);
  assert.equal(normalizeReleaseIdentity({
    commit: 'abcdef0',
    dirty: false,
    lockSha256: 'b'.repeat(64),
    contract: 'e92dd64e2bba333f',
  }), null);
  assert.equal(normalizeReleaseIdentity({
    ...SCHEMA_V1_RELEASE_IDENTITY,
    dirty: undefined,
  }), null);
  assert.equal(normalizeReleaseIdentity({
    ...SCHEMA_V1_RELEASE_IDENTITY,
    dirty: 'false',
  }), null);
  assert.equal(normalizeReleaseIdentity({
    ...SCHEMA_V1_RELEASE_IDENTITY,
    lockSha256: 'not-a-valid-sha256',
  }), null);
});

test('normalizeReleaseIdentity accepts schema-v1 production tuple shapes', () => {
  assert.deepEqual(normalizeReleaseIdentity({
    commit: 'abcdef0',
    dirty: false,
    lockSha256: 'b'.repeat(64),
    contract: 'e92dd64e2bba333f',
    appVersion: '2.0.0',
    builtAt: '2026-01-01T00:00:00.000Z',
  }), {
    commit: 'abcdef0',
    dirty: false,
    lockSha256: 'b'.repeat(64),
    contract: 'e92dd64e2bba333f',
    appVersion: '2.0.0',
    builtAt: '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual(normalizeReleaseIdentity({
    commit: '1234567',
    dirty: true,
    lockSha256: 'c'.repeat(64),
    contract: 'contract-v1',
    appVersion: '1.0.0',
    builtAt: '2026-01-01T00:00:00.000Z',
  }), {
    commit: '1234567',
    dirty: true,
    lockSha256: 'c'.repeat(64),
    contract: 'contract-v1',
    appVersion: '1.0.0',
    builtAt: '2026-01-01T00:00:00.000Z',
  });
});

test('captureDashboardReleaseIdentity fails fast without FINANCE_API_TOKEN when dashboard is running', async () => {
  const runners = createBackupRunners({ units: defaultActiveUnits() });
  const snapshotsById = new Map([['finance-dashboard', {
    id: 'finance-dashboard',
    originallyActive: true,
    state: 'active',
  }]]);
  const env = { ...process.env };
  delete env.FINANCE_API_TOKEN;
  const started = Date.now();
  await assert.rejects(
    () => captureDashboardReleaseIdentity({
      env,
      runners,
      dashboardDir: '/tmp/dashboard',
      snapshotsById,
      timeoutMs: 5000,
      pollMs: 1,
    }),
    /FINANCE_API_TOKEN must be a non-empty string for live dashboard release identity capture/,
  );
  assert.ok(Date.now() - started < 500, 'missing FINANCE_API_TOKEN should fail fast without ping polling');
  assert.equal(runners.commands.filter((entry) => entry[0] === 'httpGet').length, 0);
});

test('captureDashboardReleaseIdentity fails fast when FINANCE_API_TOKEN is empty', async () => {
  const runners = createBackupRunners({ units: defaultActiveUnits() });
  const snapshotsById = new Map([['finance-dashboard', {
    id: 'finance-dashboard',
    originallyActive: true,
    state: 'active',
  }]]);
  await assert.rejects(
    () => captureDashboardReleaseIdentity({
      env: { ...process.env, FINANCE_API_TOKEN: '' },
      runners,
      dashboardDir: '/tmp/dashboard',
      snapshotsById,
      timeoutMs: 5000,
      pollMs: 1,
    }),
    /FINANCE_API_TOKEN must be a non-empty string for live dashboard release identity capture/,
  );
  assert.equal(runners.commands.filter((entry) => entry[0] === 'httpGet').length, 0);
});

test('captureDashboardReleaseIdentity uses manifest without FINANCE_API_TOKEN when pre-quiesced', async (t) => {
  const root = mkRoot(t, 'df-coordinated-capture-manifest-only-');
  const dashboard = path.join(root, 'dashboard');
  writeBackupDashboard(dashboard);
  const env = { ...process.env, FINANCE_DASHBOARD_DIR: dashboard };
  delete env.FINANCE_API_TOKEN;
  const runners = createBackupRunners({
    units: {
      'actual-sync.timer': { active: 'inactive', enabled: 'enabled' },
      'actual-sync.service': { active: 'inactive', enabled: 'enabled' },
      'finance-dashboard.service': { active: 'inactive', enabled: 'enabled' },
    },
  });
  const digest = await captureDashboardReleaseIdentity({
    env,
    runners,
    dashboardDir: dashboard,
    preQuiesced: true,
    snapshotsById: new Map(),
  });
  assert.equal(digest, SCHEMA_V1_RELEASE_IDENTITY_DIGEST);
  assert.equal(runners.commands.filter((entry) => entry[0] === 'httpGet').length, 0);
});

test('coordinated backup fails fast without FINANCE_API_TOKEN when dashboard is running', async (t) => {
  const root = mkRoot(t, 'df-coordinated-backup-missing-token-');
  const dashboard = path.join(root, 'dashboard');
  writeBackupDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const runners = createBackupRunners({ units: defaultActiveUnits() });
  const env = envFor(root, dashboard);
  delete env.FINANCE_API_TOKEN;
  const started = Date.now();
  await assert.rejects(
    () => runCoordinatedBackup({
      ...backupOptions(env, runners, { stopDeadlineMs: 500 }),
      dashboardDir: dashboard,
      destination: env.DARKFINANCES_BACKUP_DIR,
    }),
    /FINANCE_API_TOKEN must be a non-empty string for live dashboard release identity capture/,
  );
  assert.ok(Date.now() - started < 500, 'coordinated backup should fail fast without FINANCE_API_TOKEN');
  assert.equal(runners.commands.filter((entry) => entry[0] === 'httpGet').length, 0);
});

test('captureDashboardReleaseIdentity fails closed on empty ping release object', async () => {
  const runners = createBackupRunners({
    pingResponse: {
      status: 200,
      body: envelopedPingBody({ ok: true, release: {} }),
    },
  });
  await assert.rejects(
    () => captureDashboardReleaseIdentity({
      env: { ...process.env, FINANCE_API_TOKEN: 'test-token' },
      runners,
      dashboardDir: '/tmp/dashboard',
      snapshotsById: new Map([['finance-dashboard', {
        id: 'finance-dashboard',
        originallyActive: true,
        state: 'active',
      }]]),
      timeoutMs: 50,
      pollMs: 1,
    }),
    /dashboard release identity unavailable before quiescence/,
  );
});

test('post-restart health rejects empty ping release after valid capture digest', async () => {
  const runners = createBackupRunners({
    pingResponse: {
      status: 200,
      body: envelopedPingBody({ ok: true, release: {} }),
    },
  });
  const health = await runPostRestartHealthChecks({
    writers: [],
    snapshotsById: new Map(),
    env: { ...process.env, FINANCE_API_TOKEN: 'test-token' },
    runners,
    expectedReleaseGeneration: SCHEMA_V1_RELEASE_IDENTITY_DIGEST,
    timeoutMs: 50,
    pollMs: 1,
  });
  assert.equal(health.ok, false);
  assert.ok(health.results.some((entry) => /release identity missing/.test(entry.error || '')));
});

test('post-restart health fails when release identity is missing from ping', async () => {
  const runners = createBackupRunners({
    pingResponse: {
      status: 200,
      body: envelopedPingBody({ ok: true, release: null }),
    },
  });
  const health = await runPostRestartHealthChecks({
    writers: [],
    snapshotsById: new Map(),
    env: { ...process.env, FINANCE_API_TOKEN: 'test-token' },
    runners,
    expectedReleaseGeneration: SCHEMA_V1_RELEASE_IDENTITY_DIGEST,
    timeoutMs: 50,
    pollMs: 1,
  });
  assert.equal(health.ok, false);
  assert.ok(health.results.some((entry) => /release identity missing/.test(entry.error || '')));
});

test('post-restart health accepts schema-v1 release tuple from enveloped ping', async () => {
  const runners = createBackupRunners();
  const health = await runPostRestartHealthChecks({
    writers: [],
    snapshotsById: new Map(),
    env: { ...process.env, FINANCE_API_TOKEN: 'test-token' },
    runners,
    expectedReleaseGeneration: SCHEMA_V1_RELEASE_IDENTITY_DIGEST,
    timeoutMs: 50,
    pollMs: 1,
  });
  assert.equal(health.ok, true);
});

test('post-restart health fails on dashboard release identity mismatch', async () => {
  const mismatched = {
    ...SCHEMA_V1_RELEASE_IDENTITY,
    appVersion: '9.9.9',
  };
  const runners = createBackupRunners({
    pingResponse: defaultEnvelopedPingResponse(mismatched),
  });
  const health = await runPostRestartHealthChecks({
    writers: [],
    snapshotsById: new Map(),
    env: { ...process.env, FINANCE_API_TOKEN: 'test-token' },
    runners,
    expectedReleaseGeneration: SCHEMA_V1_RELEASE_IDENTITY_DIGEST,
    timeoutMs: 50,
    pollMs: 1,
  });
  assert.equal(health.ok, false);
  assert.ok(health.results.some((entry) => /release identity mismatch/.test(entry.error || '')));
});

test('post-restart health does not treat backup release manifest digest as dashboard identity', async () => {
  const runners = createBackupRunners();
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
  assert.notEqual(RELEASE_MANIFEST_DIGEST, SCHEMA_V1_RELEASE_IDENTITY_DIGEST);
  assert.ok(health.results.some((entry) => /release identity mismatch/.test(entry.error || '')));
});

test('capture fails closed when enveloped ping reports null release identity', async (t) => {
  const root = mkRoot(t, 'df-coordinated-capture-null-');
  const dashboard = path.join(root, 'dashboard');
  writeBackupDashboard(dashboard);
  const runners = createBackupRunners({
    pingResponse: {
      status: 200,
      body: envelopedPingBody({ ok: true, release: null }),
    },
  });
  const env = envFor(root, dashboard);
  await assert.rejects(
    () => runCoordinatedBackup({
      ...backupOptions(env, runners, { stopDeadlineMs: 500 }),
      dashboardDir: dashboard,
      destination: env.DARKFINANCES_BACKUP_DIR,
    }),
    /dashboard release identity unavailable before quiescence/,
  );
});

test('timer trigger race during stop fails closed', async (t) => {
  const root = mkRoot(t, 'df-coordinated-trigger-race-');
  const dashboard = path.join(root, 'dashboard');
  writeBackupDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const runners = createBackupRunners({ units: defaultActiveUnits(), timerFiresDuringStop: true });
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
  writeBackupDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const runners = createBackupRunners({
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
  writeBackupDashboard(dashboard, {
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
      ...backupOptions(env, createBackupRunners({ units: defaultActiveUnits() })),
      dashboardDir: dashboard,
      destination: env.DARKFINANCES_BACKUP_DIR,
    }),
    /BACKUP_QUIESCE=0 is forbidden/,
  );
});

test('BACKUP_PRE_QUIESCED=1 rejects active writers and mints no restore token', async (t) => {
  const root = mkRoot(t, 'df-coordinated-pre-quiesced-active-');
  const dashboard = path.join(root, 'dashboard');
  writeBackupDashboard(dashboard, {
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
      ...backupOptions(env, createBackupRunners({ units: defaultActiveUnits() }), { stopDeadlineMs: 200 }),
      preQuiesced: true,
      dashboardDir: dashboard,
      destination: env.DARKFINANCES_BACKUP_DIR,
    }),
    /quiescence verification failed|did not quiesce/,
  );
});

test('quiescence_verified resume reuses journal dashboardReleaseIdentityDigest without recapture', async (t) => {
  const root = mkRoot(t, 'df-coordinated-resume-quiescence-');
  const dashboard = path.join(root, 'dashboard');
  writeBackupDashboard(dashboard, {
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
  const setupRunners = createBackupRunners({
    units: {
      'actual-sync.timer': { active: 'inactive', enabled: 'enabled' },
      'actual-sync.service': { active: 'inactive', enabled: 'enabled' },
      'finance-dashboard.service': { active: 'inactive', enabled: 'enabled' },
    },
  });
  const { snapshots } = discoverWriters({
    inventory,
    env,
    runners: setupRunners,
    dashboardDir: dashboard,
  });
  const journal = createRunJournal({
    runId: 'resume-quiescence',
    operation: 'backup',
    layout,
    writerInventory: inventory,
    preRunWriters: snapshots,
    options: { includeActualData: false, preQuiesced: false, dashboardDir: dashboard },
  });
  journal.phase = PHASE.QUIESCENCE_VERIFIED;
  journal.generationBindings = {
    dashboardReleaseIdentityDigest: SCHEMA_V1_RELEASE_IDENTITY_DIGEST,
  };
  writeRunJournal(layout.journalPath, journal);
  const mismatchedIdentity = {
    ...SCHEMA_V1_RELEASE_IDENTITY,
    appVersion: '9.9.9',
  };
  await assert.rejects(
    () => runCoordinatedBackup({
      ...backupOptions(env, createBackupRunners({
        units: {
          'actual-sync.timer': { active: 'inactive', enabled: 'enabled' },
          'actual-sync.service': { active: 'inactive', enabled: 'enabled' },
          'finance-dashboard.service': { active: 'inactive', enabled: 'enabled' },
        },
        pingResponse: defaultEnvelopedPingResponse(mismatchedIdentity),
      })),
      dashboardDir: dashboard,
      destination: env.DARKFINANCES_BACKUP_DIR,
    }),
    /post-restart health verification failed/,
  );
  const resumed = readRunJournal(layout.journalPath);
  assert.equal(resumed.generationBindings.dashboardReleaseIdentityDigest, SCHEMA_V1_RELEASE_IDENTITY_DIGEST);
  assert.equal(resumed.generationBindings.identityBindingSource, undefined);
});

test('quiescence_verified resume with active writer fails before snapshot', async (t) => {
  const root = mkRoot(t, 'df-coordinated-resume-active-');
  const dashboard = path.join(root, 'dashboard');
  writeBackupDashboard(dashboard, {
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
  const runners = createBackupRunners({ units: defaultActiveUnits() });
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
  const activeRunners = createBackupRunners({
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
  writeBackupDashboard(dashboard, {
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
  const goodRunners = createBackupRunners({ units: defaultActiveUnits() });
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
  const badRunners = createBackupRunners({
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
  writeBackupDashboard(dashboard, {
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
  const setupRunners = createBackupRunners({ units: defaultActiveUnits() });
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
      dashboardReleaseIdentityDigest: SCHEMA_V1_RELEASE_IDENTITY_DIGEST,
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
  const runners = createBackupRunners({
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

test('backup_complete resume migrates legacy coordinated manifest via manifest recapture', async (t) => {
  const root = mkRoot(t, 'df-coordinated-resume-legacy-migrate-');
  const dashboard = path.join(root, 'dashboard');
  writeBackupDashboard(dashboard);
  const env = envFor(root, dashboard);
  const layout = coordinatedLayoutForRoot(env.DARKFINANCES_BACKUP_DIR);
  fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  const inventory = loadWriterInventory();
  const setupRunners = createBackupRunners({
    units: {
      'actual-sync.timer': { active: 'inactive', enabled: 'enabled' },
      'actual-sync.service': { active: 'inactive', enabled: 'enabled' },
      'finance-dashboard.service': { active: 'inactive', enabled: 'enabled' },
    },
  });
  const { snapshots } = discoverWriters({
    inventory,
    env,
    runners: setupRunners,
    dashboardDir: dashboard,
  });
  const bundleArchive = path.join(env.DARKFINANCES_BACKUP_DIR, 'existing-legacy-bundle.tgz');
  fs.mkdirSync(env.DARKFINANCES_BACKUP_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(bundleArchive, 'bundle\n', { mode: 0o600 });
  const coordinatedManifest = path.join(env.DARKFINANCES_BACKUP_DIR, 'coordinated-backup-legacy.json');
  fs.writeFileSync(coordinatedManifest, `${JSON.stringify({
    generation: {
      releaseManifestDigest: RELEASE_MANIFEST_DIGEST,
      actualDataGeneration: null,
    },
  }, null, 2)}\n`, { mode: 0o600 });
  const journal = createRunJournal({
    runId: 'resume-legacy',
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
  const result = await runCoordinatedBackup({
    ...backupOptions(env, createBackupRunners({
      units: {
        'actual-sync.timer': { active: 'inactive', enabled: 'enabled' },
        'actual-sync.service': { active: 'inactive', enabled: 'enabled' },
        'finance-dashboard.service': { active: 'inactive', enabled: 'enabled' },
      },
    })),
    dashboardDir: dashboard,
    destination: env.DARKFINANCES_BACKUP_DIR,
  });
  assert.equal(result.journal.phase, PHASE.COMPLETE);
  assert.equal(result.journal.generationBindings.dashboardReleaseIdentityDigest, SCHEMA_V1_RELEASE_IDENTITY_DIGEST);
  assert.equal(result.journal.generationBindings.identityBindingSource, 'legacy_manifest_recapture');
});

test('backup_complete resume fails closed when legacy identity cannot be recovered', async (t) => {
  const root = mkRoot(t, 'df-coordinated-resume-legacy-fail-');
  const dashboard = path.join(root, 'dashboard');
  writeBackupDashboard(dashboard, { includeReleaseManifest: false });
  const env = envFor(root, dashboard);
  const layout = coordinatedLayoutForRoot(env.DARKFINANCES_BACKUP_DIR);
  fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  const inventory = loadWriterInventory();
  const { snapshots } = discoverWriters({
    inventory,
    env,
    runners: createBackupRunners({
      units: {
        'actual-sync.timer': { active: 'inactive', enabled: 'enabled' },
        'actual-sync.service': { active: 'inactive', enabled: 'enabled' },
        'finance-dashboard.service': { active: 'inactive', enabled: 'enabled' },
      },
    }),
    dashboardDir: dashboard,
  });
  const bundleArchive = path.join(env.DARKFINANCES_BACKUP_DIR, 'existing-legacy-fail.tgz');
  fs.mkdirSync(env.DARKFINANCES_BACKUP_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(bundleArchive, 'bundle\n', { mode: 0o600 });
  const coordinatedManifest = path.join(env.DARKFINANCES_BACKUP_DIR, 'coordinated-backup-legacy-fail.json');
  fs.writeFileSync(coordinatedManifest, `${JSON.stringify({
    generation: {
      releaseManifestDigest: RELEASE_MANIFEST_DIGEST,
      actualDataGeneration: null,
    },
  }, null, 2)}\n`, { mode: 0o600 });
  const journal = createRunJournal({
    runId: 'resume-legacy-fail',
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
  await assert.rejects(
    () => runCoordinatedBackup({
      ...backupOptions(env, createBackupRunners({
        units: {
          'actual-sync.timer': { active: 'inactive', enabled: 'enabled' },
          'actual-sync.service': { active: 'inactive', enabled: 'enabled' },
          'finance-dashboard.service': { active: 'inactive', enabled: 'enabled' },
        },
      })),
      dashboardDir: dashboard,
      destination: env.DARKFINANCES_BACKUP_DIR,
    }),
    new RegExp(LEGACY_IDENTITY_RECOVERY_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
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
  const runners = createBackupRunners({
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
  writeBackupDashboard(dashboard, {
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
  const runners = createBackupRunners({ units: defaultActiveUnits() });
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

test('BACKUP_PRE_QUIESCED=1 happy path verifies quiescence without stop commands', async (t) => {
  const root = mkRoot(t, 'df-coordinated-pre-quiesced-happy-');
  const dashboard = path.join(root, 'dashboard');
  writeBackupDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const env = envFor(root, dashboard, { BACKUP_PRE_QUIESCED: '1' });
  const runners = createBackupRunners({
    units: {
      'actual-sync.timer': { active: 'inactive', enabled: 'enabled' },
      'actual-sync.service': { active: 'inactive', enabled: 'enabled' },
      'finance-dashboard.service': { active: 'inactive', enabled: 'enabled' },
    },
  });
  const result = await runCoordinatedBackup({
    ...backupOptions(env, runners),
    preQuiesced: true,
    dashboardDir: dashboard,
    destination: env.DARKFINANCES_BACKUP_DIR,
  });
  assert.ok(result.bundleArchive);
  assert.equal(result.coordinatedManifest && fs.existsSync(result.coordinatedManifest), true);
  assert.ok(!runners.commands.some((cmd) => cmd[0] === 'systemctl' && cmd.includes('stop')));
  const manifest = JSON.parse(fs.readFileSync(result.coordinatedManifest, 'utf8'));
  assert.equal(manifest.provenanceOnly, true);
  assert.equal(manifest.generation.dashboardReleaseIdentityDigest, SCHEMA_V1_RELEASE_IDENTITY_DIGEST);
  assert.notEqual(manifest.generation.releaseManifestDigest, manifest.generation.dashboardReleaseIdentityDigest);
});

test('writer reappearance fails at named snapshot hooks', async (t) => {
  const root = mkRoot(t, 'df-coordinated-hook-reappear-');
  const dashboard = path.join(root, 'dashboard');
  writeBackupDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const env = envFor(root, dashboard);
  const inventory = loadWriterInventory();
  for (const label of [
    'pre-dashboard-bundle',
    'pre-publish-dashboard-bundle',
    'pre-actual-hash',
    'pre-publish-actual-archive',
    'pre-release-manifest',
  ]) {
    const runners = createBackupRunners({
      units: {
        'actual-sync.timer': { active: 'inactive', enabled: 'enabled' },
        'actual-sync.service': { active: 'inactive', enabled: 'enabled' },
        'finance-dashboard.service': { active: 'inactive', enabled: 'enabled' },
      },
      reappearingWriters: ['finance-dashboard.service'],
    });
    const { snapshots } = discoverWriters({ inventory, env, runners, dashboardDir: dashboard });
    const snapshotsById = new Map(snapshots.map((entry) => [entry.id, entry]));
    const context = {
      inventory,
      env,
      runners,
      dashboardDir: dashboard,
      stopDeadlineMs: 500,
      pollMs: 50,
    };
    await assert.rejects(
      () => require('../lib/writer-quiescence').verifySnapshotBoundary(context, snapshotsById, label),
      new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  }
});

test('coordinated manifest digest binds restore admission coordinatedManifestDigest field', (t) => {
  const root = mkRoot(t, 'df-coordinated-manifest-bind-');
  const dashboard = path.join(root, 'dashboard');
  writeBackupDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const layout = coordinatedLayoutForRoot(path.join(root, 'backups'));
  const inventory = loadWriterInventory();
  const journal = createRunJournal({
    runId: 'manifest-bind',
    operation: 'backup',
    layout,
    writerInventory: inventory,
    preRunWriters: [],
    options: { includeActualData: false, preQuiesced: false, dashboardDir: dashboard },
  });
  journal.artifacts = {
    bundleArchive: 'bundle.tgz',
    bundleManifest: 'bundle.tgz.manifest.json',
    releaseManifest: 'release.json',
  };
  const bundleManifest = { artifact: { id: 'a'.repeat(64) }, runtimeState: { inventoryDigest: 'b'.repeat(64) } };
  const releasePath = path.join(root, 'release.json');
  const signing = createEphemeralSigningMaterial(root);
  const bundleManifestPath = path.join(root, 'bundle.tgz.manifest.json');
  fs.writeFileSync(bundleManifestPath, `${JSON.stringify(bundleManifest, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'bundle.tgz'), 'bundle\n');
  writeSignedReleaseEvidence(releasePath, bundleManifestPath, path.join(root, 'bundle.tgz'), signing);
  const releaseSignaturePath = `${releasePath}.sig.json`;
  const coordinatedManifest = buildCoordinatedManifest({
    journal,
    bundleManifest,
    bundleManifestPath,
    releaseManifestPath: releasePath,
    releaseSignaturePath,
    dashboardReleaseIdentityDigest: SCHEMA_V1_RELEASE_IDENTITY_DIGEST,
  });
  const coordinatedManifestPath = path.join(root, 'coordinated.json');
  fs.writeFileSync(coordinatedManifestPath, `${JSON.stringify(coordinatedManifest, null, 2)}\n`, { mode: 0o600 });
  const digest = require('../lib/backup-verify').sha256File(coordinatedManifestPath);
  const keys = installTestCoordinatorKeys(root);
  const { token } = buildTestAdmissionToken({
    keyPair: keys.pair,
    bindings: {
      coordinatedManifestDigest: digest,
      releaseManifestDigest: coordinatedManifest.generation.releaseManifestDigest,
    },
  });
  assert.equal(token.bindings.coordinatedManifestDigest, digest);
  assert.equal(token.bindings.releaseManifestDigest, coordinatedManifest.generation.releaseManifestDigest);
});

test('tooling closure includes coordinated restore and build-backup dependencies', () => {
  const sources = bundleToolingSourcePaths();
  assert.ok(sources.includes('ops/lib/build-backup-bundle.js'));
  assert.ok(sources.includes('ops/lib/coordinated-admission-crypto.js'));
  assert.ok(sources.includes('ops/lib/coordinated-restore.js'));
  assert.ok(sources.includes('scripts/release-manifest.js'));
});

test('shell wrapper dry-run exits 2 without mutating destination', (t) => {
  const root = mkRoot(t, 'df-coordinated-shell-dry-');
  const dashboard = path.join(root, 'dashboard');
  writeBackupDashboard(dashboard, {
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

test('restartWriter skips inactive static oneshot services but restores enabled timers', async (t) => {
  const root = mkRoot(t, 'df-coordinated-static-oneshot-');
  const dashboard = path.join(root, 'dashboard');
  fs.mkdirSync(dashboard, { recursive: true });
  const inventory = loadWriterInventory();
  const runners = createBackupRunners({
    units: {
      'actual-sync.timer': { active: 'active', enabled: 'enabled' },
      'actual-sync.service': { active: 'inactive', enabled: 'static' },
      'finance-event-sync.timer': { active: 'inactive', enabled: 'disabled' },
      'finance-event-sync.service': { active: 'inactive', enabled: 'static' },
      'finance-dashboard.service': { active: 'active', enabled: 'enabled' },
    },
  });
  const context = {
    inventory,
    env: envFor(root, dashboard, { FINANCE_EVENT_SYNC_CONFIGURED: '1' }),
    runners,
    dashboardDir: dashboard,
  };
  const { writers, snapshots } = discoverWriters(context);
  context.writers = writers;
  const map = snapshotsMap(snapshots);
  const serviceSnapshot = map.get('actual-sync.service');
  const timerSnapshot = map.get('actual-sync.timer');
  assert.equal(serviceSnapshot.originallyActive, false);
  assert.equal(serviceSnapshot.enabled, true);
  assert.equal(serviceSnapshot.originallyEnabled, false);
  assert.equal(timerSnapshot.originallyEnabled, true);
  await restartWritersByPhase(context, map, 'jobs-timers');
  assert.equal(
    runners.commands.some((entry) => entry.includes('actual-sync.service') && entry.includes('start')),
    false,
  );
  assert.equal(
    runners.commands.some((entry) => entry.includes('finance-event-sync.service') && entry.includes('start')),
    false,
  );
  assert.equal(
    runners.commands.some((entry) => entry.includes('actual-sync.timer') && entry.includes('start')),
    true,
  );
  await restartWritersByPhase(context, map, 'dashboard');
  assert.equal(
    runners.commands.some((entry) => entry.includes('finance-dashboard.service') && entry.includes('start')),
    true,
  );
});

test('restart failure records recovery_required before health and never marks complete', async (t) => {
  const root = mkRoot(t, 'df-coordinated-restart-journal-');
  const dashboard = path.join(root, 'dashboard');
  writeBackupDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const runners = createBackupRunners({
    units: defaultActiveUnits(),
    restartFailures: new Set(['finance-dashboard.service']),
  });
  const env = envFor(root, dashboard);
  await assert.rejects(
    () => runCoordinatedBackup({
      ...backupOptions(env, runners, { stopDeadlineMs: 500 }),
      dashboardDir: dashboard,
      destination: env.DARKFINANCES_BACKUP_DIR,
    }),
    /restart failures: finance-dashboard/,
  );
  const journal = readRunJournal(path.join(env.DARKFINANCES_BACKUP_DIR, '.darkfinances-coordinated/run-journal.json'));
  assert.equal(journal.phase, PHASE.RECOVERY_REQUIRED);
  assert.notEqual(journal.phase, PHASE.COMPLETE);
  assert.ok(journal.healthResults.length > 0);
  assert.ok(journal.errors.some((entry) => /restart failures/.test(entry.message)));
});

test('resolveActualServerDataDir prefers ACTUAL_SERVER_DATA_DIR over ACTUAL_DATA_DIR', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-server-data-dir-'));
  try {
    const serverData = path.join(root, 'actual', 'data');
    const dashboardCache = path.join(root, 'cache');
    assert.equal(
      resolveActualServerDataDir({
        HOME: root,
        ACTUAL_SERVER_DATA_DIR: serverData,
        ACTUAL_DATA_DIR: dashboardCache,
      }),
      path.resolve(serverData),
    );
    assert.equal(
      resolveActualServerDataDir({ HOME: root, ACTUAL_DATA_DIR: dashboardCache }),
      path.resolve(root, 'actual', 'data'),
    );
    assert.equal(
      resolveActualServerDataDir({ HOME: root }, { actualDataDir: dashboardCache }),
      path.resolve(dashboardCache),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ACTUAL_SERVER_DATA_DIR wins over ACTUAL_DATA_DIR for actual archive and generation', async (t) => {
  const root = mkRoot(t, 'df-coordinated-server-data-archive-');
  const dashboard = path.join(root, 'dashboard');
  const serverData = path.join(root, 'actual', 'data');
  const dashboardCache = path.join(root, 'cache', 'actual-dashboard');
  fs.mkdirSync(serverData, { recursive: true });
  fs.mkdirSync(dashboardCache, { recursive: true });
  fs.writeFileSync(path.join(serverData, 'db'), 'server-data\n');
  fs.writeFileSync(path.join(dashboardCache, 'db'), 'dashboard-cache\n');
  writeBackupDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const runners = createBackupRunners({
    units: defaultActiveUnits(),
    containers: { actual: 'running' },
  });
  const env = envFor(root, dashboard, {
    BACKUP_INCLUDE_ACTUAL_DATA: '1',
    ACTUAL_SERVER_DATA_DIR: serverData,
    ACTUAL_DATA_DIR: dashboardCache,
    ACTUAL_COMPOSE_FILE: path.join(root, 'compose.yml'),
  });
  fs.writeFileSync(env.ACTUAL_COMPOSE_FILE, 'services:\n  actual:\n    image: test\n');
  const { computeActualDataGeneration } = require('../lib/writer-quiescence');
  const result = await runCoordinatedBackup({
    ...backupOptions(env, runners),
    includeActual: true,
    dashboardDir: dashboard,
    destination: env.DARKFINANCES_BACKUP_DIR,
  });
  const tarCmd = runners.commands.find((entry) => entry[0] === 'tar');
  assert.ok(tarCmd);
  assert.ok(tarCmd.includes(path.basename(serverData)));
  assert.equal(tarCmd.includes(path.basename(dashboardCache)), false);
  assert.equal(result.actualDataGeneration, computeActualDataGeneration(serverData));
  assert.notEqual(result.actualDataGeneration, computeActualDataGeneration(dashboardCache));
});

test('options.actualDataDir threads into post-restart actual container health checks', async () => {
  const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-options-actual-data-'));
  const defaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-default-actual-data-'));
  fs.writeFileSync(path.join(customDir, 'db'), 'options-tree\n');
  fs.writeFileSync(path.join(defaultDir, 'db'), 'default-tree\n');
  const { computeActualDataGeneration } = require('../lib/writer-quiescence');
  const expected = computeActualDataGeneration(customDir);
  const runners = createBackupRunners({ containers: { actual: 'running' } });
  const env = {
    ...process.env,
    BACKUP_INCLUDE_ACTUAL_DATA: '1',
    ACTUAL_SERVER_DATA_DIR: defaultDir,
    ACTUAL_DATA_DIR: path.join(os.tmpdir(), 'dashboard-cache-unrelated'),
  };
  const healthWrong = await checkActualContainerHealth({
    env,
    runners,
    expectedGeneration: expected,
  });
  assert.equal(healthWrong.ok, false);
  const healthExact = await checkActualContainerHealth({
    env,
    runners,
    expectedGeneration: expected,
    actualServerDataDir: customDir,
  });
  assert.equal(healthExact.ok, true);
});

test('options.actualDataDir drives coordinated backup health end-to-end', async (t) => {
  const root = mkRoot(t, 'df-coordinated-options-actual-data-');
  const dashboard = path.join(root, 'dashboard');
  const customServerData = path.join(root, 'custom-server-data');
  const defaultServerData = path.join(root, 'actual', 'data');
  const dashboardCache = path.join(root, 'cache', 'actual-dashboard');
  fs.mkdirSync(customServerData, { recursive: true });
  fs.mkdirSync(defaultServerData, { recursive: true });
  fs.mkdirSync(dashboardCache, { recursive: true });
  fs.writeFileSync(path.join(customServerData, 'db'), 'custom-options\n');
  fs.writeFileSync(path.join(defaultServerData, 'db'), 'default-home\n');
  fs.writeFileSync(path.join(dashboardCache, 'db'), 'dashboard-cache\n');
  writeBackupDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const runners = createBackupRunners({
    units: defaultActiveUnits(),
    containers: { actual: 'running' },
  });
  const env = envFor(root, dashboard, {
    BACKUP_INCLUDE_ACTUAL_DATA: '1',
    ACTUAL_SERVER_DATA_DIR: defaultServerData,
    ACTUAL_DATA_DIR: dashboardCache,
    ACTUAL_COMPOSE_FILE: path.join(root, 'compose.yml'),
  });
  fs.writeFileSync(env.ACTUAL_COMPOSE_FILE, 'services:\n  actual:\n    image: test\n');
  const result = await runCoordinatedBackup({
    ...backupOptions(env, runners),
    includeActual: true,
    actualDataDir: customServerData,
    dashboardDir: dashboard,
    destination: env.DARKFINANCES_BACKUP_DIR,
  });
  assert.equal(result.ok, true);
  const { computeActualDataGeneration } = require('../lib/writer-quiescence');
  assert.equal(result.actualDataGeneration, computeActualDataGeneration(customServerData));
  fs.writeFileSync(path.join(defaultServerData, 'db'), 'mutated-default\n');
  const journal = readRunJournal(path.join(env.DARKFINANCES_BACKUP_DIR, '.darkfinances-coordinated/run-journal.json'));
  assert.equal(journal.phase, PHASE.COMPLETE);
});

test('linked timer restart skips inactive linked and restores originally active linked', async (t) => {
  const root = mkRoot(t, 'df-coordinated-linked-timer-');
  const dashboard = path.join(root, 'dashboard');
  fs.mkdirSync(dashboard, { recursive: true });
  const inventory = loadWriterInventory();
  const runners = createBackupRunners({
    units: {
      'actual-sync.timer': { active: 'inactive', enabled: 'linked' },
      'actual-sync.service': { active: 'inactive', enabled: 'static' },
      'backup-coordinated.timer': { active: 'active', enabled: 'linked' },
      'finance-dashboard.service': { active: 'inactive', enabled: 'disabled' },
    },
  });
  const context = {
    inventory,
    env: envFor(root, dashboard),
    runners,
    dashboardDir: dashboard,
  };
  const { writers, snapshots } = discoverWriters(context);
  context.writers = writers;
  const map = snapshotsMap(snapshots);
  const inactiveLinked = map.get('actual-sync.timer');
  const activeLinked = map.get('backup-coordinated.timer');
  assert.equal(inactiveLinked.enabled, true);
  assert.equal(inactiveLinked.originallyEnabled, false);
  assert.equal(inactiveLinked.originallyActive, false);
  assert.equal(activeLinked.enabled, true);
  assert.equal(activeLinked.originallyEnabled, false);
  assert.equal(activeLinked.originallyActive, true);
  await restartWritersByPhase(context, map, 'jobs-timers');
  assert.equal(
    runners.commands.some((entry) => entry.includes('actual-sync.timer') && entry.includes('start')),
    false,
  );
  assert.equal(
    runners.commands.some((entry) => entry.includes('backup-coordinated.timer') && entry.includes('start')),
    true,
  );
});

test('post-restart health accepts waiting linked timer that was originally active', async () => {
  const inventory = loadWriterInventory();
  const writer = inventory.writers.find((entry) => entry.id === 'backup-coordinated.timer');
  const runners = createBackupRunners({
    units: { 'backup-coordinated.timer': { active: 'waiting', enabled: 'linked' } },
  });
  const result = await checkSystemdUnitHealth(
    { ...writer, originallyActive: true, originallyEnabled: false },
    { runners, env: {} },
  );
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.state, 'waiting');
});

test('post-restart health rejects inactive timer state for originally active linked timer', async () => {
  const inventory = loadWriterInventory();
  const writer = inventory.writers.find((entry) => entry.id === 'backup-coordinated.timer');
  const runners = createBackupRunners({
    units: { 'backup-coordinated.timer': { active: 'inactive', enabled: 'linked' } },
  });
  const result = await checkSystemdUnitHealth(
    { ...writer, originallyActive: true, originallyEnabled: false },
    { runners, env: {} },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /timer state=inactive/);
});

test('publishFileDurable fsyncs staging, renames, fsyncs final, and fsyncs destination directory in order', (t) => {
  const root = mkRoot(t, 'df-coordinated-durable-order-');
  const destination = path.join(root, 'backups');
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const staging = path.join(root, 'staging.tgz');
  const finalPath = path.join(destination, 'bundle.tgz');
  fs.writeFileSync(staging, 'bundle-bytes\n', { mode: 0o600 });
  const order = [];
  publishFileDurable(finalPath, staging, 0o600, (point) => order.push(point));
  assert.deepEqual(order, [
    'before:publish-fsync-staging',
    'after:publish-fsync-staging',
    'before:publish-rename',
    'after:publish-rename',
    'before:publish-fsync-final',
    'after:publish-fsync-final',
    'before:publish-fsync-dir',
    'after:publish-fsync-dir',
  ]);
  assert.equal(fs.readFileSync(finalPath, 'utf8'), 'bundle-bytes\n');
  assert.equal(fs.existsSync(staging), false);
});

test('writeChecksumSidecarDurable uses atomic checksum publication boundaries', (t) => {
  const root = mkRoot(t, 'df-coordinated-checksum-order-');
  const archive = path.join(root, 'bundle.tgz');
  fs.writeFileSync(archive, 'bundle-bytes\n', { mode: 0o600 });
  const order = [];
  writeChecksumSidecarDurable(archive, (point, target) => order.push(`${point}:${path.basename(String(target))}`));
  assert.ok(order.some((entry) => entry.startsWith('before:checksum-sidecar:')));
  assert.ok(order.some((entry) => entry.startsWith('before:atomic-fsync-temp:')));
  assert.ok(order.some((entry) => entry.startsWith('before:atomic-rename:')));
  assert.ok(order.some((entry) => entry.startsWith('before:atomic-fsync-dir:')));
  assert.equal(fs.existsSync(`${archive}.sha256`), true);
});

test('coordinated backup publication faults at every fsync/rename boundary and errors dominate success', async (t) => {
  const boundaries = [
    'before:publish-fsync-staging',
    'after:publish-fsync-staging',
    'before:publish-rename',
    'after:publish-rename',
    'before:publish-fsync-final',
    'after:publish-fsync-final',
    'before:publish-fsync-dir',
    'after:publish-fsync-dir',
    'before:atomic-fsync-temp',
    'after:atomic-fsync-temp',
    'before:atomic-rename',
    'after:atomic-rename',
    'before:atomic-fsync-dir',
    'after:atomic-fsync-dir',
    'before:checksum-sidecar',
    'after:checksum-sidecar',
    'before:published-fsync-file',
    'after:published-fsync-file',
    'before:published-fsync-dir',
    'after:published-fsync-dir',
  ];

  for (const faultPoint of boundaries) {
    const root = mkRoot(t, `df-coordinated-fault-${faultPoint.replace(/[:/]/g, '-')}-`);
    const dashboard = path.join(root, 'dashboard');
    writeBackupDashboard(dashboard, {
      overrides: {
        bulkOperationSagas: { schemaVersion: 1, sagas: {} },
        transactionSagas: { schemaVersion: 1, sagas: {} },
        transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
        repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
        operationJournal: { schemaVersion: 1, operations: {} },
      },
    });
    const env = envFor(root, dashboard);
    const runners = createBackupRunners({
      units: {
        'actual-sync.timer': { active: 'inactive', enabled: 'enabled' },
        'actual-sync.service': { active: 'inactive', enabled: 'enabled' },
        'finance-dashboard.service': { active: 'inactive', enabled: 'enabled' },
      },
    });
    await assert.rejects(
      () => runCoordinatedBackup({
        ...backupOptions(env, runners),
        preQuiesced: true,
        injectFault: (point) => {
          if (point === faultPoint) throw new Error(`injected fault at ${faultPoint}`);
        },
        dashboardDir: dashboard,
        destination: env.DARKFINANCES_BACKUP_DIR,
      }),
      new RegExp(`injected fault at ${faultPoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
    const journal = readRunJournal(path.join(env.DARKFINANCES_BACKUP_DIR, '.darkfinances-coordinated/run-journal.json'));
    assert.notEqual(journal.phase, PHASE.COMPLETE);
    assert.notEqual(journal.phase, PHASE.BACKUP_COMPLETE);
    assert.ok(journal.errors.some((entry) => entry.message.includes(faultPoint)));
  }
});

test('publishSidecarFromStaging publishes manifest via atomic durable write', (t) => {
  const root = mkRoot(t, 'df-coordinated-sidecar-publish-');
  const staging = path.join(root, 'bundle.tgz.manifest.json');
  const finalPath = path.join(root, 'published', 'bundle.tgz.manifest.json');
  fs.mkdirSync(path.dirname(staging), { recursive: true, mode: 0o700 });
  fs.writeFileSync(staging, '{"ok":true}\n', { mode: 0o600 });
  const order = [];
  publishSidecarFromStaging(finalPath, staging, 0o600, (point) => order.push(point));
  assert.ok(order.includes('before:atomic-rename'));
  assert.equal(fs.readFileSync(finalPath, 'utf8'), '{"ok":true}\n');
});

test('coordinated backup wrapper helpers delegate to durable publication primitives', (t) => {
  const root = mkRoot(t, 'df-coordinated-wrapper-delegate-');
  const staging = path.join(root, 'stage.tgz');
  const finalPath = path.join(root, 'final.tgz');
  fs.writeFileSync(staging, 'payload\n', { mode: 0o600 });
  publishAtomic(finalPath, staging, 0o600);
  writeChecksumSidecar(finalPath);
  assert.equal(fs.existsSync(finalPath), true);
  assert.equal(fs.existsSync(`${finalPath}.sha256`), true);
});

test('assertArchivePublicationCommitted refuses archive/manifest without checksum commit marker', (t) => {
  const root = mkRoot(t, 'df-coordinated-commit-marker-');
  const archive = path.join(root, 'bundle.tgz');
  fs.writeFileSync(archive, 'bundle\n', { mode: 0o600 });
  fs.writeFileSync(`${archive}.manifest.json`, '{"ok":true}\n', { mode: 0o600 });
  assert.equal(isArchivePublicationCommitted(archive), false);
  assert.throws(
    () => assertArchivePublicationCommitted(archive),
    /missing archive checksum commit marker/,
  );
});

test('partial publication cleanup removes incomplete bundle artifacts but preserves prior committed backup', async (t) => {
  const root = mkRoot(t, 'df-coordinated-partial-cleanup-');
  const dashboard = path.join(root, 'dashboard');
  writeBackupDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const env = envFor(root, dashboard);
  const priorArchive = path.join(env.DARKFINANCES_BACKUP_DIR, 'prior-complete.tgz');
  fs.mkdirSync(env.DARKFINANCES_BACKUP_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(priorArchive, 'prior\n', { mode: 0o600 });
  fs.writeFileSync(`${priorArchive}.manifest.json`, '{"prior":true}\n', { mode: 0o600 });
  fs.writeFileSync(`${priorArchive}.sha256`, `${require('../lib/backup-verify').sha256File(priorArchive)}  prior-complete.tgz\n`, { mode: 0o600 });

  const runners = createBackupRunners({
    units: {
      'actual-sync.timer': { active: 'inactive', enabled: 'enabled' },
      'actual-sync.service': { active: 'inactive', enabled: 'enabled' },
      'finance-dashboard.service': { active: 'inactive', enabled: 'enabled' },
    },
  });
  await assert.rejects(
    () => runCoordinatedBackup({
      ...backupOptions(env, runners),
      preQuiesced: true,
      injectFault: (point) => {
        if (point === 'before:checksum-sidecar') throw new Error('fault before checksum commit marker');
      },
      dashboardDir: dashboard,
      destination: env.DARKFINANCES_BACKUP_DIR,
    }),
    /fault before checksum commit marker/,
  );

  const published = fs.readdirSync(env.DARKFINANCES_BACKUP_DIR).filter((name) => name.endsWith('.tgz'));
  assert.deepEqual(published, ['prior-complete.tgz']);
  assert.equal(isArchivePublicationCommitted(priorArchive), true);
  const journal = readRunJournal(path.join(env.DARKFINANCES_BACKUP_DIR, '.darkfinances-coordinated/run-journal.json'));
  assert.equal(journal.phase, PHASE.FAILED);
});

test('partial publication after manifest publish removes bundle when checksum never committed', async (t) => {
  const root = mkRoot(t, 'df-coordinated-fault-after-manifest-');
  const dashboard = path.join(root, 'dashboard');
  writeBackupDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const env = envFor(root, dashboard);
  const priorArchive = path.join(env.DARKFINANCES_BACKUP_DIR, 'prior-complete.tgz');
  fs.mkdirSync(env.DARKFINANCES_BACKUP_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(priorArchive, 'prior\n', { mode: 0o600 });
  fs.writeFileSync(`${priorArchive}.manifest.json`, '{"prior":true}\n', { mode: 0o600 });
  fs.writeFileSync(`${priorArchive}.sha256`, `${require('../lib/backup-verify').sha256File(priorArchive)}  prior-complete.tgz\n`, { mode: 0o600 });
  const runners = createBackupRunners({
    units: {
      'actual-sync.timer': { active: 'inactive', enabled: 'enabled' },
      'actual-sync.service': { active: 'inactive', enabled: 'enabled' },
      'finance-dashboard.service': { active: 'inactive', enabled: 'enabled' },
    },
  });
  await assert.rejects(
    () => runCoordinatedBackup({
      ...backupOptions(env, runners),
      preQuiesced: true,
      injectFault: (point, target) => {
        if (point === 'after:atomic-fsync-dir' && String(target).endsWith('.manifest.json')) {
          throw new Error('fault after manifest publication');
        }
      },
      dashboardDir: dashboard,
      destination: env.DARKFINANCES_BACKUP_DIR,
    }),
    /fault after manifest publication/,
  );
  const published = fs.readdirSync(env.DARKFINANCES_BACKUP_DIR).filter((name) => name.endsWith('.tgz'));
  assert.deepEqual(published, ['prior-complete.tgz']);
  assert.equal(isArchivePublicationCommitted(priorArchive), true);
  const journal = readRunJournal(path.join(env.DARKFINANCES_BACKUP_DIR, '.darkfinances-coordinated/run-journal.json'));
  assert.equal(journal.phase, PHASE.FAILED);
});

test('committed bundle survives later publication fault and remains consumable', async (t) => {
  const root = mkRoot(t, 'df-coordinated-committed-survives-');
  const dashboard = path.join(root, 'dashboard');
  writeBackupDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const env = envFor(root, dashboard);
  const runners = createBackupRunners({
    units: {
      'actual-sync.timer': { active: 'inactive', enabled: 'enabled' },
      'actual-sync.service': { active: 'inactive', enabled: 'enabled' },
      'finance-dashboard.service': { active: 'inactive', enabled: 'enabled' },
    },
  });
  await assert.rejects(
    () => runCoordinatedBackup({
      ...backupOptions(env, runners),
      preQuiesced: true,
      injectFault: (point) => {
        if (point === 'before:published-fsync-file') throw new Error('fault after bundle commit marker');
      },
      dashboardDir: dashboard,
      destination: env.DARKFINANCES_BACKUP_DIR,
    }),
    /fault after bundle commit marker/,
  );
  const archives = fs.readdirSync(env.DARKFINANCES_BACKUP_DIR).filter((name) => name.endsWith('.tgz'));
  assert.equal(archives.length, 1);
  const archive = path.join(env.DARKFINANCES_BACKUP_DIR, archives[0]);
  assert.equal(isArchivePublicationCommitted(archive), true);
  assert.doesNotThrow(() => assertArchivePublicationCommitted(archive));
});

test('cleanupPartialRunPublication removes only incomplete tracked artifacts', (t) => {
  const root = mkRoot(t, 'df-coordinated-tracker-cleanup-');
  const archive = path.join(root, 'bundle.tgz');
  fs.writeFileSync(archive, 'bundle\n', { mode: 0o600 });
  fs.writeFileSync(`${archive}.manifest.json`, '{"ok":true}\n', { mode: 0o600 });
  const tracker = createRunPublicationTracker();
  tracker.bundleArchive = archive;
  tracker.bundleManifest = `${archive}.manifest.json`;
  tracker.releaseManifest = path.join(root, 'release.json');
  fs.writeFileSync(tracker.releaseManifest, '{}\n', { mode: 0o600 });
  cleanupPartialRunPublication(tracker);
  assert.equal(fs.existsSync(archive), false);
  assert.equal(fs.existsSync(`${archive}.manifest.json`), false);
  assert.equal(fs.existsSync(tracker.releaseManifest), false);
});

test('directory fsync failure fails closed on Linux', (t) => {
  if (process.platform !== 'linux') {
    t.skip('linux-only directory fsync failure contract');
    return;
  }
  const root = mkRoot(t, 'df-coordinated-fsync-linux-');
  const target = path.join(root, 'publish');
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const staging = path.join(root, 'stage.txt');
  fs.writeFileSync(staging, 'payload\n', { mode: 0o600 });
  const originalOpen = fs.openSync;
  fs.openSync = (filePath, flags, mode) => {
    const isDirectory = typeof flags === 'number'
      && (flags & (fs.constants.O_DIRECTORY || 0)) !== 0;
    if (isDirectory) {
      const error = new Error('directory fsync failed');
      error.code = 'EIO';
      throw error;
    }
    return originalOpen.call(fs, filePath, flags, mode);
  };
  t.after(() => { fs.openSync = originalOpen; });
  assert.throws(
    () => publishFileDurable(path.join(target, 'final.txt'), staging, 0o600),
    /directory fsync failed/,
  );
});

test('directory fsync unsupported codes are observable on non-linux platforms', (t) => {
  if (process.platform === 'linux') {
    t.skip('non-linux unsupported directory fsync contract');
    return;
  }
  const root = mkRoot(t, 'df-coordinated-fsync-nonlinux-');
  const dir = path.join(root, 'dir');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const originalOpen = fs.openSync;
  const signals = [];
  fs.openSync = (filePath, flags, mode) => {
    const isDirectory = typeof flags === 'number'
      && (flags & (fs.constants.O_DIRECTORY || 0)) !== 0;
    if (isDirectory) {
      const error = new Error('operation not supported');
      error.code = 'EOPNOTSUPP';
      throw error;
    }
    return originalOpen.call(fs, filePath, flags, mode);
  };
  t.after(() => { fs.openSync = originalOpen; });
  assert.doesNotThrow(() => fsyncPath(dir, true, {
    onDirectoryFsyncUnsupported: (target, error) => signals.push({ target, code: error.code }),
  }));
  assert.equal(signals.length, 1);
  assert.equal(signals[0].code, 'EOPNOTSUPP');
  assert.ok(DIRECTORY_FSYNC_UNSUPPORTED_CODES.has('EOPNOTSUPP'));
});

test('coordinated backup rejects release evidence without signature before commit marker', async (t) => {
  const root = mkRoot(t, 'df-coordinated-unsigned-release-');
  const dashboard = path.join(root, 'dashboard');
  writeBackupDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const signing = createEphemeralSigningMaterial(root);
  const runners = createBackupRunners();
  const env = envFor(root, dashboard, signing);
  await assert.rejects(
    () => runCoordinatedBackup({
      ...backupOptions(env, runners, { signing }),
      writeReleaseManifest: ({ releaseManifestPath, bundleManifestFinal, bundleArchiveFinal }) => {
        writeSignedReleaseEvidence(
          releaseManifestPath,
          bundleManifestFinal,
          bundleArchiveFinal,
          signing,
        );
        fs.rmSync(signaturePathFor(releaseManifestPath), { force: true });
      },
      dashboardDir: dashboard,
      destination: env.DARKFINANCES_BACKUP_DIR,
    }),
    /release signature is missing|missing release signature/,
  );
  const backupDir = env.DARKFINANCES_BACKUP_DIR;
  assert.equal(
    fs.readdirSync(backupDir).some((name) => name.startsWith('coordinated-release-')),
    false,
  );
  assert.equal(
    fs.readdirSync(backupDir).some((name) => name.startsWith('coordinated-backup-')),
    false,
  );
  const journal = readRunJournal(path.join(backupDir, '.darkfinances-coordinated/run-journal.json'));
  assert.equal(journal.phase, PHASE.FAILED);
});

test('coordinated backup invokes real release-manifest CLI and verifies signed evidence', async (t) => {
  const root = mkRoot(t, 'df-coordinated-real-release-cli-');
  const dashboard = path.join(root, 'dashboard');
  writeBackupDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  const signing = createEphemeralSigningMaterial(root);
  const env = envFor(root, dashboard, signing);
  const mockRunners = createBackupRunners();
  const realRunners = createDefaultRunners(env);
  mockRunners.nodeScript = (...args) => realRunners.nodeScript(...args);
  const result = await runCoordinatedBackup({
    ...backupOptions(env, mockRunners, { signing, writeReleaseManifest: undefined }),
    dashboardDir: dashboard,
    destination: env.DARKFINANCES_BACKUP_DIR,
  });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(result.releaseManifest), true);
  assert.equal(fs.existsSync(signaturePathFor(result.releaseManifest)), true);
  const releaseBody = JSON.parse(fs.readFileSync(result.releaseManifest, 'utf8'));
  assert.equal(releaseBody.content.mode, 'backup');
  verifySignedManifest(releaseBody, result.releaseManifest, signing.keyringPath);
  const coordinated = JSON.parse(fs.readFileSync(result.coordinatedManifest, 'utf8'));
  assert.equal(coordinated.generation.releaseManifestDigest, sha256File(result.releaseManifest));
  assert.match(releaseBody.contentDigest.value, /^[a-f0-9]{64}$/);
});
