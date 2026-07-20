'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCoordinatedRestore } = require('../lib/coordinated-restore');
const { runStagedRestore } = require('../lib/staged-restore');
const { buildBackupBundle } = require('../lib/build-backup-bundle');
const { sha256File } = require('../lib/backup-verify');
const { coordinatedLayoutForRoot } = require('../lib/coordinated-operation-layout');
const { consumeAdmission, revokeAdmission, registryRootForLayout } = require('../lib/coordinated-admission-registry');
const { assertAdmissionRegistryState, issueSignedAdmissionToken } = require('../lib/restore-quiescence-admission');
const { PHASE, createRunJournal, writeRunJournal } = require('../lib/coordinated-run-journal');
const { buildTestAdmissionToken, registerTestAdmission } = require('./fixtures/admission-token-fixtures');
const { installTestCoordinatorKeys, installFakeSystemctl, writeTrustedAdmissionToken, assertPreviewOnlyCommands } = require('./fixtures/coordinated-test-helpers');
const { createMockRunners, defaultActiveUnits } = require('./fixtures/coordinated-backup-fixtures');
const {
  createBackupRunners,
  defaultEnvelopedPingResponse,
  writeSchemaV1ReleaseManifest,
  envelopedPingBody,
  SCHEMA_V1_RELEASE_IDENTITY_DIGEST,
  RELEASE_MANIFEST_DIGEST,
} = require('./fixtures/coordinated-backup-release-identity-fixtures');
const { writeProductionDashboard } = require('./fixtures/backup-bundle-dashboard-fixtures');
const { loadWriterInventory } = require('../lib/writer-inventory');

const repoRoot = path.resolve(__dirname, '..', '..');

function mkRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function quiescedUnits() {
  return {
    'actual-sync.timer': { active: 'inactive', enabled: 'enabled' },
    'actual-sync.service': { active: 'inactive', enabled: 'enabled' },
    'finance-dashboard.service': { active: 'inactive', enabled: 'enabled' },
  };
}

test('standalone staged restore rejects active writers even with signed token', async (t) => {
  const root = mkRoot(t, 'df-restore-active-writer-');
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
  const archive = path.join(root, 'bundle.tgz');
  buildBackupBundle({ dashboardDir: dashboard, archivePath: archive });
  const keys = installTestCoordinatorKeys(root);
  const layout = coordinatedLayoutForRoot(path.join(root, 'backups'));
  fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  const { readManifestFromArchive } = require('../lib/backup-bundle-verify');
  const manifestArtifactId = readManifestFromArchive(archive).artifact.id;
  const { writerInventoryDigest } = require('../lib/writer-inventory');
  const { token } = buildTestAdmissionToken({
    keyPair: keys.pair,
    bindings: {
      archiveSha256: sha256File(archive),
      destinationRoot: dashboard,
      manifestArtifactId,
      writerInventoryDigest: writerInventoryDigest(loadWriterInventory()),
    },
  });
  registerTestAdmission(layout, token);
  const tokenPath = writeTrustedAdmissionToken(layout, token, 'admission.json');
  const runners = createMockRunners({ units: defaultActiveUnits() });
  assert.throws(
    () => runStagedRestore({
      archivePath: archive,
      destinationRoot: dashboard,
      confirm: true,
      env: {
        ...process.env,
        RESTORE_QUIESCENCE_ADMISSION_PATH: tokenPath,
        COORDINATED_VERIFY_KEY_PATH: keys.publicPath,
      },
      coordinatorRoot: path.join(root, 'backups'),
      layout,
      runners,
    }),
    /live-quiescent/,
  );
});

test('coordinated restore dry-run performs zero destination mutation', async (t) => {
  const root = mkRoot(t, 'df-coordinated-restore-dry-');
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
  const archive = path.join(root, 'bundle.tgz');
  buildBackupBundle({ dashboardDir: dashboard, archivePath: archive });
  installTestCoordinatorKeys(root);
  const coordinatorRoot = path.join(root, 'backups');
  const layout = coordinatedLayoutForRoot(coordinatorRoot);
  const before = fs.existsSync(dashboard) ? fs.readdirSync(dashboard).length : 0;
  const runners = createMockRunners({ units: quiescedUnits() });
  const result = await runCoordinatedRestore({
    dryRun: true,
    archivePath: archive,
    destinationRoot: dashboard,
    coordinatorRoot,
    env: {
      ...process.env,
      HOME: root,
      FINANCE_DASHBOARD_DIR: dashboard,
      DARKFINANCES_BACKUP_DIR: coordinatorRoot,
      COORDINATED_VERIFY_KEY_PATH: path.join(root, '.config', 'darkfinances', 'coordinated-verify.pem'),
      COORDINATED_SIGNING_KEY_PATH: path.join(root, '.config', 'darkfinances', 'coordinated-sign.pem'),
    },
    runners,
  });
  assert.equal(result.dryRun, true);
  assert.equal(fs.readdirSync(dashboard).length, before);
  assertPreviewOnlyCommands(runners.commands);
  assert.equal(fs.existsSync(layout.lockPath), false);
  assert.equal(fs.existsSync(registryRootForLayout(layout)), false);
});

