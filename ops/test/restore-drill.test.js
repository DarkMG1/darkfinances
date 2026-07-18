'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('node:events');
const { spawnSync, spawn } = require('child_process');
const { buildBackupBundle } = require('../lib/build-backup-bundle');
const {
  BINDING_FIELD,
  buildGenerationBinding,
  bindingsEquivalent,
} = require('../lib/restore-generation-binding');
const { buildTestAdmissionToken, registerTestAdmission } = require('./fixtures/admission-token-fixtures');
const { installTestCoordinatorKeys, installFakeSystemctl, restoreDrillContext } = require('./fixtures/coordinated-test-helpers');
const { coordinatedLayoutForRoot } = require('../lib/coordinated-operation-layout');
const { sha256File } = require('../lib/backup-verify');
const { controlLayoutForDestination } = require('../lib/restore-control-layout');
const { buildSnapshotManifest } = require('../lib/restore-snapshot');
const {
  runStagedRestore,
  PHASE,
  readJournal,
  JOURNAL_MAX_BYTES,
} = require('../lib/staged-restore');
const {
  LOCK_KIND,
  LOCK_SCHEMA_VERSION,
  lockPathForLayout,
} = require('../lib/restore-instance-lock');
const { writeProductionDashboard, PRODUCTION_SHAPED } = require('./fixtures/backup-bundle-dashboard-fixtures');
const { findExecutableInPath } = require('../lib/ops-command-runners');

const repoRoot = path.resolve(__dirname, '..', '..');
const restoreShell = path.join(repoRoot, 'ops/bin/restore-dashboard-runtime.sh');

function mkRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function stagedRestore(root, destination, archive, options = {}, extra = {}) {
  const ctx = restoreDrillContext(root, destination, archive, extra);
  const {
    runners: optionRunners,
    env: envOverride,
    coordinatorRoot: optionCoordinatorRoot,
    layout: optionLayout,
    ...restoreOptions
  } = options;
  return runStagedRestore({
    archivePath: archive,
    destinationRoot: destination,
    env: envOverride ?? ctx.env,
    runners: optionRunners ?? ctx.runners,
    coordinatorRoot: optionCoordinatorRoot ?? ctx.coordinatorRoot,
    layout: optionLayout ?? ctx.layout,
    ...restoreOptions,
  });
}

function controlJournal(destination) {
  const layout = controlLayoutForDestination(destination);
  return readJournal(layout.journalPath);
}

function buildBundle(root, dashboardDir, provenance = {}, options = {}) {
  const archive = path.join(root, 'bundle.tgz');
  buildBackupBundle({
    dashboardDir,
    archivePath: archive,
    provenance,
    embedGenerationBindings: options.embedGenerationBindings !== false,
  });
  return archive;
}

const TERMINAL_SAGAS_OVERRIDE = {
  bulkOperationSagas: { schemaVersion: 1, sagas: {} },
};

function writeTerminalSagaDashboard(root, extraOverrides = {}) {
  writeProductionDashboard(root, {
    overrides: {
      ...TERMINAL_SAGAS_OVERRIDE,
      ...extraOverrides,
    },
  });
}

function bindActiveBulkSaga(dashboardDir, binding) {
  const file = path.join(dashboardDir, 'bulk-operation-sagas.json');
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  payload.sagas.b1[BINDING_FIELD] = binding;
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

function manifestFromArchive(archive) {
  return JSON.parse(fs.readFileSync(`${archive}.manifest.json`, 'utf8'));
}

function destinationSnapshot(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  function walk(relativeDir) {
    const absoluteDir = relativeDir ? path.join(root, relativeDir) : root;
    for (const name of fs.readdirSync(absoluteDir).sort()) {
      const relativePath = relativeDir ? `${relativeDir}/${name}` : name;
      const absolutePath = path.join(root, relativePath);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isDirectory()) walk(relativePath);
      else files.push(relativePath);
    }
  }
  walk('');
  return files.sort();
}

