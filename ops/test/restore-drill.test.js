const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

test('restore drill previews archive, restores into a staging dir, and re-verifies', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-restore-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dashboard = path.join(root, 'dashboard');
  const staging = path.join(root, 'staging');
  const destination = path.join(root, 'backups');
  fs.mkdirSync(path.join(dashboard, 'receipts'), { recursive: true });
  fs.writeFileSync(path.join(dashboard, 'rules.json'), '[]\n');
  fs.writeFileSync(path.join(dashboard, 'receipts.json'), '[]\n');

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

  const dryRun = spawnSync('bash', [
    path.resolve(__dirname, '..', 'bin', 'restore-dashboard-runtime.sh'),
    archive,
  ], {
    env: { ...process.env, FINANCE_DASHBOARD_DIR: staging },
    encoding: 'utf8',
  });
  assert.equal(dryRun.status, 2);
  assert.match(dryRun.stderr, /Dry run only/);
  assert.match(dryRun.stderr, /rules\.json/);

  fs.mkdirSync(staging, { recursive: true });
  const restore = spawnSync('bash', [
    path.resolve(__dirname, '..', 'bin', 'restore-dashboard-runtime.sh'),
    archive,
  ], {
    env: {
      ...process.env,
      CONFIRM: '1',
      FINANCE_DASHBOARD_DIR: staging,
    },
    encoding: 'utf8',
  });
  assert.equal(restore.status, 0, restore.stderr);
  assert.equal(fs.existsSync(path.join(staging, 'rules.json')), true);

  const verify = spawnSync('bash', [
    path.resolve(__dirname, '..', 'bin', 'verify-backup.sh'),
    archive,
  ], {
    env: { ...process.env, FINANCE_DASHBOARD_DIR: staging },
    encoding: 'utf8',
  });
  assert.equal(verify.status, 0, verify.stderr);
});
