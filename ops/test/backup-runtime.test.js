const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

test('runtime backup includes sidecars and receipts without secrets', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-backup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'backups');
  fs.mkdirSync(path.join(dashboard, 'receipts'), { recursive: true });
  fs.writeFileSync(path.join(dashboard, 'goals.json'), '[]\n');
  fs.writeFileSync(path.join(dashboard, 'receipts', 'one.jpg'), 'image');
  fs.writeFileSync(path.join(dashboard, '.env'), 'SECRET=must-not-back-up\n');

  const script = path.resolve(__dirname, '..', 'bin', 'backup-dashboard-runtime.sh');
  const result = spawnSync('bash', [script], {
    env: {
      ...process.env,
      FINANCE_DASHBOARD_DIR: dashboard,
      DARKFINANCES_BACKUP_DIR: destination,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const archive = result.stdout.trim();
  assert.equal(fs.existsSync(archive), true);
  assert.equal(fs.statSync(archive).mode & 0o777, 0o600);
  const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  assert.match(listing.stdout, /goals\.json/);
  assert.match(listing.stdout, /receipts\/one\.jpg/);
  assert.doesNotMatch(listing.stdout, /\.env/);
});