test('coordinated restore dry-run warns on active writers without stopping them', async (t) => {
  const root = mkRoot(t, 'df-coordinated-restore-dry-active-');
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
  const archive = path.join(root, 'bundle.tgz');
  buildBackupBundle({ dashboardDir: dashboard, archivePath: archive });
  const runners = createMockRunners({ units: defaultActiveUnits() });
  const result = await runCoordinatedRestore({
    dryRun: true,
    archivePath: archive,
    destinationRoot: dashboard,
    coordinatorRoot: path.join(root, 'backups'),
    env: { ...process.env, HOME: root, FINANCE_DASHBOARD_DIR: dashboard },
    runners,
  });
  assert.equal(result.plan.quiescent, false);
  assert.ok(result.plan.warnings.length > 0);
  assertPreviewOnlyCommands(runners.commands);
});

test('consumed admission token cannot be reused for restore', (t) => {
  const root = mkRoot(t, 'df-admission-consumed-');
  const keys = installTestCoordinatorKeys(root);
  const layout = coordinatedLayoutForRoot(path.join(root, 'backups'));
  fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  const { token } = buildTestAdmissionToken({ keyPair: keys.pair });
  registerTestAdmission(layout, token);
  consumeAdmission(layout, token.nonce);
  const { assertAdmissionRegistryState } = require('../lib/restore-quiescence-admission');
  assert.throws(
    () => assertAdmissionRegistryState(token, layout),
    /consumed/,
  );
});

test('extracted bundle tooling runs coordinated backup and restore dry-run without repository', async (t) => {
  const root = mkRoot(t, 'df-relocated-coordinated-');
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
  const extractRoot = path.join(root, 'extract');
  const archive = path.join(root, 'bundle.tgz');
  buildBackupBundle({ dashboardDir: dashboard, archivePath: archive });
  const { verifyBackupBundleArchive } = require('../lib/backup-bundle-verify');
  verifyBackupBundleArchive({ archivePath: archive, publishDir: extractRoot, readOnly: true });
  const toolingCli = path.join(extractRoot, 'tooling/ops/bin/backup-coordinated.js');
  assert.equal(fs.existsSync(toolingCli), true);
  const restoreCli = path.join(extractRoot, 'tooling/ops/bin/restore-coordinated.js');
  assert.equal(fs.existsSync(restoreCli), true);
  const fakeBin = installFakeSystemctl(root, quiescedUnits());
  installTestCoordinatorKeys(root);
  const destination = path.join(root, 'restore-dest');
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'rules.json'), '[]\n', { mode: 0o600 });
  const { spawnSync } = require('child_process');
  const backupResult = spawnSync(process.execPath, [toolingCli], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      HOME: root,
      FINANCE_DASHBOARD_DIR: dashboard,
      DARKFINANCES_BACKUP_DIR: path.join(root, 'backups'),
      DARKFINANCES_REPO_ROOT: path.join(root, 'missing-repo'),
      BACKUP_DRY_RUN: '1',
    },
  });
  assert.equal(backupResult.status, 2, backupResult.stderr || backupResult.stdout);
  const restoreResult = spawnSync(process.execPath, [restoreCli, '--dry-run', archive], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      HOME: root,
      FINANCE_DASHBOARD_DIR: destination,
      DARKFINANCES_BACKUP_DIR: path.join(root, 'backups-restore'),
      DARKFINANCES_REPO_ROOT: path.join(root, 'missing-repo'),
      COORDINATED_VERIFY_KEY_PATH: path.join(root, '.config', 'darkfinances', 'coordinated-verify.pem'),
      COORDINATED_SIGNING_KEY_PATH: path.join(root, '.config', 'darkfinances', 'coordinated-sign.pem'),
    },
  });
  assert.equal(restoreResult.status, 2, restoreResult.stderr || restoreResult.stdout);
  const releaseScript = path.join(extractRoot, 'tooling/scripts/release-manifest.js');
  assert.equal(fs.existsSync(releaseScript), true, 'release-manifest tooling must ship in extracted bundle');
});

function dashboardFixture(root) {
  writeProductionDashboard(root, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      transactionSagas: { schemaVersion: 1, sagas: {} },
      transactionDeletionSagas: { schemaVersion: 1, sagas: {} },
      repaymentConfirmationSagas: { schemaVersion: 1, sagas: {} },
      operationJournal: { schemaVersion: 1, operations: {} },
    },
  });
  writeSchemaV1ReleaseManifest(root);
}

function restoreOptions(env, runners, extra = {}) {
  return {
    pollMs: 1,
    stopDeadlineMs: 2000,
    healthTimeoutMs: 200,
    healthPollMs: 10,
    registerSignalHandlers: false,
    ...extra,
    env,
    runners,
  };
}