test('reproduces legacy overlay: stale destination-only files survive tar extract restore', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-restore-repro-'));
  try {
    const dashboard = path.join(root, 'dashboard');
    const stale = path.join(root, 'stale-only');
    writeProductionDashboard(dashboard);
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'orphan-sidecar.json'), '{"stale":true}\n', { mode: 0o600 });
    fs.writeFileSync(path.join(stale, 'rules.json'), '[]\n', { mode: 0o600 });

    const archive = buildBundle(root, dashboard);
    const extractOnly = spawnSync('tar', ['-xzf', archive, '-C', stale, 'runtime'], { encoding: 'utf8' });
    assert.equal(extractOnly.status, 0, extractOnly.stderr);
    for (const entry of fs.readdirSync(path.join(stale, 'runtime'))) {
      fs.renameSync(path.join(stale, 'runtime', entry), path.join(stale, entry));
    }
    fs.rmSync(path.join(stale, 'runtime'), { recursive: true, force: true });
    assert.equal(fs.existsSync(path.join(stale, 'orphan-sidecar.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('staged restore removes destination-only stale files and refuses unknown extras', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-stale-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeTerminalSagaDashboard(dashboard);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(destination, 'receipts'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'rules.json'), '[]\n', { mode: 0o600 });
  fs.writeFileSync(path.join(destination, 'receipts', 'stale-only.jpg'), 'stale\n', { mode: 0o600 });

  const archive = buildBundle(root, dashboard);
  stagedRestore(root, destination, archive, { dryRun: false, confirm: true });
  assert.equal(fs.existsSync(path.join(destination, 'receipts', 'stale-only.jpg')), false);
  assert.notEqual(fs.readFileSync(path.join(destination, 'rules.json'), 'utf8'), '[]\n');

  fs.writeFileSync(path.join(destination, 'unexpected.txt'), 'fail\n', { mode: 0o600 });
  assert.throws(
    () => stagedRestore(root, destination, archive, {dryRun: true,
    }),
    /completed restore destination drift detected/,
  );
});

test('dry-run performs checks and writes no destination bytes', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-dry-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeTerminalSagaDashboard(dashboard);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'rules.json'), '{"rules":[]}\n', { mode: 0o600 });
  const before = destinationSnapshot(destination);

  const archive = buildBundle(root, dashboard);
  const result = stagedRestore(root, destination, archive, {dryRun: true,
    });
  assert.equal(result.dryRun, true);
  assert.equal(result.phase, PHASE.PREFLIGHT_PASSED);
  assert.deepEqual(destinationSnapshot(destination), before);
  assert.equal(fs.existsSync(path.join(destination, '.darkfinances-restore')), false);
});

test('refuses restore without quiescence admission token', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-quiesce-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeProductionDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  assert.throws(
    () => stagedRestore(root, destination, archive, {dryRun: true,
      env: { ...process.env, RESTORE_QUIESCENCE_ADMISSION_PATH: '' },
    }),
    /missing signed quiescence admission token/,
  );
});

test('dry-run on missing destination creates no destination tree', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-missing-dry-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'missing-destination');
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  writeTerminalSagaDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  assert.equal(fs.existsSync(destination), false);
  stagedRestore(root, destination, archive, { dryRun: true });
  assert.equal(fs.existsSync(destination), false);
});

test('checksum tamper fails before swap', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-checksum-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeTerminalSagaDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  const bytes = fs.readFileSync(archive);
  bytes[bytes.length - 40] ^= 0xff;
  const tampered = path.join(root, 'tampered.tgz');
  fs.writeFileSync(tampered, bytes);
  fs.copyFileSync(`${archive}.manifest.json`, `${tampered}.manifest.json`);
  fs.copyFileSync(`${archive}.sha256`, `${tampered}.sha256`);
  assert.throws(
    () => stagedRestore(root, destination, tampered, {dryRun: true,
    }),
    /checksum mismatch|archive checksum mismatch|Damaged tar archive|Truncated tar archive|truncated gzip input/i,
  );
});

test('active legacy saga without generation binding fails before swap', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-legacy-saga-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeProductionDashboard(dashboard);
  const archive = buildBundle(root, dashboard, {}, { embedGenerationBindings: false });
  assert.throws(
    () => stagedRestore(root, destination, archive, {dryRun: true,
    }),
    /active restore subjects lack restoreGenerationBinding/,
  );
});

test('active saga with matching generation binding restores successfully', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-bound-saga-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeProductionDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: {
        schemaVersion: 1,
        sagas: {
          b1: {
            id: 'b1',
            recordVersion: 1,
            kind: 'rules_apply',
            phase: 'planning',
            status: 'started',
            updatedAt: '2026-07-13T00:00:00.000Z',
          },
        },
      },
    },
  });
  const archive = buildBundle(root, dashboard);

  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'rules.json'), '[]\n', { mode: 0o600 });

  const result = stagedRestore(root, destination, archive, {dryRun: false, confirm: true,
  });
  assert.equal(result.phase, PHASE.COMPLETE);
  assert.equal(fs.existsSync(path.join(destination, 'bulk-operation-sagas.json')), true);
});

