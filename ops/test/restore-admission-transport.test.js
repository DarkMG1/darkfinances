'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  resolveAdmissionToken,
  requireQuiescenceAdmission,
  readAdmissionTokenFile,
  parseAdmissionToken,
  assertAdmissionBindings,
  isLiveRestoreAdmission,
  MAX_ADMISSION_TOKEN_BYTES,
} = require('../lib/restore-quiescence-admission');
const { readTrustedRegularFile } = require('../../finance-dashboard/lib/trusted-regular-file-read');
const { resolveRestoreAdmissionTransportPolicy } = require('../lib/restore-admission-transport');
const { coordinatedLayoutForRoot } = require('../lib/coordinated-operation-layout');
const { buildTestAdmissionToken, registerTestAdmission } = require('./fixtures/admission-token-fixtures');
const {
  installTestCoordinatorKeys,
  restoreDrillContext,
} = require('./fixtures/coordinated-test-helpers');
const { runStagedRestore } = require('../lib/staged-restore');
const { buildBackupBundle } = require('../lib/build-backup-bundle');
const { writeProductionDashboard } = require('./fixtures/backup-bundle-dashboard-fixtures');

const repoRoot = path.resolve(__dirname, '..', '..');
const restoreShell = path.join(repoRoot, 'ops/bin/restore-dashboard-runtime.sh');
const restoreCli = path.join(repoRoot, 'ops/lib/staged-restore-cli.js');

function mkRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function prepareLayout(root) {
  const layout = coordinatedLayoutForRoot(path.join(root, 'backups'));
  fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(layout.workRoot, { recursive: true, mode: 0o700 });
  return layout;
}

function signedTokenEnv(root, layout, extraBindings = {}) {
  const keys = installTestCoordinatorKeys(root);
  const { token } = buildTestAdmissionToken({
    keyPair: keys.pair,
    bindings: extraBindings,
  });
  registerTestAdmission(layout, token);
  return { keys, token };
}

test('production live restore signal is dryRun === false with explicit boolean mode', () => {
  assert.equal(isLiveRestoreAdmission({ dryRun: false, confirm: true }), true);
  assert.equal(isLiveRestoreAdmission({ dryRun: true }), false);
  assert.equal(isLiveRestoreAdmission({ dryRun: true, confirm: true }), false);
  assert.throws(
    () => isLiveRestoreAdmission({}),
    /explicit boolean dryRun mode is required/,
  );
  assert.throws(
    () => isLiveRestoreAdmission({ dryRun: 'false' }),
    /explicit boolean dryRun mode is required/,
  );
  assert.equal(
    resolveRestoreAdmissionTransportPolicy({ dryRun: false }).requireTrustedFile,
    true,
  );
  assert.throws(
    () => resolveRestoreAdmissionTransportPolicy({}),
    /explicit boolean dryRun mode is required/,
  );
});

test('admission token schema requires explicit actual data generation binding', () => {
  const { token, keyPair } = buildTestAdmissionToken();
  assert.doesNotThrow(() => parseAdmissionToken(
    JSON.stringify(token),
    'test admission',
    { publicKey: keyPair.publicKey },
  ));

  const missing = structuredClone(token);
  delete missing.bindings.actualDataGeneration;
  assert.throws(
    () => parseAdmissionToken(JSON.stringify(missing), 'test admission', { publicKey: keyPair.publicKey }),
    /actualDataGeneration is required/,
  );

  const malformed = structuredClone(token);
  malformed.bindings.actualDataGeneration = 123;
  assert.throws(
    () => parseAdmissionToken(JSON.stringify(malformed), 'test admission', { publicKey: keyPair.publicKey }),
    /must be a non-empty string or null/,
  );
});

test('admission binding comparison rejects non-null token generation against explicit null context', () => {
  const { token } = buildTestAdmissionToken({
    bindings: { actualDataGeneration: 'actual-generation-1' },
  });
  assert.throws(
    () => assertAdmissionBindings(token, {
      archiveSha256: token.bindings.archiveSha256,
      destinationRoot: token.bindings.destinationRoot,
      actualDataGeneration: null,
    }),
    /actual generation binding mismatch/,
  );
});

test('production live restore rejects inline admission transport', (t) => {
  const root = mkRoot(t, 'df-admission-inline-live-');
  const layout = prepareLayout(root);
  const { keys, token } = signedTokenEnv(root, layout);
  const secret = 'super-secret-inline-admission-token-body-abc123';
  assert.throws(
    () => resolveAdmissionToken({
      dryRun: false,
      env: {
        RESTORE_QUIESCENCE_ADMISSION_TOKEN: JSON.stringify({ ...token, signature: secret }),
        COORDINATED_VERIFY_KEY_PATH: keys.publicPath,
        DARKFINANCES_BACKUP_DIR: path.join(root, 'backups'),
      },
      layout,
      allowInlineAdmissionToken: true,
    }),
    /inline quiescence admission transport is not permitted/,
  );
});