test('coordinated restore happy path stops, restores, consumes admission, and restarts', async (t) => {
  const root = mkRoot(t, 'df-coordinated-restore-happy-');
  const dashboard = path.join(root, 'dashboard');
  dashboardFixture(dashboard);
  fs.mkdirSync(dashboard, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dashboard, 'rules.json'), '[]\n', { mode: 0o600 });
  const archive = path.join(root, 'bundle.tgz');
  buildBackupBundle({ dashboardDir: dashboard, archivePath: archive });
  const keys = installTestCoordinatorKeys(root);
  const coordinatorRoot = path.join(root, 'backups');
  const layout = coordinatedLayoutForRoot(coordinatorRoot);
  const runners = createBackupRunners();
  let issuedToken = null;
  let stagedRestoreCalls = 0;
  const result = await runCoordinatedRestore({
    archivePath: archive,
    destinationRoot: dashboard,
    coordinatorRoot,
    privateKey: keys.pair.privateKey,
    releaseManifestDigest: RELEASE_MANIFEST_DIGEST,
    ...restoreOptions({
      ...process.env,
      HOME: root,
      FINANCE_DASHBOARD_DIR: dashboard,
      DARKFINANCES_BACKUP_DIR: coordinatorRoot,
      COORDINATED_VERIFY_KEY_PATH: keys.publicPath,
      COORDINATED_SIGNING_KEY_PATH: keys.privatePath,
      COORDINATED_TEST_SKIP_LOCK: '1',
      FINANCE_API_TOKEN: 'test-token',
    }, runners),
    runStagedRestore: (opts) => {
      stagedRestoreCalls += 1;
      assert.equal(opts.releaseManifestDigest, RELEASE_MANIFEST_DIGEST);
      assert.ok(opts.coordinatedSession);
      issuedToken = issueSignedAdmissionToken({
        layout: opts.coordinatedSession.layout,
        runId: opts.coordinatedSession.runId,
        journalId: opts.coordinatedSession.journalId,
        snapshotsById: opts.coordinatedSession.snapshotsById,
        context: opts.coordinatedSession.context,
        privateKey: keys.pair.privateKey,
        bindings: {
          archiveSha256: sha256File(archive),
          destinationRoot: dashboard,
          manifestArtifactId: require('../lib/backup-bundle-verify').readManifestFromArchive(archive).artifact.id,
          releaseManifestDigest: RELEASE_MANIFEST_DIGEST,
          coordinatedManifestDigest: 'c'.repeat(64),
          writerInventoryDigest: opts.coordinatedSession.writerInventoryDigest,
          actualDataGeneration: null,
        },
      });
      opts.coordinatedSession.onAdmissionIssued?.(issuedToken);
      const { consumeAdmissionToken } = require('../lib/restore-quiescence-admission');
      consumeAdmissionToken(layout, issuedToken);
      opts.coordinatedSession.onAdmissionConsumed?.();
      return { ok: true, phase: 'complete' };
    },
  });
  assert.equal(stagedRestoreCalls, 1);
  assert.equal(result.admissionConsumed, true);
  assert.equal(result.journal.phase, PHASE.COMPLETE);
  assert.equal(result.journal.generationBindings.dashboardReleaseIdentityDigest, SCHEMA_V1_RELEASE_IDENTITY_DIGEST);
  assert.equal(result.journal.generationBindings.releaseManifestDigest, RELEASE_MANIFEST_DIGEST);
  assert.notEqual(result.journal.generationBindings.releaseManifestDigest, result.journal.generationBindings.dashboardReleaseIdentityDigest);
  assert.ok(runners.commands.some((cmd) => cmd.join(' ').includes('stop')));
  assert.ok(runners.commands.some((cmd) => cmd.join(' ').includes('start')));
  assert.throws(() => assertAdmissionRegistryState(issuedToken, layout), /consumed/);
});

test('coordinated restore health succeeds while releaseManifestDigest differs from dashboard identity', async (t) => {
  const root = mkRoot(t, 'df-coordinated-restore-digest-sep-');
  const dashboard = path.join(root, 'dashboard');
  dashboardFixture(dashboard);
  fs.mkdirSync(dashboard, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dashboard, 'rules.json'), '[]\n', { mode: 0o600 });
  const archive = path.join(root, 'bundle.tgz');
  buildBackupBundle({ dashboardDir: dashboard, archivePath: archive });
  const keys = installTestCoordinatorKeys(root);
  const coordinatorRoot = path.join(root, 'backups');
  const layout = coordinatedLayoutForRoot(coordinatorRoot);
  const unrelatedManifestDigest = 'd'.repeat(64);
  assert.notEqual(unrelatedManifestDigest, SCHEMA_V1_RELEASE_IDENTITY_DIGEST);
  const result = await runCoordinatedRestore({
    archivePath: archive,
    destinationRoot: dashboard,
    coordinatorRoot,
    privateKey: keys.pair.privateKey,
    releaseManifestDigest: unrelatedManifestDigest,
    ...restoreOptions({
      ...process.env,
      HOME: root,
      FINANCE_DASHBOARD_DIR: dashboard,
      DARKFINANCES_BACKUP_DIR: coordinatorRoot,
      COORDINATED_VERIFY_KEY_PATH: keys.publicPath,
      COORDINATED_SIGNING_KEY_PATH: keys.privatePath,
      COORDINATED_TEST_SKIP_LOCK: '1',
      FINANCE_API_TOKEN: 'test-token',
    }, createBackupRunners()),
    runStagedRestore: (opts) => {
      assert.equal(opts.releaseManifestDigest, unrelatedManifestDigest);
      const token = issueSignedAdmissionToken({
        layout: opts.coordinatedSession.layout,
        runId: opts.coordinatedSession.runId,
        journalId: opts.coordinatedSession.journalId,
        snapshotsById: opts.coordinatedSession.snapshotsById,
        context: opts.coordinatedSession.context,
        privateKey: keys.pair.privateKey,
        bindings: {
          archiveSha256: sha256File(archive),
          destinationRoot: dashboard,
          manifestArtifactId: require('../lib/backup-bundle-verify').readManifestFromArchive(archive).artifact.id,
          releaseManifestDigest: unrelatedManifestDigest,
          coordinatedManifestDigest: 'c'.repeat(64),
          writerInventoryDigest: opts.coordinatedSession.writerInventoryDigest,
          actualDataGeneration: null,
        },
      });
      opts.coordinatedSession.onAdmissionConsumed?.();
      const { consumeAdmissionToken } = require('../lib/restore-quiescence-admission');
      consumeAdmissionToken(layout, token);
      return { ok: true, phase: 'complete' };
    },
  });
  assert.equal(result.journal.phase, PHASE.COMPLETE);
  assert.equal(result.journal.generationBindings.releaseManifestDigest, unrelatedManifestDigest);
  assert.equal(result.journal.generationBindings.dashboardReleaseIdentityDigest, SCHEMA_V1_RELEASE_IDENTITY_DIGEST);
});

