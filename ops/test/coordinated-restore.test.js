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
const { consumeAdmission } = require('../lib/coordinated-admission-registry');
const { parseAdmissionToken } = require('../lib/restore-quiescence-admission');
const { buildTestAdmissionToken, registerTestAdmission } = require('./fixtures/admission-token-fixtures');
const { installTestCoordinatorKeys, installFakeSystemctl } = require('./fixtures/coordinated-test-helpers');
const { createMockRunners, defaultActiveUnits } = require('./fixtures/coordinated-backup-fixtures');
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
  const tokenPath = path.join(root, 'admission.json');
  fs.writeFileSync(tokenPath, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
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
  const before = fs.existsSync(dashboard) ? fs.readdirSync(dashboard).length : 0;
  const result = await runCoordinatedRestore({
    dryRun: true,
    archivePath: archive,
    destinationRoot: dashboard,
    coordinatorRoot: path.join(root, 'backups'),
    env: {
      ...process.env,
      HOME: root,
      FINANCE_DASHBOARD_DIR: dashboard,
      DARKFINANCES_BACKUP_DIR: path.join(root, 'backups'),
      COORDINATED_VERIFY_KEY_PATH: path.join(root, '.config', 'darkfinances', 'coordinated-verify.pem'),
      COORDINATED_SIGNING_KEY_PATH: path.join(root, '.config', 'darkfinances', 'coordinated-sign.pem'),
    },
    runners: createMockRunners({ units: quiescedUnits() }),
  });
  assert.equal(result.dryRun, true);
  assert.equal(fs.readdirSync(dashboard).length, before);
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
});
