const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  buildManifest,
  validateSidecar,
  validateReceiptReferences,
  verifyArchive,
  assertLegacyArchivePreflight,
  assertLegacyManifestMatchesArchive,
  sha256File,
  LEGACY_EMBEDDED_MANIFEST,
} = require('../lib/backup-verify');
const { ARCHIVE_MAX_DECLARED_BYTES } = require('../lib/backup-bundle-schema');
const { backupTarEnv, COPYFILE_DISABLE_VALUE } = require('../lib/backup-tar-env');

test('validateSidecar enforces owes-truth schema version', () => {
  assert.doesNotThrow(() => validateSidecar('owes-truth.json', JSON.stringify({
    schemaVersion: 1,
    bySlug: { alex: [] },
    manifest: { complete: true },
  })));
  assert.throws(
    () => validateSidecar('owes-truth.json', JSON.stringify({ schemaVersion: 3, bySlug: {}, manifest: {} })),
    /newer than supported/,
  );
  assert.doesNotThrow(() => validateSidecar('owes-truth.json', JSON.stringify({
    schemaVersion: 2,
    bySlug: {},
    manifest: { complete: true },
  })));
});

test('validateSidecar preserves undeclared owes-truth metadata through v0 migration', () => {
  const extraMeta = { auditTrail: { run: 7 }, tags: ['backup'] };
  const legacy = JSON.stringify({
    bySlug: { alex: [{ event: 'trip', amount: 12 }] },
    extraMeta,
  });
  assert.doesNotThrow(() => validateSidecar('owes-truth.json', legacy));
  const migrated = JSON.stringify({
    schemaVersion: 2,
    bySlug: { alex: [{ event: 'trip', amount: 12 }] },
    extraMeta,
  });
  assert.doesNotThrow(() => validateSidecar('owes-truth.json', migrated));
});

test('validateSidecar narrowly validates transaction deletion saga state', () => {
  assert.throws(
    () => validateSidecar(
      'transaction-deletion-sagas.json',
      JSON.stringify({ schemaVersion: 2, sagas: {} }),
    ),
    /newer than supported/,
  );
  assert.throws(
    () => validateSidecar(
      'transaction-deletion-sagas.json',
      JSON.stringify({ schemaVersion: 1, sagas: [] }),
    ),
    /sagas must be an object/,
  );
  assert.doesNotThrow(() => validateSidecar(
    'transaction-deletion-sagas.json',
    JSON.stringify({ schemaVersion: 1, sagas: {} }),
  ));
});

test('validateSidecar narrowly validates bulk operation saga state', () => {
  assert.throws(
    () => validateSidecar(
      'bulk-operation-sagas.json',
      JSON.stringify({ schemaVersion: 2, sagas: {} }),
    ),
    /newer than supported/,
  );
  assert.doesNotThrow(() => validateSidecar(
    'bulk-operation-sagas.json',
    JSON.stringify({ schemaVersion: 1, sagas: {} }),
  ));
});

test('validateSidecar narrowly validates splitwise mirror resolution state', () => {
  assert.throws(
    () => validateSidecar(
      'splitwise-mirror-resolutions.json',
      JSON.stringify({ schemaVersion: 2, resolutions: [] }),
    ),
    /newer than supported/,
  );
  assert.throws(
    () => validateSidecar(
      'splitwise-mirror-resolutions.json',
      JSON.stringify({ schemaVersion: 1 }),
    ),
    /resolutions must be an array/,
  );
  assert.doesNotThrow(() => validateSidecar(
    'splitwise-mirror-resolutions.json',
    JSON.stringify({ schemaVersion: 1, resolutions: [] }),
  ));
});

test('validateSidecar narrowly validates repayment confirmation saga state', () => {
  assert.throws(
    () => validateSidecar(
      'repayment-confirmation-sagas.json',
      JSON.stringify({ schemaVersion: 2, sagas: {} }),
    ),
    /newer than supported/,
  );
  assert.doesNotThrow(() => validateSidecar(
    'repayment-confirmation-sagas.json',
    JSON.stringify({ schemaVersion: 1, sagas: {} }),
  ));
});