test('coordinated restore fails fast without FINANCE_API_TOKEN when dashboard is running', async (t) => {
  const root = mkRoot(t, 'df-coordinated-restore-missing-token-');
  const dashboard = path.join(root, 'dashboard');
  dashboardFixture(dashboard);
  writeSchemaV1ReleaseManifest(dashboard);
  fs.mkdirSync(dashboard, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dashboard, 'rules.json'), '[]\n', { mode: 0o600 });
  const archive = path.join(root, 'bundle.tgz');
  buildBackupBundle({ dashboardDir: dashboard, archivePath: archive });
  const keys = installTestCoordinatorKeys(root);
  const coordinatorRoot = path.join(root, 'backups');
  const runners = createBackupRunners({ units: defaultActiveUnits() });
  const env = {
    ...process.env,
    HOME: root,
    FINANCE_DASHBOARD_DIR: dashboard,
    DARKFINANCES_BACKUP_DIR: coordinatorRoot,
    COORDINATED_VERIFY_KEY_PATH: keys.publicPath,
    COORDINATED_SIGNING_KEY_PATH: keys.privatePath,
    COORDINATED_TEST_SKIP_LOCK: '1',
  };
  delete env.FINANCE_API_TOKEN;
  const started = Date.now();
  await assert.rejects(
    () => runCoordinatedRestore({
      archivePath: archive,
      destinationRoot: dashboard,
      coordinatorRoot,
      privateKey: keys.pair.privateKey,
      releaseManifestDigest: RELEASE_MANIFEST_DIGEST,
      ...restoreOptions(env, runners, { stopDeadlineMs: 500 }),
    }),
    /FINANCE_API_TOKEN must be a non-empty string for live dashboard release identity capture/,
  );
  assert.ok(Date.now() - started < 500, 'coordinated restore should fail fast without FINANCE_API_TOKEN');
  assert.equal(runners.commands.filter((entry) => entry[0] === 'httpGet').length, 0);
});

test('coordinated restore uses manifest without FINANCE_API_TOKEN when pre-quiesced', async (t) => {
  const root = mkRoot(t, 'df-coordinated-restore-manifest-only-');
  const dashboard = path.join(root, 'dashboard');
  dashboardFixture(dashboard);
  writeSchemaV1ReleaseManifest(dashboard);
  fs.mkdirSync(dashboard, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dashboard, 'rules.json'), '[]\n', { mode: 0o600 });
  const archive = path.join(root, 'bundle.tgz');
  buildBackupBundle({ dashboardDir: dashboard, archivePath: archive });
  const keys = installTestCoordinatorKeys(root);
  const coordinatorRoot = path.join(root, 'backups');
  const layout = coordinatedLayoutForRoot(coordinatorRoot);
  const runners = createBackupRunners({ units: quiescedUnits() });
  const env = {
    ...process.env,
    HOME: root,
    FINANCE_DASHBOARD_DIR: dashboard,
    DARKFINANCES_BACKUP_DIR: coordinatorRoot,
    COORDINATED_VERIFY_KEY_PATH: keys.publicPath,
    COORDINATED_SIGNING_KEY_PATH: keys.privatePath,
    COORDINATED_TEST_SKIP_LOCK: '1',
    BACKUP_PRE_QUIESCED: '1',
  };
  delete env.FINANCE_API_TOKEN;
  let stagedRestoreCalls = 0;
  const result = await runCoordinatedRestore({
    archivePath: archive,
    destinationRoot: dashboard,
    coordinatorRoot,
    privateKey: keys.pair.privateKey,
    releaseManifestDigest: RELEASE_MANIFEST_DIGEST,
    ...restoreOptions(env, runners),
    runStagedRestore: (opts) => {
      stagedRestoreCalls += 1;
      const token = issueSignedAdmissionToken({
        layout: opts.coordinatedSession.layout,
        runId: opts.coordinatedSession.runId,
        journalId: opts.coordinatedSession.journalId,
        snapshotsById: opts.coordinatedSession.snapshotsById,
        context: opts.coordinatedSession.context,
        privateKey: keys.pair.privateKey,
        bindings: {
          archiveSha256: sha256File(archive),
          destinationRoot: dashboard,
          manifestArtifactId: require('../lib/backup-bundle-verify').readManifestFromArchive(archive).artifact.id,
          releaseManifestDigest: RELEASE_MANIFEST_DIGEST,
          coordinatedManifestDigest: 'c'.repeat(64),
          writerInventoryDigest: opts.coordinatedSession.writerInventoryDigest,
          actualDataGeneration: null,
        },
      });
      const { consumeAdmissionToken } = require('../lib/restore-quiescence-admission');
      consumeAdmissionToken(layout, token);
      opts.coordinatedSession.onAdmissionConsumed?.();
      return { ok: true, phase: 'complete' };
    },
  });
  assert.equal(stagedRestoreCalls, 1);
  assert.equal(result.journal.generationBindings.dashboardReleaseIdentityDigest, SCHEMA_V1_RELEASE_IDENTITY_DIGEST);
});

