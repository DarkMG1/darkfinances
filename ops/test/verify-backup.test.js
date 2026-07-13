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
} = require('../lib/backup-verify');

test('validateSidecar enforces owes-truth schema version', () => {
  assert.throws(
    () => validateSidecar('owes-truth.json', JSON.stringify({ schemaVersion: 1, manifest: {} })),
    /schemaVersion 2/
  );
  assert.doesNotThrow(() => validateSidecar('owes-truth.json', JSON.stringify({
    schemaVersion: 2,
    manifest: { complete: true },
  })));
});

test('validateReceiptReferences requires receipt files to exist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-receipts-'));
  fs.mkdirSync(path.join(root, 'receipts'));
  fs.writeFileSync(path.join(root, 'receipts', 'one.jpg'), 'image');
  assert.throws(
    () => validateReceiptReferences([{ path: 'receipts/missing.jpg' }], root),
    /missing receipt file/
  );
  assert.doesNotThrow(() => validateReceiptReferences([{ path: 'receipts/one.jpg' }], root));
});

test('verify-backup accepts archives with embedded manifest and checksums', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-verify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'backups');
  fs.mkdirSync(path.join(dashboard, 'receipts'), { recursive: true });
  fs.writeFileSync(path.join(dashboard, 'goals.json'), '[]\n');
  fs.writeFileSync(path.join(dashboard, 'receipts.json'), '[{"id":"r1","path":"receipts/one.jpg"}]\n');
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
    files: ['goals.json', 'receipts.json', 'receipts'],
  });
  assert.equal(manifest.kind, 'darkfinances-dashboard-runtime-backup');
  assert.match(manifest.recovery.postRestoreChecks.join(' '), /ping/);

  const verifyScript = path.resolve(__dirname, '..', 'bin', 'verify-backup.sh');
  const verify = spawnSync('bash', [verifyScript, archive], { encoding: 'utf8' });
  assert.equal(verify.status, 0, verify.stderr);
  verifyArchive({ archivePath: archive });
});