test('active reimbursement link saga with matching generation binding restores successfully', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-reimb-link-saga-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeProductionDashboard(dashboard, {
    overrides: {
      reimbursementLinkSagas: {
        schemaVersion: 1,
        sagas: {
          link1: {
            id: 'link1',
            recordVersion: 1,
            phase: 'prepared',
            status: 'started',
            action: 'link',
            inflowId: 'in1',
            expenseId: 'ex1',
            updatedAt: '2026-07-13T00:00:00.000Z',
          },
        },
      },
    },
  });
  const archive = buildBundle(root, dashboard);

  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'reimb-links.json'), '{"schemaVersion":2,"links":[]}\n', { mode: 0o600 });

  const result = stagedRestore(root, destination, archive, {dryRun: false, confirm: true,
  });
  assert.equal(result.phase, PHASE.COMPLETE);
  assert.equal(fs.existsSync(path.join(destination, 'reimbursement-link-sagas.json')), true);
});

test('active saga with mismatched Actual/release generation fails before swap', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-mismatch-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeTerminalSagaDashboard(dashboard);
  const archive = buildBundle(root, dashboard, {
    actualDataGeneration: 'a'.repeat(64),
    releaseManifestDigest: 'b'.repeat(64),
  });

  assert.throws(
    () => stagedRestore(root, destination, archive, {
      dryRun: true,
      actualDataGeneration: 'c'.repeat(64),
      releaseManifestDigest: 'b'.repeat(64),
    }),
    /Actual data generation does not match/,
  );
});

test('path traversal member fails archive verification before staging', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-traversal-');
  const dashboard = path.join(root, 'dashboard');
  writeTerminalSagaDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  const { assertTarMembersSafe, listTarMembers } = require('../lib/backup-bundle-verify');
  const members = listTarMembers(archive);
  assert.throws(
    () => assertTarMembersSafe([...members, '../escape.txt']),
    /unsafe archive member/,
  );
});

test('interruption after snapshot capture can resume via fixed control journal without explicit workRoot', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-resume-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeTerminalSagaDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'rules.json'), '[]\n', { mode: 0o600 });

  assert.throws(
    () => stagedRestore(root, destination, archive, {dryRun: false,
      confirm: true,
          }, {
        RESTORE_FAULT_SCHEDULE: JSON.stringify([{ point: 'after:snapshot-capture', throwError: 'interrupt' }]),
      }),
    /interrupt/,
  );

  const resumed = stagedRestore(root, destination, archive, {dryRun: false, confirm: true,
  });
  assert.equal(resumed.phase, PHASE.COMPLETE);
  assert.equal(resumed.resumed, true);
});