test('RESTORE_PRE_QUIESCED=1 verifies quiescence without stop commands', async (t) => {
  const root = mkRoot(t, 'df-coordinated-restore-pre-quiesced-');
  const dashboard = path.join(root, 'dashboard');
  dashboardFixture(dashboard);
  fs.mkdirSync(dashboard, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dashboard, 'rules.json'), '[]\n', { mode: 0o600 });
  const archive = path.join(root, 'bundle.tgz');
  buildBackupBundle({ dashboardDir: dashboard, archivePath: archive });
  const keys = installTestCoordinatorKeys(root);
  const coordinatorRoot = path.join(root, 'backups');
  const layout = coordinatedLayoutForRoot(coordinatorRoot);
  const runners = createBackupRunners({ units: quiescedUnits() });
  const env = {
    ...process.env,
    HOME: root,
    FINANCE_DASHBOARD_DIR: dashboard,
    DARKFINANCES_BACKUP_DIR: coordinatorRoot,
    COORDINATED_VERIFY_KEY_PATH: keys.publicPath,
    COORDINATED_SIGNING_KEY_PATH: keys.privatePath,
    COORDINATED_TEST_SKIP_LOCK: '1',
    RESTORE_PRE_QUIESCED: '1',
  };
  delete env.FINANCE_API_TOKEN;
  let stagedRestoreCalls = 0;
  const result = await runCoordinatedRestore({
    archivePath: archive,
    destinationRoot: dashboard,
    coordinatorRoot,
    privateKey: keys.pair.privateKey,
    releaseManifestDigest: RELEASE_MANIFEST_DIGEST,
    ...restoreOptions(env, runners),
    runStagedRestore: (opts) => {
      stagedRestoreCalls += 1;
      const token = issueSignedAdmissionToken({
        layout: opts.coordinatedSession.layout,
        runId: opts.coordinatedSession.runId,
        journalId: opts.coordinatedSession.journalId,
        snapshotsById: opts.coordinatedSession.snapshotsById,
        context: opts.coordinatedSession.context,
        privateKey: keys.pair.privateKey,
        bindings: {
          archiveSha256: sha256File(archive),
          destinationRoot: dashboard,
          manifestArtifactId: require('../lib/backup-bundle-verify').readManifestFromArchive(archive).artifact.id,
          releaseManifestDigest: RELEASE_MANIFEST_DIGEST,
          coordinatedManifestDigest: 'c'.repeat(64),
          writerInventoryDigest: opts.coordinatedSession.writerInventoryDigest,
          actualDataGeneration: null,
        },
      });
      const { consumeAdmissionToken } = require('../lib/restore-quiescence-admission');
      consumeAdmissionToken(layout, token);
      opts.coordinatedSession.onAdmissionConsumed?.();
      return { ok: true, phase: 'complete' };
    },
  });
  assert.equal(stagedRestoreCalls, 1);
  assert.ok(!runners.commands.some((cmd) => cmd[0] === 'systemctl' && cmd.includes('stop')));
  assert.equal(result.journal.options.preQuiesced, true);
  assert.equal(result.journal.generationBindings.dashboardReleaseIdentityDigest, SCHEMA_V1_RELEASE_IDENTITY_DIGEST);
});

test('FINANCE_EVENT_SYNC_CONFIGURED=1 rejects legacy owes-snapshot cron before restore quiescence', async (t) => {
  const root = mkRoot(t, 'df-coordinated-restore-event-sync-cron-');
  const dashboard = path.join(root, 'dashboard');
  dashboardFixture(dashboard);
  const archive = path.join(root, 'bundle.tgz');
  buildBackupBundle({ dashboardDir: dashboard, archivePath: archive });
  const keys = installTestCoordinatorKeys(root);
  const coordinatorRoot = path.join(root, 'backups');
  const runners = createBackupRunners({
    units: quiescedUnits(),
    crontabListing: '*/30 * * * * bash /home/dark/actual-tools/run.sh owes-snapshot.js\n',
  });
  await assert.rejects(
    () => runCoordinatedRestore({
      archivePath: archive,
      destinationRoot: dashboard,
      coordinatorRoot,
      privateKey: keys.pair.privateKey,
      releaseManifestDigest: RELEASE_MANIFEST_DIGEST,
      ...restoreOptions({
        ...process.env,
        HOME: root,
        FINANCE_DASHBOARD_DIR: dashboard,
        DARKFINANCES_BACKUP_DIR: coordinatorRoot,
        COORDINATED_VERIFY_KEY_PATH: keys.publicPath,
        COORDINATED_SIGNING_KEY_PATH: keys.privatePath,
        COORDINATED_TEST_SKIP_LOCK: '1',
        FINANCE_EVENT_SYNC_CONFIGURED: '1',
        FINANCE_API_TOKEN: 'test-token',
      }, runners),
    }),
    /legacy owes-snapshot\.js cron entry must be removed/,
  );
});

