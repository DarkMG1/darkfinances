'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildBackupBundle } = require('../lib/build-backup-bundle');
const {
  BINDING_FIELD,
  buildGenerationBinding,
  bindingsEquivalent,
} = require('../lib/restore-generation-binding');
const { buildTestAdmissionToken } = require('../lib/restore-quiescence-admission');
const {
  runStagedRestore,
  PHASE,
  readJournal,
  journalPathForDestination,
} = require('../lib/staged-restore');
const { writeProductionDashboard, PRODUCTION_SHAPED } = require('./fixtures/backup-bundle-dashboard-fixtures');

const repoRoot = path.resolve(__dirname, '..', '..');
const restoreShell = path.join(repoRoot, 'ops/bin/restore-dashboard-runtime.sh');

function mkRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function admissionEnv(root, extra = {}) {
  const tokenPath = path.join(root, 'quiescence-admission.json');
  fs.writeFileSync(tokenPath, `${JSON.stringify(buildTestAdmissionToken(), null, 2)}\n`, { mode: 0o600 });
  return {
    ...process.env,
    RESTORE_QUIESCENCE_ADMISSION_PATH: tokenPath,
    ...extra,
  };
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
  runStagedRestore({
    archivePath: archive,
    destinationRoot: destination,
    dryRun: false,
    confirm: true,
    env: admissionEnv(root),
  });
  assert.equal(fs.existsSync(path.join(destination, 'receipts', 'stale-only.jpg')), false);
  assert.notEqual(fs.readFileSync(path.join(destination, 'rules.json'), 'utf8'), '[]\n');

  fs.writeFileSync(path.join(destination, 'unexpected.txt'), 'fail\n', { mode: 0o600 });
  assert.throws(
    () => runStagedRestore({
      archivePath: archive,
      destinationRoot: destination,
      dryRun: true,
      env: admissionEnv(root),
    }),
    /unknown runtime files/,
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
  const result = runStagedRestore({
    archivePath: archive,
    destinationRoot: destination,
    dryRun: true,
    env: admissionEnv(root),
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.phase, PHASE.COMPLETE);
  assert.deepEqual(destinationSnapshot(destination), before);
  assert.equal(fs.existsSync(path.join(destination, '.restore-journal.json')), false);
});

test('refuses restore without quiescence admission token', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-quiesce-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeProductionDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  assert.throws(
    () => runStagedRestore({
      archivePath: archive,
      destinationRoot: destination,
      dryRun: true,
      env: { ...process.env, RESTORE_QUIESCENCE_ADMISSION_PATH: '' },
    }),
    /missing quiescence admission token/,
  );
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
    () => runStagedRestore({
      archivePath: tampered,
      destinationRoot: destination,
      dryRun: true,
      env: admissionEnv(root),
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
    () => runStagedRestore({
      archivePath: archive,
      destinationRoot: destination,
      dryRun: true,
      env: admissionEnv(root),
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

  const result = runStagedRestore({
    archivePath: archive,
    destinationRoot: destination,
    dryRun: false,
    confirm: true,
    env: admissionEnv(root),
  });
  assert.equal(result.phase, PHASE.COMPLETE);
  assert.equal(fs.existsSync(path.join(destination, 'bulk-operation-sagas.json')), true);
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
    () => runStagedRestore({
      archivePath: archive,
      destinationRoot: destination,
      dryRun: true,
      env: admissionEnv(root),
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

test('interruption after staging can resume idempotently', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-resume-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeTerminalSagaDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'rules.json'), '[]\n', { mode: 0o600 });

  const workRoot = path.join(root, 'work');
  assert.throws(
    () => runStagedRestore({
      archivePath: archive,
      destinationRoot: destination,
      dryRun: false,
      confirm: true,
      workRoot,
      env: admissionEnv(root, {
        RESTORE_FAULT_SCHEDULE: JSON.stringify([{ point: 'after:rollback-capture', throwError: 'interrupt' }]),
      }),
    }),
    /interrupt/,
  );

  const resumed = runStagedRestore({
    archivePath: archive,
    destinationRoot: destination,
    dryRun: false,
    confirm: true,
    workRoot,
    env: admissionEnv(root),
  });
  assert.equal(resumed.phase, PHASE.COMPLETE);
  assert.equal(resumed.resumed, true);
});

test('interruption during swap rolls back entire prior generation', (t) => {
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

  assert.throws(
    () => runStagedRestore({
      archivePath: archive,
      destinationRoot: destination,
      dryRun: false,
      confirm: true,
      workRoot: path.join(root, 'work'),
      env: admissionEnv(root, {
        RESTORE_FAULT_SCHEDULE: JSON.stringify([{ point: 'after:swap-file', detail: 'rules.json', throwError: 'swap interrupt' }]),
      }),
    }),
    /swap interrupt/,
  );

  assert.equal(fs.readFileSync(path.join(destination, 'rules.json'), 'utf8'), originalRules);
});

test('ENOSPC during preflight fails before swap', (t) => {
  const root = mkRoot(t, 'darkfinances-restore-enospc-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeProductionDashboard(dashboard, { overrides: { bulkOperationSagas: { schemaVersion: 1, sagas: {} } } });
  const archive = buildBundle(root, dashboard);
  assert.throws(
    () => runStagedRestore({
      archivePath: archive,
      destinationRoot: destination,
      dryRun: true,
      env: admissionEnv(root, { RESTORE_TEST_ENOSPC: '1' }),
    }),
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
    () => runStagedRestore({
      archivePath: archive,
      destinationRoot: destination,
      dryRun: false,
      confirm: true,
      workRoot: path.join(root, 'work'),
      env: admissionEnv(root, {
        RESTORE_FAULT_SCHEDULE: JSON.stringify([{ point: 'before:swap-file', detail: 'rules.json', code: 'EACCES' }]),
      }),
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
      ...admissionEnv(root),
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
      ...admissionEnv(root),
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
  });
  const archive = buildBundle(root, dashboard);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'rules.json'), '[]\n', { mode: 0o600 });
  const result = runStagedRestore({
    archivePath: archive,
    destinationRoot: destination,
    dryRun: false,
    confirm: true,
    env: admissionEnv(root),
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
  const workRoot = path.join(root, 'work');
  runStagedRestore({
    archivePath: archive,
    destinationRoot: destination,
    dryRun: false,
    confirm: true,
    workRoot,
    env: admissionEnv(root),
  });
  const journal = readJournal(journalPathForDestination(destination, workRoot));
  assert.equal(journal.phase, PHASE.COMPLETE);
  const again = runStagedRestore({
    archivePath: archive,
    destinationRoot: destination,
    dryRun: false,
    confirm: true,
    workRoot,
    env: admissionEnv(root),
  });
  assert.equal(again.resumed, true);
});
