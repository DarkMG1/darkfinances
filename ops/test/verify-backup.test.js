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

test('validateSidecar narrowly validates transaction deletion saga state', () => {
  assert.throws(
    () => validateSidecar(
      'transaction-deletion-sagas.json',
      JSON.stringify({ schemaVersion: 2, sagas: {} }),
    ),
    /schemaVersion 1/,
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

test('validateSidecar narrowly validates repayment confirmation saga state', () => {
  assert.throws(
    () => validateSidecar(
      'repayment-confirmation-sagas.json',
      JSON.stringify({ schemaVersion: 2, sagas: {} }),
    ),
    /schemaVersion 1/,
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
  assert.doesNotThrow(() => validateSidecar(
    'receipts.json',
    JSON.stringify({ schemaVersion: 1, byTxn: { txn: [] }, unknown: true }),
  ));
  assert.doesNotThrow(() => validateSidecar(
    'reimb-links.json',
    JSON.stringify({ schemaVersion: 1, links: [], unknown: true }),
  ));
  assert.doesNotThrow(() => validateSidecar(
    'reimb-suggest.json',
    JSON.stringify({ schemaVersion: 1, confirmed: {}, dismissed: [], unknown: true }),
  ));
  assert.doesNotThrow(() => validateSidecar(
    'reconciliation.json',
    JSON.stringify({ schemaVersion: 1, enabled: false, months: {}, unknown: true }),
  ));
  assert.doesNotThrow(() => validateSidecar(
    'phantom-seen.json',
    JSON.stringify({ schemaVersion: 1, seen: {}, unknown: true }),
  ));
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