test('coordinated restore capture fails closed on empty ping release object', async (t) => {
  const root = mkRoot(t, 'df-coordinated-restore-empty-release-');
  const dashboard = path.join(root, 'dashboard');
  dashboardFixture(dashboard);
  fs.mkdirSync(dashboard, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dashboard, 'rules.json'), '[]\n', { mode: 0o600 });
  const archive = path.join(root, 'bundle.tgz');
  buildBackupBundle({ dashboardDir: dashboard, archivePath: archive });
  const keys = installTestCoordinatorKeys(root);
  const coordinatorRoot = path.join(root, 'backups');
  const runners = createBackupRunners({
    pingResponse: {
      status: 200,
      body: envelopedPingBody({ ok: true, release: {} }),
    },
  });
  await assert.rejects(
    () => runCoordinatedRestore({
      archivePath: archive,
      destinationRoot: dashboard,
      coordinatorRoot,
      privateKey: keys.pair.privateKey,
      releaseManifestDigest: RELEASE_MANIFEST_DIGEST,
      ...restoreOptions({
        ...process.env,
        HOME: root,
        FINANCE_DASHBOARD_DIR: dashboard,
        DARKFINANCES_BACKUP_DIR: coordinatorRoot,
        COORDINATED_VERIFY_KEY_PATH: keys.publicPath,
        COORDINATED_SIGNING_KEY_PATH: keys.privatePath,
        COORDINATED_TEST_SKIP_LOCK: '1',
        FINANCE_API_TOKEN: 'test-token',
      }, runners),
    }),
    /dashboard release identity unavailable before quiescence/,
  );
});

test('coordinated restore fails closed when post-restart ping reports null release identity', async (t) => {
  const root = mkRoot(t, 'df-coordinated-restore-null-ping-');
  const dashboard = path.join(root, 'dashboard');
  dashboardFixture(dashboard);
  fs.mkdirSync(dashboard, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dashboard, 'rules.json'), '[]\n', { mode: 0o600 });
  const archive = path.join(root, 'bundle.tgz');
  buildBackupBundle({ dashboardDir: dashboard, archivePath: archive });
  const keys = installTestCoordinatorKeys(root);
  const coordinatorRoot = path.join(root, 'backups');
  const layout = coordinatedLayoutForRoot(coordinatorRoot);
  const runners = createBackupRunners({
    pingResponses: [
      defaultEnvelopedPingResponse(),
      { status: 200, body: envelopedPingBody({ ok: true, release: null }) },
    ],
  });
  await assert.rejects(
    () => runCoordinatedRestore({
      archivePath: archive,
      destinationRoot: dashboard,
      coordinatorRoot,
      privateKey: keys.pair.privateKey,
      releaseManifestDigest: RELEASE_MANIFEST_DIGEST,
      ...restoreOptions({
        ...process.env,
        HOME: root,
        FINANCE_DASHBOARD_DIR: dashboard,
        DARKFINANCES_BACKUP_DIR: coordinatorRoot,
        COORDINATED_VERIFY_KEY_PATH: keys.publicPath,
        COORDINATED_SIGNING_KEY_PATH: keys.privatePath,
        COORDINATED_TEST_SKIP_LOCK: '1',
        FINANCE_API_TOKEN: 'test-token',
      }, runners),
      runStagedRestore: (opts) => {
        const token = issueSignedAdmissionToken({
          layout: opts.coordinatedSession.layout,
          runId: opts.coordinatedSession.runId,
          journalId: opts.coordinatedSession.journalId,
          snapshotsById: opts.coordinatedSession.snapshotsById,
          context: opts.coordinatedSession.context,
          privateKey: keys.pair.privateKey,
          bindings: {
            archiveSha256: sha256File(archive),
            destinationRoot: dashboard,
            manifestArtifactId: require('../lib/backup-bundle-verify').readManifestFromArchive(archive).artifact.id,
            releaseManifestDigest: RELEASE_MANIFEST_DIGEST,
            coordinatedManifestDigest: 'c'.repeat(64),
            writerInventoryDigest: opts.coordinatedSession.writerInventoryDigest,
            actualDataGeneration: null,
          },
        });
        opts.coordinatedSession.onAdmissionConsumed?.();
        const { consumeAdmissionToken } = require('../lib/restore-quiescence-admission');
        consumeAdmissionToken(layout, token);
        return { ok: true, phase: 'complete' };
      },
    }),
    /post-restart health verification failed/,
  );
});

