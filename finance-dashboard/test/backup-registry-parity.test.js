const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { STATE_REGISTRY, backupEntries } = require('../lib/state-registry');
const { SIDECAR_FILES } = require('../../ops/lib/backup-verify');

test('STATE_REGISTRY backup:true inventory matches backup-verify SIDECAR_FILES exactly', () => {
  const registryNames = Object.entries(STATE_REGISTRY)
    .filter(([, definition]) => definition.backup)
    .map(([name]) => name)
    .sort();
  const registryFiles = backupEntries().map((entry) => entry.filename).sort();
  const verifyFiles = [...SIDECAR_FILES].sort();

  assert.equal(registryNames.length, Object.keys(STATE_REGISTRY).length);
  assert.deepEqual(registryFiles, verifyFiles);
  assert.equal(registryFiles.length, SIDECAR_FILES.length);
});

test('backup-dashboard-runtime.sh includes every registry backup sidecar filename', () => {
  const scriptPath = path.resolve(__dirname, '../../ops/bin/backup-dashboard-runtime.sh');
  const script = fs.readFileSync(scriptPath, 'utf8');
  for (const { filename } of backupEntries()) {
    assert.match(
      script,
      new RegExp(`\\b${filename.replace('.', '\\.')}\\b`),
      `${filename} missing from backup-dashboard-runtime.sh`,
    );
  }
});