test('validateReceiptReferences supports live and legacy metadata shapes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-receipts-'));
  fs.mkdirSync(path.join(root, 'receipts'));
  fs.writeFileSync(path.join(root, 'receipts', 'one.jpg'), 'image');
  assert.throws(
    () => validateReceiptReferences({
      byTxn: { txn: [{ id: 'missing', txnId: 'txn', file: 'missing.jpg' }] },
    }, root),
    /missing receipt file/
  );
  assert.doesNotThrow(() => validateReceiptReferences({
    schemaVersion: 1,
    unknown: { keep: true },
    byTxn: { txn: [{ id: 'r1', txnId: 'txn', file: 'one.jpg' }] },
  }, root));
  assert.doesNotThrow(() => validateReceiptReferences([{ path: 'receipts/one.jpg' }], root));
  assert.throws(
    () => validateReceiptReferences({
      byTxn: { txn: [{ id: 'unsafe', txnId: 'txn', file: '../one.jpg' }] },
    }, root),
    /unsafe receipt path/
  );
});

test('validateSidecar accepts live deletion-reference store shapes', () => {
  for (const [file, payload] of [
    ['receipts.json', { schemaVersion: 1, byTxn: { txn: [] }, unknown: true }],
    ['reimb-links.json', { schemaVersion: 1, links: [], unknown: true }],
    ['reimb-suggest.json', { schemaVersion: 1, confirmed: {}, dismissed: [], unknown: true }],
  ]) {
    assert.doesNotThrow(() => validateSidecar(file, JSON.stringify(payload)));
  }
  for (const [file, payload] of [
    ['reconciliation.json', { schemaVersion: 1, enabled: false, months: {}, unknown: true }],
    ['phantom-seen.json', { schemaVersion: 1, seen: {}, unknown: true }],
  ]) {
    assert.throws(
      () => validateSidecar(file, JSON.stringify(payload)),
      /rejects unknown top-level field|dropped preserved/,
    );
  }
});

test('verify-backup accepts archives with embedded manifest and checksums', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-verify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'backups');
  fs.mkdirSync(path.join(dashboard, 'receipts'), { recursive: true });
  fs.writeFileSync(path.join(dashboard, 'goals.json'), '[]\n');
  fs.writeFileSync(
    path.join(dashboard, 'receipts.json'),
    '{"schemaVersion":1,"byTxn":{"txn":[{"id":"r1","txnId":"txn","file":"one.jpg"}]}}\n',
  );
  fs.writeFileSync(path.join(dashboard, 'reimb-links.json'), '{"links":[]}\n');
  fs.writeFileSync(
    path.join(dashboard, 'reimb-suggest.json'),
    '{"confirmed":{},"dismissed":[]}\n',
  );
  fs.writeFileSync(path.join(dashboard, 'reconciliation.json'), '{"enabled":false,"months":{}}\n');
  fs.writeFileSync(path.join(dashboard, 'phantom-seen.json'), '{"seen":{}}\n');
  fs.writeFileSync(path.join(dashboard, 'receipts', 'one.jpg'), 'image');

  const backupScript = path.resolve(__dirname, '..', 'bin', 'backup-dashboard-runtime.sh');
  const backup = spawnSync('bash', [backupScript], {
    env: {
      ...process.env,
      FINANCE_DASHBOARD_DIR: dashboard,
      DARKFINANCES_BACKUP_DIR: destination,
    },
    encoding: 'utf8',
  });
  assert.equal(backup.status, 0, backup.stderr);
  const archive = backup.stdout.trim();
  assert.equal(fs.existsSync(`${archive}.manifest.json`), true);

  const manifest = buildManifest({
    dashboardDir: dashboard,
    archivePath: archive,
    files: [
      'goals.json',
      'receipts.json',
      'reimb-links.json',
      'reimb-suggest.json',
      'reconciliation.json',
      'phantom-seen.json',
      'receipts',
    ],
  });
  assert.equal(manifest.kind, 'darkfinances-dashboard-runtime-backup');
  assert.match(manifest.recovery.postRestoreChecks.join(' '), /ping/);

  const verifyScript = path.resolve(__dirname, '..', 'bin', 'verify-backup.sh');
  const verify = spawnSync('bash', [verifyScript, archive], { encoding: 'utf8' });
  assert.equal(verify.status, 0, verify.stderr);
  verifyArchive({ archivePath: archive });
});

