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
const { PHASE } = require('../lib/coordinated-run-journal');
const { buildTestAdmissionToken, registerTestAdmission } = require('./fixtures/admission-token-fixtures');
const { installTestCoordinatorKeys, installFakeSystemctl, writeTrustedAdmissionToken, assertPreviewOnlyCommands } = require('./fixtures/coordinated-test-helpers');
const { createMockRunners, defaultActiveUnits, RELEASE_MANIFEST_DIGEST } = require('./fixtures/coordinated-backup-fixtures');
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
  const runners = createMockRunners({ units: defaultActiveUnits() });
  let issuedToken = null;
  const result = await runCoordinatedRestore({
    archivePath: archive,
    destinationRoot: dashboard,
    coordinatorRoot,
    privateKey: keys.pair.privateKey,
    releaseManifestDigest: RELEASE_MANIFEST_DIGEST,
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
          releaseManifestDigest: 'b'.repeat(64),
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
  assert.equal(result.admissionConsumed, true);
  assert.ok(runners.commands.some((cmd) => cmd.join(' ').includes('stop')));
  assert.ok(runners.commands.some((cmd) => cmd.join(' ').includes('start')));
  assert.throws(() => assertAdmissionRegistryState(issuedToken, layout), /consumed/);
  assert.ok([PHASE.RESTORE_STAGED, PHASE.RESTART_COMPLETE, PHASE.HEALTH_VERIFIED, PHASE.COMPLETE]
    .includes(result.journal.phase));
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