test('production preview rejects inline admission without dev opt-in', (t) => {
  const root = mkRoot(t, 'df-admission-inline-preview-');
  const layout = prepareLayout(root);
  const { keys, token } = signedTokenEnv(root, layout);
  assert.throws(
    () => resolveAdmissionToken({
      dryRun: true,
      env: {
        RESTORE_QUIESCENCE_ADMISSION_TOKEN: JSON.stringify(token),
        COORDINATED_VERIFY_KEY_PATH: keys.publicPath,
        DARKFINANCES_BACKUP_DIR: path.join(root, 'backups'),
      },
      layout,
    }),
    /trusted admission file path required/,
  );
});

test('dev inline admission requires explicit allowInlineAdmissionToken opt-in', (t) => {
  const root = mkRoot(t, 'df-admission-inline-dev-');
  const layout = prepareLayout(root);
  const { keys, token } = signedTokenEnv(root, layout);
  const parsed = resolveAdmissionToken({
    dryRun: true,
    allowInlineAdmissionToken: true,
    env: {
      RESTORE_QUIESCENCE_ADMISSION_TOKEN: JSON.stringify(token),
      COORDINATED_VERIFY_KEY_PATH: keys.publicPath,
      DARKFINANCES_BACKUP_DIR: path.join(root, 'backups'),
    },
    layout,
  });
  assert.equal(parsed.nonce, token.nonce);
});

test('trusted admission path cannot authorize standalone live restore', (t) => {
  const root = mkRoot(t, 'df-admission-path-live-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeProductionDashboard(dashboard, {
    overrides: { bulkOperationSagas: { schemaVersion: 1, sagas: {} } },
  });
  const archive = path.join(root, 'bundle.tgz');
  buildBackupBundle({ dashboardDir: dashboard, archivePath: archive });
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'rules.json'), '[]\n', { mode: 0o600 });
  const ctx = restoreDrillContext(root, destination, archive);
  assert.throws(
    () => runStagedRestore({
      archivePath: archive,
      destinationRoot: destination,
      confirm: true,
      dryRun: false,
      env: ctx.env,
      coordinatorRoot: ctx.coordinatorRoot,
      layout: ctx.layout,
      runners: ctx.runners,
    }),
    /standalone live restore is refused/,
  );
  assert.equal(fs.readFileSync(path.join(destination, 'rules.json'), 'utf8'), '[]\n');
  assert.equal(fs.existsSync(path.join(destination, '.darkfinances-restore')), false);
});

test('coordinated live restore requires the current process to hold the operation gate', (t) => {
  const root = mkRoot(t, 'df-admission-no-held-gate-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeProductionDashboard(dashboard, {
    overrides: { bulkOperationSagas: { schemaVersion: 1, sagas: {} } },
  });
  const archive = path.join(root, 'bundle.tgz');
  buildBackupBundle({ dashboardDir: dashboard, archivePath: archive });
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'rules.json'), '[]\n', { mode: 0o600 });
  const ctx = restoreDrillContext(root, destination, archive);
  const env = { ...ctx.env };
  delete env.COORDINATED_TEST_SKIP_LOCK;
  assert.throws(
    () => runStagedRestore({
      archivePath: archive,
      destinationRoot: destination,
      confirm: true,
      dryRun: false,
      env,
      runners: ctx.runners,
      coordinatedSession: ctx.coordinatedSession,
    }),
    /held coordinated operation gate/,
  );
  assert.equal(fs.readFileSync(path.join(destination, 'rules.json'), 'utf8'), '[]\n');
  assert.equal(fs.existsSync(path.join(destination, '.darkfinances-restore')), false);
});

test('admission token path rejects wrong mode', (t) => {
  const root = mkRoot(t, 'df-admission-mode-');
  const layout = prepareLayout(root);
  const { token } = signedTokenEnv(root, layout);
  const tokenPath = path.join(layout.workRoot, 'bad-mode.json');
  fs.writeFileSync(tokenPath, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o644 });
  assert.throws(
    () => readAdmissionTokenFile(tokenPath, { layout }),
    /mode must be 0600/,
  );
});