test('coordinated restore fails closed when post-restart ping reports empty release object', async (t) => {
  const root = mkRoot(t, 'df-coordinated-restore-empty-post-');
  const dashboard = path.join(root, 'dashboard');
  dashboardFixture(dashboard);
  fs.mkdirSync(dashboard, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dashboard, 'rules.json'), '[]\n', { mode: 0o600 });
  const archive = path.join(root, 'bundle.tgz');
  buildBackupBundle({ dashboardDir: dashboard, archivePath: archive });
  const keys = installTestCoordinatorKeys(root);
  const coordinatorRoot = path.join(root, 'backups');
  const layout = coordinatedLayoutForRoot(coordinatorRoot);
  const runners = createBackupRunners({
    pingResponses: [
      defaultEnvelopedPingResponse(),
      { status: 200, body: envelopedPingBody({ ok: true, release: {} }) },
    ],
  });
  await assert.rejects(
    () => runCoordinatedRestore({
      archivePath: archive,
      destinationRoot: dashboard,
      coordinatorRoot,
      privateKey: keys.pair.privateKey,
      releaseManifestDigest: RELEASE_MANIFEST_DIGEST,
      ...restoreOptions({
        ...process.env,
        HOME: root,
        FINANCE_DASHBOARD_DIR: dashboard,
        DARKFINANCES_BACKUP_DIR: coordinatorRoot,
        COORDINATED_VERIFY_KEY_PATH: keys.publicPath,
        COORDINATED_SIGNING_KEY_PATH: keys.privatePath,
        COORDINATED_TEST_SKIP_LOCK: '1',
        FINANCE_API_TOKEN: 'test-token',
      }, runners),
      runStagedRestore: (opts) => {
        const token = issueSignedAdmissionToken({
          layout: opts.coordinatedSession.layout,
          runId: opts.coordinatedSession.runId,
          journalId: opts.coordinatedSession.journalId,
          snapshotsById: opts.coordinatedSession.snapshotsById,
          context: opts.coordinatedSession.context,
          privateKey: keys.pair.privateKey,
          bindings: {
            archiveSha256: sha256File(archive),
            destinationRoot: dashboard,
            manifestArtifactId: require('../lib/backup-bundle-verify').readManifestFromArchive(archive).artifact.id,
            releaseManifestDigest: RELEASE_MANIFEST_DIGEST,
            coordinatedManifestDigest: 'c'.repeat(64),
            writerInventoryDigest: opts.coordinatedSession.writerInventoryDigest,
            actualDataGeneration: null,
          },
        });
        opts.coordinatedSession.onAdmissionConsumed?.();
        require('../lib/restore-quiescence-admission').consumeAdmissionToken(layout, token);
        return { ok: true, phase: 'complete' };
      },
    }),
    /post-restart health verification failed/,
  );
});

test('coordinated restore journal resume at restore_staged skips staged restore and completes health', async (t) => {
  const root = mkRoot(t, 'df-coordinated-restore-resume-');
  const dashboard = path.join(root, 'dashboard');
  dashboardFixture(dashboard);
  fs.mkdirSync(dashboard, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dashboard, 'rules.json'), '[]\n', { mode: 0o600 });
  const archive = path.join(root, 'bundle.tgz');
  buildBackupBundle({ dashboardDir: dashboard, archivePath: archive });
  const keys = installTestCoordinatorKeys(root);
  const coordinatorRoot = path.join(root, 'backups');
  const layout = coordinatedLayoutForRoot(coordinatorRoot);
  fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  const inventory = loadWriterInventory();
  const setupRunners = createMockRunners({ units: quiescedUnits() });
  const { snapshots } = require('../lib/writer-quiescence').discoverWriters({
    inventory,
    env: { ...process.env, HOME: root, FINANCE_DASHBOARD_DIR: dashboard },
    runners: setupRunners,
    dashboardDir: dashboard,
  });
  const journal = createRunJournal({
    runId: 'restore-resume',
    operation: 'restore',
    layout,
    writerInventory: inventory,
    preRunWriters: snapshots,
    options: { includeActualData: false, preQuiesced: false, dashboardDir: dashboard },
  });
  journal.phase = PHASE.RESTORE_STAGED;
  journal.generationBindings = {
    dashboardReleaseIdentityDigest: SCHEMA_V1_RELEASE_IDENTITY_DIGEST,
    releaseManifestDigest: RELEASE_MANIFEST_DIGEST,
  };
  journal.restoreResult = { ok: true, phase: 'complete' };
  writeRunJournal(layout.journalPath, journal);
  let stagedRestoreCalls = 0;
  const result = await runCoordinatedRestore({
    archivePath: archive,
    destinationRoot: dashboard,
    coordinatorRoot,
    privateKey: keys.pair.privateKey,
    releaseManifestDigest: RELEASE_MANIFEST_DIGEST,
    ...restoreOptions({
      ...process.env,
      HOME: root,
      FINANCE_DASHBOARD_DIR: dashboard,
      DARKFINANCES_BACKUP_DIR: coordinatorRoot,
      COORDINATED_VERIFY_KEY_PATH: keys.publicPath,
      COORDINATED_SIGNING_KEY_PATH: keys.privatePath,
      COORDINATED_TEST_SKIP_LOCK: '1',
      FINANCE_API_TOKEN: 'test-token',
    }, createBackupRunners({ units: quiescedUnits() })),
    runStagedRestore: () => {
      stagedRestoreCalls += 1;
      return { ok: true, phase: 'complete' };
    },
  });
  assert.equal(stagedRestoreCalls, 0);
  assert.equal(result.journal.phase, PHASE.COMPLETE);
  assert.equal(result.journal.generationBindings.dashboardReleaseIdentityDigest, SCHEMA_V1_RELEASE_IDENTITY_DIGEST);
});