test('interruption during swap rolls back entire prior generation byte-for-byte', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-rollback-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeProductionDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: { schemaVersion: 1, sagas: {} },
      rules: { rules: [{ id: 'keep', payee: 'Original', category: 'c1' }] },
    },
  });
  const archive = buildBundle(root, dashboard);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(destination, 'rules.json'),
    `${JSON.stringify({ rules: [{ id: 'keep', payee: 'Original', category: 'c1' }] }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const originalRules = fs.readFileSync(path.join(destination, 'rules.json'), 'utf8');
  const beforeManifest = buildSnapshotManifest(destination, require('../lib/backup-bundle-inventory').loadBackupStateInventory());

  assert.throws(
    () => stagedRestore(root, destination, archive, {dryRun: false,
      confirm: true,
          }, {
        RESTORE_FAULT_SCHEDULE: JSON.stringify([{ point: 'after:swap-file', detail: 'rules.json', throwError: 'swap interrupt' }]),
      }),
    /swap interrupt/,
  );

  assert.equal(fs.readFileSync(path.join(destination, 'rules.json'), 'utf8'), originalRules);
  const afterManifest = buildSnapshotManifest(destination, require('../lib/backup-bundle-inventory').loadBackupStateInventory());
  assert.equal(afterManifest.digest, beforeManifest.digest);
});

test('sparse destination rollback removes introduced files and restores prior bytes', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-sparse-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeTerminalSagaDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const sparseRules = `${JSON.stringify({ rules: [{ id: 'only', payee: 'Sparse', category: 'c1' }] }, null, 2)}\n`;
  fs.writeFileSync(path.join(destination, 'rules.json'), sparseRules, { mode: 0o600 });
  const beforeManifest = buildSnapshotManifest(destination, require('../lib/backup-bundle-inventory').loadBackupStateInventory());

  assert.throws(
    () => stagedRestore(root, destination, archive, {dryRun: false,
      confirm: true,
          }, {
        RESTORE_FAULT_SCHEDULE: JSON.stringify([{ point: 'after:swap-file', detail: 'account-overrides.json', throwError: 'sparse interrupt' }]),
      }),
    /sparse interrupt/,
  );

  assert.equal(fs.readFileSync(path.join(destination, 'rules.json'), 'utf8'), sparseRules);
  assert.equal(fs.existsSync(path.join(destination, 'account-overrides.json')), false);
  const afterManifest = buildSnapshotManifest(destination, require('../lib/backup-bundle-inventory').loadBackupStateInventory());
  assert.equal(afterManifest.digest, beforeManifest.digest);
});

test('ENOSPC during preflight fails before swap', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-enospc-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeProductionDashboard(dashboard, { overrides: { bulkOperationSagas: { schemaVersion: 1, sagas: {} } } });
  const archive = buildBundle(root, dashboard);
  assert.throws(
    () => stagedRestore(root, destination, archive, {dryRun: true,
          }, { RESTORE_TEST_ENOSPC: '1' }),
    /insufficient disk space/,
  );
});

test('permission fault during swap surfaces failure', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-eacces-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeProductionDashboard(dashboard, { overrides: { bulkOperationSagas: { schemaVersion: 1, sagas: {} } } });
  const archive = buildBundle(root, dashboard);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'rules.json'), '[]\n', { mode: 0o600 });
  assert.throws(
    () => stagedRestore(root, destination, archive, {dryRun: false,
      confirm: true,
          }, {
        RESTORE_FAULT_SCHEDULE: JSON.stringify([{ point: 'before:swap-file', detail: 'rules.json', code: 'EACCES' }]),
      }),
    /permission denied|EACCES/,
  );
});

test('relocated install with no repository restores via bundled tooling only', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-relocated-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeProductionDashboard(dashboard, { overrides: { bulkOperationSagas: { schemaVersion: 1, sagas: {} } } });
  const archive = buildBundle(root, dashboard);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'rules.json'), '[]\n', { mode: 0o600 });

  const relocated = spawnSync('bash', [restoreShell, archive], {
    env: {
      ...restoreDrillContext(root, destination, archive).env,
      CONFIRM: '1',
      FINANCE_DASHBOARD_DIR: destination,
      DARKFINANCES_REPO_ROOT: path.join(root, 'missing-repo'),
      NODE_PATH: '',
    },
    encoding: 'utf8',
  });
  assert.equal(relocated.status, 0, relocated.stderr || relocated.stdout);
  assert.equal(fs.existsSync(path.join(destination, 'account-overrides.json')), true);
});

test('restore drill shell wrapper dry-run exits 2 without writes', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-shell-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeProductionDashboard(dashboard, { overrides: { bulkOperationSagas: { schemaVersion: 1, sagas: {} } } });
  const archive = buildBundle(root, dashboard);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'rules.json'), '[]\n', { mode: 0o600 });
  const before = destinationSnapshot(destination);

  const dryRun = spawnSync('bash', [restoreShell, archive], {
    env: {
      ...restoreDrillContext(root, destination, archive).env,
      FINANCE_DASHBOARD_DIR: destination,
    },
    encoding: 'utf8',
  });
  assert.equal(dryRun.status, 2);
  assert.match(dryRun.stderr, /restore dry-run: ok/);
  assert.deepEqual(destinationSnapshot(destination), before);
});

test('generation binding helpers detect equivalence', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-binding-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard, { overrides: { bulkOperationSagas: { schemaVersion: 1, sagas: {} } } });
  const archive = buildBundle(root, dashboard);
  const manifest = manifestFromArchive(archive);
  const left = buildGenerationBinding(manifest);
  const right = buildGenerationBinding(manifest);
  assert.equal(bindingsEquivalent(left, right), true);
});

test('terminal-only journal and sagas restore without per-record binding', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-terminal-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeTerminalSagaDashboard(dashboard, {
    overrides: {
      bulkOperationSagas: {
      schemaVersion: 1,
      sagas: {
        b1: {
          id: 'b1',
          recordVersion: 1,
          kind: 'rules_apply',
          phase: 'completed',
          status: 'completed',
          updatedAt: '2026-07-13T00:00:00.000Z',
          terminalAt: '2026-07-13T00:00:00.000Z',
        },
      },
    },
    operationJournal: PRODUCTION_SHAPED.operationJournal,
    },
  });
  const archive = buildBundle(root, dashboard);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'rules.json'), '[]\n', { mode: 0o600 });
  const result = stagedRestore(root, destination, archive, {dryRun: false, confirm: true,
  });
  assert.equal(result.phase, PHASE.COMPLETE);
});

test('completed restore journal short-circuits repeat apply', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-idempotent-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeProductionDashboard(dashboard, { overrides: { bulkOperationSagas: { schemaVersion: 1, sagas: {} } } });
  const archive = buildBundle(root, dashboard);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'rules.json'), '[]\n', { mode: 0o600 });
  stagedRestore(root, destination, archive, {dryRun: false, confirm: true,
  });
  const journal = controlJournal(destination);
  assert.equal(journal.phase, PHASE.COMPLETE);
  const again = stagedRestore(root, destination, archive, {dryRun: false, confirm: true,
  });
  assert.equal(again.resumed, true);
});

test('archive substitution after COMPLETE is rejected on replay', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-substitute-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeTerminalSagaDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'rules.json'), '[]\n', { mode: 0o600 });
  stagedRestore(root, destination, archive, {dryRun: false, confirm: true,
  });
  const bytes = fs.readFileSync(archive);
  bytes[bytes.length - 20] ^= 0xff;
  fs.writeFileSync(archive, bytes);
  assert.throws(
    () => stagedRestore(root, destination, archive, {dryRun: false, confirm: true,
  }),
    /archive substitution|archive checksum mismatch/i,
  );
});

test('legacy v1 completed replacement saga is not mutated with generation binding', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-v1-terminal-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeTerminalSagaDashboard(dashboard, {
    overrides: {
      transactionSagas: {
        schemaVersion: 1,
        sagas: {
          t1: {
            id: 't1',
            recordVersion: 1,
            phase: 'completed',
            status: 'completed',
            updatedAt: '2026-07-13T00:00:00.000Z',
            terminalAt: '2026-07-13T00:00:00.000Z',
            original: { id: 'txn-1' },
          },
        },
      },
    },
  });
  const archive = buildBundle(root, dashboard);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'rules.json'), '[]\n', { mode: 0o600 });
  stagedRestore(root, destination, archive, {dryRun: false, confirm: true,
  });
  const sagas = JSON.parse(fs.readFileSync(path.join(destination, 'transaction-sagas.json'), 'utf8'));
  assert.equal(sagas.sagas.t1[BINDING_FIELD], undefined);
});

test('rejects symlink destination root', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-symlink-');
  const dashboard = path.join(root, 'dashboard');
  const realDestination = path.join(root, 'real-destination');
  const linkDestination = path.join(root, 'link-destination');
  fs.mkdirSync(realDestination, { recursive: true, mode: 0o700 });
  fs.symlinkSync(realDestination, linkDestination);
  writeTerminalSagaDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  assert.throws(
    () => stagedRestore(root, linkDestination, archive, {dryRun: true,
    }),
    /symbolic link/,
  );
});

test('expired admission token is rejected', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-expired-token-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeTerminalSagaDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  const coordinatorRoot = path.join(root, 'backups');
  const layout = coordinatedLayoutForRoot(coordinatorRoot);
  fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(layout.workRoot, { recursive: true, mode: 0o700 });
  const keys = installTestCoordinatorKeys(root);
  const { token } = buildTestAdmissionToken({
    keyPair: keys.pair,
    ttlMs: -1000,
    bindings: {
      archiveSha256: sha256File(archive),
      destinationRoot: path.resolve(destination),
    },
  });
  registerTestAdmission(layout, token);
  const tokenPath = path.join(layout.workRoot, 'expired.json');
  fs.writeFileSync(tokenPath, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  const fakeBin = installFakeSystemctl(root);
  assert.throws(
    () => stagedRestore(root, destination, archive, {dryRun: true,
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
        RESTORE_QUIESCENCE_ADMISSION_PATH: tokenPath,
        COORDINATED_VERIFY_KEY_PATH: keys.publicPath,
        DARKFINANCES_BACKUP_DIR: coordinatorRoot,
      },
    }),
    /expired|expiresAt must be after issuedAt/,
  );
});

test('wrong admission archive binding is rejected before mutation', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-wrong-token-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeTerminalSagaDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  const coordinatorRoot = path.join(root, 'backups');
  const layout = coordinatedLayoutForRoot(coordinatorRoot);
  fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(layout.workRoot, { recursive: true, mode: 0o700 });
  const keys = installTestCoordinatorKeys(root);
  const { token } = buildTestAdmissionToken({
    keyPair: keys.pair,
    bindings: {
      archiveSha256: 'f'.repeat(64),
      destinationRoot: path.resolve(destination),
    },
  });
  registerTestAdmission(layout, token);
  const tokenPath = path.join(layout.workRoot, 'wrong-archive.json');
  fs.writeFileSync(tokenPath, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const { createMockRunners } = require('./fixtures/coordinated-backup-fixtures');
  const { quiescedUnits } = require('./fixtures/coordinated-test-helpers');
  const fakeBin = installFakeSystemctl(root, quiescedUnits());
  const runners = createMockRunners({ units: quiescedUnits() });
  assert.throws(
    () => runStagedRestore({
      archivePath: archive,
      destinationRoot: destination,
      dryRun: false,
      confirm: true,
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
        RESTORE_QUIESCENCE_ADMISSION_PATH: tokenPath,
        COORDINATED_VERIFY_KEY_PATH: keys.publicPath,
        DARKFINANCES_BACKUP_DIR: coordinatorRoot,
      },
      runners,
    }),
    /archive binding mismatch/,
  );
});

test('rollback failure leaves recoverable journal and next invocation converges', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-rollback-fail-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeTerminalSagaDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'rules.json'), '[]\n', { mode: 0o600 });
  const faultCtx = restoreDrillContext(root, destination, archive, {
    RESTORE_FAULT_SCHEDULE: JSON.stringify([
      { point: 'after:swap-file', detail: 'rules.json', throwError: 'swap interrupt' },
      { point: 'after:rollback-restore', detail: 'rules.json', throwError: 'rollback interrupt' },
    ]),
  });
  assert.throws(
    () => runStagedRestore({
      archivePath: archive,
      destinationRoot: destination,
      dryRun: false,
      confirm: true,
      env: faultCtx.env,
      runners: faultCtx.runners,
    }),
    /rollback interrupt/,
  );
  const failedJournal = controlJournal(destination);
  assert.equal(failedJournal.phase, PHASE.ROLLBACK_FAILED);
  assert.ok(failedJournal.completedSwaps.length > 0);

  const resumed = stagedRestore(root, destination, archive, { dryRun: false, confirm: true });
  assert.equal(resumed.phase, PHASE.COMPLETE);
});

test('COMPLETE cleanup retains journal only and removes work and snapshot trees', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-cleanup-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeTerminalSagaDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'rules.json'), '[]\n', { mode: 0o600 });
  stagedRestore(root, destination, archive, {dryRun: false, confirm: true,
  });
  const layout = controlLayoutForDestination(destination);
  assert.equal(fs.existsSync(layout.journalPath), true);
  assert.equal(fs.existsSync(layout.workRoot), false);
  assert.equal(fs.existsSync(layout.snapshotRoot), false);
});

test('rejects symlink restore journal path', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-journal-symlink-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeTerminalSagaDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'rules.json'), '[]\n', { mode: 0o600 });
  const layout = controlLayoutForDestination(destination);
  fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, 'journal-outside.json'), '{}\n', { mode: 0o600 });
  fs.symlinkSync(path.join(root, 'journal-outside.json'), layout.journalPath);
  assert.throws(
    () => stagedRestore(root, destination, archive, {dryRun: false, confirm: true,
  }),
    /symbolic link/,
  );
});

test('pre-swap generation evidence change is rejected', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-toctou-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeTerminalSagaDashboard(dashboard);
  const releaseDigest = 'a'.repeat(64);
  const archive = buildBundle(root, dashboard, { releaseManifestDigest: releaseDigest });
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'rules.json'), '[]\n', { mode: 0o600 });
  const releasePath = path.join(root, 'release-manifest.json');
  fs.writeFileSync(releasePath, `${JSON.stringify({ schemaVersion: 1, digest: releaseDigest }, null, 2)}\n`, { mode: 0o600 });
  assert.throws(
    () => stagedRestore(root, destination, archive, {
      dryRun: false,
      confirm: true,
      releaseManifestPath: releasePath,
      injectFault: (point) => {
        if (point === 'after:binding-validate') {
          fs.writeFileSync(releasePath, `${JSON.stringify({ schemaVersion: 1, digest: 'b'.repeat(64) }, null, 2)}\n`, { mode: 0o600 });
        }
      },
    }, {
      RESTORE_FAULT_SCHEDULE: JSON.stringify([{ point: 'after:binding-validate' }]),
    }),
    /destination release generation does not match bundle binding/,
  );
});

test('shell wrapper resumes interrupted restore without explicit workRoot', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-shell-resume-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeTerminalSagaDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'rules.json'), '[]\n', { mode: 0o600 });
  const faultEnv = {
    ...restoreDrillContext(root, destination, archive).env,
    FINANCE_DASHBOARD_DIR: destination,
    RESTORE_FAULT_SCHEDULE: JSON.stringify([{ point: 'after:snapshot-capture', throwError: 'shell interrupt' }]),
  };
  const first = spawnSync(restoreShell, [archive], { encoding: 'utf8', env: faultEnv });
  assert.notEqual(first.status, 0, first.stderr);
  const resumeEnv = {
    ...restoreDrillContext(root, destination, archive).env,
    FINANCE_DASHBOARD_DIR: destination,
    CONFIRM: '1',
  };
  const second = spawnSync(restoreShell, [archive], { encoding: 'utf8', env: resumeEnv });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(controlJournal(destination)?.phase, PHASE.COMPLETE);
});

function completeRestore(root, destination, archive) {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'rules.json'), '[]\n', { mode: 0o600 });
  stagedRestore(root, destination, archive, {dryRun: false, confirm: true,
  });
}

test('COMPLETE live replay detects deleted runtime content', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-drift-delete-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeTerminalSagaDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  completeRestore(root, destination, archive);
  fs.rmSync(path.join(destination, 'rules.json'), { force: true });
  assert.throws(
    () => stagedRestore(root, destination, archive, {dryRun: false, confirm: true,
  }),
    /completed restore destination drift detected/,
  );
});

test('COMPLETE live replay detects mode tamper and unknown runtime files', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-drift-mode-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeTerminalSagaDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  completeRestore(root, destination, archive);
  fs.chmodSync(path.join(destination, 'rules.json'), 0o644);
  assert.throws(
    () => stagedRestore(root, destination, archive, {dryRun: false, confirm: true,
  }),
    /completed restore destination drift detected/,
  );
  fs.chmodSync(path.join(destination, 'rules.json'), 0o600);
  fs.writeFileSync(path.join(destination, 'drift-extra.txt'), 'x\n', { mode: 0o600 });
  assert.throws(
    () => stagedRestore(root, destination, archive, {dryRun: true,
    }),
    /completed restore destination drift detected/,
  );
});

test('COMPLETE replay detects generation evidence drift', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-drift-evidence-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeTerminalSagaDashboard(dashboard);
  const releaseDigest = 'a'.repeat(64);
  const archive = buildBundle(root, dashboard, { releaseManifestDigest: releaseDigest });
  completeRestore(root, destination, archive);
  const releasePath = path.join(root, 'release-manifest.json');
  fs.writeFileSync(releasePath, `${JSON.stringify({ schemaVersion: 1, digest: 'b'.repeat(64) }, null, 2)}\n`, { mode: 0o600 });
  assert.throws(
    () => stagedRestore(root, destination, archive, {dryRun: false,
      confirm: true,
      releaseManifestPath: releasePath,
          }),
    /completed restore destination drift detected/,
  );
});

test('dry-run against COMPLETE journal reports destination drift without false confidence', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-dry-drift-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeTerminalSagaDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  completeRestore(root, destination, archive);
  fs.writeFileSync(path.join(destination, 'rules.json'), '{"rules":[{"id":"tampered"}]}\n', { mode: 0o600 });
  assert.throws(
    () => stagedRestore(root, destination, archive, {dryRun: true,
    }),
    /completed restore destination drift detected/,
  );
});

test('oversized restore journal is rejected with controlled error', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-journal-size-');
  const destination = path.join(root, 'destination');
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const layout = controlLayoutForDestination(destination);
  fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(layout.journalPath, `${'x'.repeat(JOURNAL_MAX_BYTES + 1)}`, { mode: 0o600 });
  assert.throws(
    () => readJournal(layout.journalPath),
    /restore journal exceeds size limit/,
  );
});

function isolatedToolPath(root, toolNames) {
  const bin = path.join(root, 'isolated-bin');
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  for (const name of toolNames) {
    const resolved = findExecutableInPath(name, process.env);
    if (!resolved) throw new Error(`${name} not found for test setup`);
    fs.symlinkSync(resolved, path.join(bin, name));
  }
  return bin;
}

test('shell live restore releases lock when writer discovery fails on PATH', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-lock-writer-fail-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeTerminalSagaDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'rules.json'), '[]\n', { mode: 0o600 });
  const ctx = restoreDrillContext(root, destination, archive);
  const layout = controlLayoutForDestination(destination);
  const tarOnlyPath = isolatedToolPath(root, ['tar']);
  assert.throws(
    () => runStagedRestore({
      archivePath: archive,
      destinationRoot: destination,
      dryRun: false,
      confirm: true,
      env: {
        ...ctx.env,
        PATH: tarOnlyPath,
      },
    }),
    /live-quiescent|systemctl unavailable|unknown state/i,
  );
  assert.equal(fs.existsSync(lockPathForLayout(layout)), false);
});

test('concurrent live restore rejects second invocation while first holds lock', async (t) => {
  const root = mkRoot(t, 'darkfinances-restore-concurrent-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeTerminalSagaDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'rules.json'), '[]\n', { mode: 0o600 });
  const ready = path.join(root, 'child-ready');
  const release = path.join(root, 'release-child');
  const baseEnv = restoreDrillContext(root, destination, archive).env;
  const childEnv = {
    ...baseEnv,
    FINANCE_DASHBOARD_DIR: destination,
    RESTORE_FAULT_SCHEDULE: JSON.stringify([{
      point: 'after:preflight',
      createReadyFile: ready,
      holdUntilFile: release,
      holdTimeoutMs: 120000,
    }]),
  };
  const child = spawn(process.execPath, [
    path.join(repoRoot, 'ops/lib/staged-restore-cli.js'),
    '--confirm',
    archive,
  ], { env: childEnv, stdio: 'ignore' });
  t.after(() => {
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* ignore */ }
  });
  const layout = controlLayoutForDestination(destination);
  const readyDeadline = Date.now() + 120000;
  while (!fs.existsSync(ready) && Date.now() < readyDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(fs.existsSync(ready), 'first restore should reach preflight hold');
  assert.ok(fs.existsSync(lockPathForLayout(layout)), 'first restore should hold live lock');
  const blocked = spawnSync(process.execPath, [
    path.join(repoRoot, 'ops/lib/staged-restore-cli.js'),
    '--confirm',
    archive,
  ], {
    encoding: 'utf8',
    env: {
      ...baseEnv,
      FINANCE_DASHBOARD_DIR: destination,
    },
  });
  assert.match(blocked.stderr, /restore already in progress/);
  fs.writeFileSync(release, 'go\n', { mode: 0o600 });
  const [exitCode] = await once(child, 'exit');
  assert.equal(exitCode, 0, blocked.stderr);
});

test('stale dead restore lock is removed and restore proceeds', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-dead-lock-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeTerminalSagaDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'rules.json'), '[]\n', { mode: 0o600 });
  const layout = controlLayoutForDestination(destination);
  fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(layout.controlRoot + '/restore.lock', `${JSON.stringify({
    kind: LOCK_KIND,
    schemaVersion: LOCK_SCHEMA_VERSION,
    pid: 99999999,
    destinationRoot: layout.canonicalDestination,
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  const result = stagedRestore(root, destination, archive, {dryRun: false, confirm: true,
  });
  assert.equal(result.phase, PHASE.COMPLETE);
  assert.equal(fs.existsSync(lockPathForLayout(layout)), false);
});

test('malformed and symlink restore locks fail safe', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-bad-lock-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeTerminalSagaDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'rules.json'), '[]\n', { mode: 0o600 });
  const layout = controlLayoutForDestination(destination);
  fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(layout.controlRoot + '/restore.lock', 'not-json', { mode: 0o600 });
  assert.throws(
    () => stagedRestore(root, destination, archive, {dryRun: false, confirm: true,
  }),
    /restore lock unavailable/,
  );
  fs.rmSync(layout.controlRoot + '/restore.lock', { force: true });
  fs.writeFileSync(path.join(root, 'outside-lock'), '{}\n', { mode: 0o600 });
  fs.symlinkSync(path.join(root, 'outside-lock'), layout.controlRoot + '/restore.lock');
  assert.throws(
    () => stagedRestore(root, destination, archive, {dryRun: false, confirm: true,
  }),
    /symbolic link/,
  );
});