test('admission token path rejects symlink', (t) => {
  const root = mkRoot(t, 'df-admission-symlink-');
  const layout = prepareLayout(root);
  const { token } = signedTokenEnv(root, layout);
  const real = path.join(root, 'real-token.json');
  fs.writeFileSync(real, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  const link = path.join(layout.workRoot, 'linked-token.json');
  fs.symlinkSync(real, link);
  assert.throws(
    () => readAdmissionTokenFile(link, { layout }),
    /symbolic link/,
  );
});

test('admission token path rejects hard link', (t) => {
  if (process.platform === 'win32') {
    t.skip('hard-link nlink checks are unix-specific');
    return;
  }
  const root = mkRoot(t, 'df-admission-hardlink-');
  const layout = prepareLayout(root);
  const { token } = signedTokenEnv(root, layout);
  const primary = path.join(layout.workRoot, 'primary-token.json');
  fs.writeFileSync(primary, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  const hardLink = path.join(layout.workRoot, 'hardlinked-token.json');
  fs.linkSync(primary, hardLink);
  assert.throws(
    () => readAdmissionTokenFile(hardLink, { layout }),
    /hard-linked/,
  );
});

test('admission token path rejects path outside trusted coordinator roots', (t) => {
  const root = mkRoot(t, 'df-admission-outside-');
  const layout = prepareLayout(root);
  const { token } = signedTokenEnv(root, layout);
  const outside = path.join(root, 'outside-token.json');
  fs.writeFileSync(outside, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  assert.throws(
    () => readAdmissionTokenFile(outside, { layout }),
    /outside trusted coordinator roots/,
  );
});

test('admission token path rejects ownership mismatch', (t) => {
  if (process.platform === 'win32' || typeof process.getuid !== 'function' || process.geteuid?.() !== 0) {
    t.skip('ownership mismatch requires root to chown away from current uid');
    return;
  }
  const root = mkRoot(t, 'df-admission-owner-');
  const layout = prepareLayout(root);
  const { token } = signedTokenEnv(root, layout);
  const tokenPath = path.join(layout.workRoot, 'wrong-owner.json');
  fs.writeFileSync(tokenPath, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  fs.chownSync(tokenPath, process.getuid() === 0 ? 65534 : 0, fs.statSync(tokenPath).gid);
  assert.throws(
    () => readAdmissionTokenFile(tokenPath, { layout }),
    /ownership mismatch/,
  );
});

test('admission token path rejects oversized token', (t) => {
  const root = mkRoot(t, 'df-admission-oversize-');
  const layout = prepareLayout(root);
  const tokenPath = path.join(layout.workRoot, 'oversized-token.json');
  fs.writeFileSync(tokenPath, Buffer.alloc(MAX_ADMISSION_TOKEN_BYTES + 1, 0x61), { mode: 0o600 });
  assert.throws(
    () => readAdmissionTokenFile(tokenPath, { layout }),
    /size is out of bounds/,
  );
});

test('admission token path accepts valid signed token from trusted root', (t) => {
  const root = mkRoot(t, 'df-admission-valid-');
  const layout = prepareLayout(root);
  const { keys, token } = signedTokenEnv(root, layout);
  const tokenPath = path.join(layout.workRoot, 'valid-token.json');
  fs.writeFileSync(tokenPath, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  const parsed = readAdmissionTokenFile(tokenPath, {
    layout,
    env: { COORDINATED_VERIFY_KEY_PATH: keys.publicPath },
  });
  assert.equal(parsed.nonce, token.nonce);
  assert.equal(parsed.signature, token.signature);
});

test('admission token read rejects path swap before open and during read', (t) => {
  const root = mkRoot(t, 'df-admission-toctou-');
  const layout = prepareLayout(root);
  const { token } = signedTokenEnv(root, layout);
  const tokenPath = path.join(layout.workRoot, 'toctou-token.json');
  fs.writeFileSync(tokenPath, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  assert.throws(
    () => readTrustedRegularFile(tokenPath, {
      label: 'quiescence admission token',
      maxBytes: MAX_ADMISSION_TOKEN_BYTES,
      allowedModes: [0o600],
    }, {
      fstatSync(descriptor) {
        const opened = fs.fstatSync(descriptor);
        return Object.assign(opened, { ino: opened.ino + 1 });
      },
    }),
    /changed before it could be read/,
  );
  assert.throws(
    () => readTrustedRegularFile(tokenPath, {
      label: 'quiescence admission token',
      maxBytes: MAX_ADMISSION_TOKEN_BYTES,
      allowedModes: [0o600],
    }, {
      readSync(descriptor, buffer, offset, length, position) {
        if (offset === 0) return 1;
        return 0;
      },
    }),
    /changed while it was being read/,
  );
  let pathStats = 0;
  assert.throws(
    () => readTrustedRegularFile(tokenPath, {
      label: 'quiescence admission token',
      maxBytes: MAX_ADMISSION_TOKEN_BYTES,
      allowedModes: [0o600],
    }, {
      lstatSync(target) {
        const stat = fs.lstatSync(target);
        if (target === tokenPath) {
          pathStats += 1;
          if (pathStats >= 2) {
            return Object.assign(stat, { ino: stat.ino + 1 });
          }
        }
        return stat;
      },
    }),
    /path changed while it was being read/,
  );
});

test('inline admission errors do not echo token signature or body', (t) => {
  const root = mkRoot(t, 'df-admission-redact-');
  const layout = prepareLayout(root);
  const { keys, token } = signedTokenEnv(root, layout);
  const leakMarker = 'leak-marker-signature-deadbeefcafe';
  let message = '';
  try {
    resolveAdmissionToken({
      dryRun: false,
      env: {
        RESTORE_QUIESCENCE_ADMISSION_TOKEN: JSON.stringify({ ...token, signature: leakMarker }),
        COORDINATED_VERIFY_KEY_PATH: keys.publicPath,
        DARKFINANCES_BACKUP_DIR: path.join(root, 'backups'),
      },
      layout,
    });
  } catch (error) {
    message = error.message;
  }
  assert.match(message, /inline quiescence admission transport is not permitted/);
  assert.equal(message.includes(leakMarker), false);
  assert.equal(message.includes(token.signature), false);
});

test('live restore without trusted file path fails closed', (t) => {
  const root = mkRoot(t, 'df-admission-no-path-');
  const layout = prepareLayout(root);
  const { keys, token } = signedTokenEnv(root, layout);
  assert.throws(
    () => requireQuiescenceAdmission({
      dryRun: false,
      env: {
        COORDINATED_VERIFY_KEY_PATH: keys.publicPath,
        DARKFINANCES_BACKUP_DIR: path.join(root, 'backups'),
      },
      layout,
      admissionToken: token,
      allowInlineAdmissionToken: true,
    }),
    /trusted admission file path required/,
  );
});

test('production shell contract documents path-only admission transport', () => {
  const shell = fs.readFileSync(restoreShell, 'utf8');
  const cli = fs.readFileSync(restoreCli, 'utf8');
  assert.match(shell, /RESTORE_QUIESCENCE_ADMISSION_PATH/);
  assert.doesNotMatch(shell, /RESTORE_QUIESCENCE_ADMISSION_TOKEN/);
  assert.match(cli, /RESTORE_QUIESCENCE_ADMISSION_PATH/);
  assert.doesNotMatch(cli, /RESTORE_QUIESCENCE_ADMISSION_TOKEN/);
});

test('staged restore CLI rejects CONFIRM=1 with explicit --dry-run', (t) => {
  const root = mkRoot(t, 'df-admission-cli-conflict-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeProductionDashboard(dashboard, {
    overrides: { bulkOperationSagas: { schemaVersion: 1, sagas: {} } },
  });
  const archive = path.join(root, 'bundle.tgz');
  buildBackupBundle({ dashboardDir: dashboard, archivePath: archive });
  const result = spawnSync('node', [restoreCli, '--dry-run', archive], {
    env: { ...process.env, CONFIRM: '1', FINANCE_DASHBOARD_DIR: destination },
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /conflicting restore mode/);
});

test('restore-dashboard-runtime rejects standalone live mode without exposing inline admission', (t) => {
  const root = mkRoot(t, 'df-admission-shell-inline-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'destination');
  writeProductionDashboard(dashboard, {
    overrides: { bulkOperationSagas: { schemaVersion: 1, sagas: {} } },
  });
  const archive = path.join(root, 'bundle.tgz');
  buildBackupBundle({ dashboardDir: dashboard, archivePath: archive });
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'rules.json'), '[]\n', { mode: 0o600 });
  const ctx = restoreDrillContext(root, destination, archive);
  const leakMarker = 'shell-inline-leak-marker-0123456789abcdef';
  const result = spawnSync('bash', [restoreShell, archive], {
    env: {
      ...ctx.env,
      CONFIRM: '1',
      FINANCE_DASHBOARD_DIR: destination,
      RESTORE_QUIESCENCE_ADMISSION_PATH: '',
      RESTORE_QUIESCENCE_ADMISSION_TOKEN: JSON.stringify({ ...ctx.token, signature: leakMarker }),
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  const output = `${result.stderr}\n${result.stdout}`;
  assert.match(output, /standalone live restore is refused/);
  assert.equal(output.includes(leakMarker), false);
});