test('coordinated restore fails closed when post-restart dashboard release identity mismatches', async (t) => {
  const root = mkRoot(t, 'df-coordinated-restore-mismatch-');
  const dashboard = path.join(root, 'dashboard');
  dashboardFixture(dashboard);
  fs.mkdirSync(dashboard, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dashboard, 'rules.json'), '[]\n', { mode: 0o600 });
  const archive = path.join(root, 'bundle.tgz');
  buildBackupBundle({ dashboardDir: dashboard, archivePath: archive });
  const keys = installTestCoordinatorKeys(root);
  const coordinatorRoot = path.join(root, 'backups');
  const layout = coordinatedLayoutForRoot(coordinatorRoot);
  const mismatched = {
    commit: '0000000',
    dirty: true,
    lockSha256: 'e'.repeat(64),
    contract: 'deadbeefdeadbeef',
    appVersion: '9.9.9',
    builtAt: '2099-01-01T00:00:00.000Z',
  };
  const runners = createBackupRunners({
    pingResponses: [
      defaultEnvelopedPingResponse(),
      defaultEnvelopedPingResponse(mismatched),
    ],
  });
  await assert.rejects(
    () => runCoordinatedRestore({
      archivePath: archive,
      destinationRoot: dashboard,
      coordinatorRoot,
      privateKey: keys.pair.privateKey,
      releaseManifestDigest: RELEASE_MANIFEST_DIGEST,
      ...restoreOptions({
        ...process.env,
        HOME: root,
        FINANCE_DASHBOARD_DIR: dashboard,
        DARKFINANCES_BACKUP_DIR: coordinatorRoot,
        COORDINATED_VERIFY_KEY_PATH: keys.publicPath,
        COORDINATED_SIGNING_KEY_PATH: keys.privatePath,
        COORDINATED_TEST_SKIP_LOCK: '1',
        FINANCE_API_TOKEN: 'test-token',
      }, runners),
      runStagedRestore: (opts) => {
        const token = issueSignedAdmissionToken({
          layout: opts.coordinatedSession.layout,
          runId: opts.coordinatedSession.runId,
          journalId: opts.coordinatedSession.journalId,
          snapshotsById: opts.coordinatedSession.snapshotsById,
          context: opts.coordinatedSession.context,
          privateKey: keys.pair.privateKey,
          bindings: {
            archiveSha256: sha256File(archive),
            destinationRoot: dashboard,
            manifestArtifactId: require('../lib/backup-bundle-verify').readManifestFromArchive(archive).artifact.id,
            releaseManifestDigest: RELEASE_MANIFEST_DIGEST,
            coordinatedManifestDigest: 'c'.repeat(64),
            writerInventoryDigest: opts.coordinatedSession.writerInventoryDigest,
            actualDataGeneration: null,
          },
        });
        opts.coordinatedSession.onAdmissionConsumed?.();
        require('../lib/restore-quiescence-admission').consumeAdmissionToken(layout, token);
        return { ok: true, phase: 'complete' };
      },
    }),
    /post-restart health verification failed/,
  );
});

test('coordinated restore failure after token issue revokes admission', async (t) => {
  const root = mkRoot(t, 'df-coordinated-restore-fail-token-');
  const dashboard = path.join(root, 'dashboard');
  dashboardFixture(dashboard);
  fs.mkdirSync(dashboard, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dashboard, 'rules.json'), '[]\n', { mode: 0o600 });
  const archive = path.join(root, 'bundle.tgz');
  buildBackupBundle({ dashboardDir: dashboard, archivePath: archive });
  const keys = installTestCoordinatorKeys(root);
  const coordinatorRoot = path.join(root, 'backups');
  const layout = coordinatedLayoutForRoot(coordinatorRoot);
  const runners = createMockRunners({ units: quiescedUnits() });
  let issuedToken = null;
  await assert.rejects(
    () => runCoordinatedRestore({
      archivePath: archive,
      destinationRoot: dashboard,
      coordinatorRoot,
      privateKey: keys.pair.privateKey,
      env: {
        ...process.env,
        HOME: root,
        FINANCE_DASHBOARD_DIR: dashboard,
        DARKFINANCES_BACKUP_DIR: coordinatorRoot,
        COORDINATED_VERIFY_KEY_PATH: keys.publicPath,
        COORDINATED_SIGNING_KEY_PATH: keys.privatePath,
        COORDINATED_TEST_SKIP_LOCK: '1',
      },
      runners,
      runStagedRestore: (opts) => {
        issuedToken = issueSignedAdmissionToken({
          layout: opts.coordinatedSession.layout,
          runId: opts.coordinatedSession.runId,
          journalId: opts.coordinatedSession.journalId,
          snapshotsById: opts.coordinatedSession.snapshotsById,
          context: opts.coordinatedSession.context,
          privateKey: keys.pair.privateKey,
          bindings: {
            archiveSha256: sha256File(archive),
            destinationRoot: dashboard,
            manifestArtifactId: require('../lib/backup-bundle-verify').readManifestFromArchive(archive).artifact.id,
            releaseManifestDigest: 'b'.repeat(64),
            coordinatedManifestDigest: 'c'.repeat(64),
            writerInventoryDigest: opts.coordinatedSession.writerInventoryDigest,
            actualDataGeneration: null,
          },
        });
        opts.coordinatedSession.onAdmissionIssued?.(issuedToken);
        throw new Error('staged restore failed after token issue');
      },
    }),
    /staged restore failed after token issue/,
  );
  assert.throws(() => assertAdmissionRegistryState(issuedToken, layout), /revoked/);
});

test('admission token path rejects symlink outside trusted roots', (t) => {
  const root = mkRoot(t, 'df-admission-path-');
  const keys = installTestCoordinatorKeys(root);
  const layout = coordinatedLayoutForRoot(path.join(root, 'backups'));
  fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  const { token } = buildTestAdmissionToken({ keyPair: keys.pair });
  registerTestAdmission(layout, token);
  const outside = path.join(root, 'outside-token.json');
  fs.writeFileSync(outside, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  const { readAdmissionTokenFile } = require('../lib/restore-quiescence-admission');
  assert.throws(
    () => readAdmissionTokenFile(outside, { layout }),
    /outside trusted coordinator roots/,
  );
});