function mkLegacyArchive(root, dashboard, files) {
  const destination = path.join(root, 'backups');
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const archive = path.join(destination, 'legacy.tgz');
  const manifest = buildManifest({ dashboardDir: dashboard, archivePath: archive, files });
  fs.writeFileSync(path.join(dashboard, LEGACY_EMBEDDED_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  const tarArgs = ['-C', dashboard, '-czf', archive, ...files, LEGACY_EMBEDDED_MANIFEST];
  const packed = spawnSync('tar', tarArgs, { encoding: 'utf8', env: backupTarEnv() });
  assert.equal(packed.status, 0, packed.stderr);
  fs.writeFileSync(`${archive}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(`${archive}.sha256`, `${sha256File(archive)}  ${path.basename(archive)}\n`, { mode: 0o600 });
  fs.rmSync(path.join(dashboard, LEGACY_EMBEDDED_MANIFEST));
  return { archive, manifest };
}

function spawnSyncWithExtractGuard(fn) {
  const childProcess = require('child_process');
  const original = childProcess.spawnSync;
  let fullExtractCalls = 0;
  childProcess.spawnSync = (...args) => {
    const [command, argv = []] = args;
    if (command === 'tar' && Array.isArray(argv) && argv.includes('-xzf')) {
      fullExtractCalls += 1;
    }
    return original.apply(childProcess, args);
  };
  try {
    return { result: fn(), fullExtractCalls };
  } finally {
    childProcess.spawnSync = original;
  }
}

test('legacy verify rejects unsafe tar members before full extraction', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-legacy-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dashboard = path.join(root, 'dashboard');
  fs.mkdirSync(path.join(dashboard, 'receipts'), { recursive: true });
  fs.writeFileSync(path.join(dashboard, 'goals.json'), '[]\n');
  fs.writeFileSync(path.join(dashboard, 'receipts', 'one.jpg'), 'image');
  const { archive, manifest } = mkLegacyArchive(root, dashboard, ['goals.json', 'receipts']);

  const stage = path.join(root, 'hostile-stage');
  fs.mkdirSync(path.join(stage, 'receipts'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stage, 'goals.json'), '[]\n');
  fs.writeFileSync(path.join(stage, LEGACY_EMBEDDED_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.symlinkSync('/etc/passwd', path.join(stage, 'receipts', 'link.jpg'));
  const hostile = path.join(root, 'hostile.tgz');
  spawnSync('tar', ['-C', stage, '-czf', hostile, LEGACY_EMBEDDED_MANIFEST, 'goals.json', 'receipts'], { encoding: 'utf8' });
  fs.writeFileSync(`${hostile}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(`${hostile}.sha256`, `${sha256File(hostile)}  ${path.basename(hostile)}\n`, { mode: 0o600 });

  const { fullExtractCalls } = spawnSyncWithExtractGuard(() => assert.throws(
    () => verifyArchive({ archivePath: hostile }),
    /symbolic links are forbidden|unsupported archive entry type|verbose listing paths do not match/,
  ));
  assert.equal(fullExtractCalls, 0);
});

test('legacy verify rejects unexpected closed-world members before full extraction', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-legacy-closed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dashboard = path.join(root, 'dashboard');
  fs.mkdirSync(dashboard, { recursive: true });
  fs.writeFileSync(path.join(dashboard, 'goals.json'), '[]\n');
  const { archive, manifest } = mkLegacyArchive(root, dashboard, ['goals.json']);

  const stage = path.join(root, 'extra-stage');
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stage, 'goals.json'), '[]\n');
  fs.writeFileSync(path.join(stage, 'extra.json'), '{}\n');
  fs.writeFileSync(path.join(stage, LEGACY_EMBEDDED_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  const extra = path.join(root, 'extra.tgz');
  spawnSync('tar', ['-C', stage, '-czf', extra, LEGACY_EMBEDDED_MANIFEST, 'goals.json', 'extra.json'], { encoding: 'utf8' });
  fs.writeFileSync(`${extra}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(`${extra}.sha256`, `${sha256File(extra)}  ${path.basename(extra)}\n`, { mode: 0o600 });

  const { fullExtractCalls } = spawnSyncWithExtractGuard(() => assert.throws(
    () => verifyArchive({ archivePath: extra }),
    /unexpected archive member: extra.json/,
  ));
  assert.equal(fullExtractCalls, 0);
});

test('legacy verify rejects declared byte bound before full extraction', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-legacy-bounds-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dashboard = path.join(root, 'dashboard');
  fs.mkdirSync(dashboard, { recursive: true });
  fs.writeFileSync(path.join(dashboard, 'goals.json'), '[]\n');
  const { archive, manifest } = mkLegacyArchive(root, dashboard, ['goals.json']);
  const hugeManifest = {
    ...manifest,
    files: [
      ...manifest.files,
      {
        path: 'bomb.json',
        sha256: '0'.repeat(64),
        bytes: ARCHIVE_MAX_DECLARED_BYTES,
        mode: 0o600,
      },
    ],
  };
  fs.writeFileSync(`${archive}.manifest.json`, `${JSON.stringify(hugeManifest, null, 2)}\n`, { mode: 0o600 });

  const { fullExtractCalls } = spawnSyncWithExtractGuard(() => assert.throws(
    () => assertLegacyArchivePreflight(archive, hugeManifest),
    /declared bytes exceed bound/,
  ));
  assert.equal(fullExtractCalls, 0);
});

test('legacy verify rejects post-normalization member collisions before full extraction', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-legacy-collision-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dashboard = path.join(root, 'dashboard');
  fs.mkdirSync(dashboard, { recursive: true });
  fs.writeFileSync(path.join(dashboard, 'goals.json'), '[]\n');
  const { archive, manifest } = mkLegacyArchive(root, dashboard, ['goals.json']);

  const { fullExtractCalls } = spawnSyncWithExtractGuard(() => assert.throws(
    () => assertLegacyManifestMatchesArchive(
      manifest,
      [LEGACY_EMBEDDED_MANIFEST, 'goals.json', 'goals.json/'],
    ),
    /normalization collision/,
  ));
  assert.equal(fullExtractCalls, 0);
});

test('legacy verify rejects embedded manifest file hash drift before full extraction', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-legacy-embedded-drift-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dashboard = path.join(root, 'dashboard');
  fs.mkdirSync(dashboard, { recursive: true });
  fs.writeFileSync(path.join(dashboard, 'goals.json'), '[]\n');
  const { archive, manifest } = mkLegacyArchive(root, dashboard, ['goals.json']);

  const stage = path.join(root, 'drift-stage');
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stage, 'goals.json'), '[]\n');
  const driftedManifest = {
    ...manifest,
    files: manifest.files.map((entry) => (
      entry.path === 'goals.json'
        ? { ...entry, sha256: '0'.repeat(64) }
        : entry
    )),
  };
  fs.writeFileSync(path.join(stage, LEGACY_EMBEDDED_MANIFEST), `${JSON.stringify(driftedManifest, null, 2)}\n`);
  const drifted = path.join(root, 'drifted.tgz');
  spawnSync('tar', ['-C', stage, '-czf', drifted, LEGACY_EMBEDDED_MANIFEST, 'goals.json'], {
    encoding: 'utf8',
    env: backupTarEnv(),
  });
  fs.writeFileSync(`${drifted}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(`${drifted}.sha256`, `${sha256File(drifted)}  ${path.basename(drifted)}\n`, { mode: 0o600 });

  const { fullExtractCalls } = spawnSyncWithExtractGuard(() => assert.throws(
    () => verifyArchive({ archivePath: drifted }),
    /embedded manifest does not match sidecar manifest/,
  ));
  assert.equal(fullExtractCalls, 0);
});

test('backup tar creation paths set COPYFILE_DISABLE=1', () => {
  assert.equal(backupTarEnv().COPYFILE_DISABLE, COPYFILE_DISABLE_VALUE);
  const legacyScript = fs.readFileSync(path.resolve(__dirname, '..', 'bin', 'backup-dashboard-runtime.sh'), 'utf8');
  assert.match(legacyScript, /COPYFILE_DISABLE=1/);
  const bundleBuild = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'build-backup-bundle.js'), 'utf8');
  assert.match(bundleBuild, /backupTarEnv\(/);
  const runnersSource = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'ops-command-runners.js'), 'utf8');
  assert.match(runnersSource, /backupTarEnv\(/);
  const listingSource = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'backup-bundle-tar-listing.js'), 'utf8');
  assert.match(listingSource, /backupTarEnv\(/);
});
